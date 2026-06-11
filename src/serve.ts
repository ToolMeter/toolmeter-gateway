import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Config } from './config.js'
import { GatewayCore, createSessionServer } from './gateway.js'

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function deny(res: ServerResponse, code: number, message: string): void {
  res.writeHead(code, { 'content-type': 'application/json' }).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null,
    }),
  )
}

export async function serve(core: GatewayCore, config: Config): Promise<() => Promise<void>> {
  const { host, port, principals } = config.serve
  if (principals.length === 0) {
    throw new Error(
      'serve mode requires at least one principal in serve.principals. ' +
        'Refusing to expose an unauthenticated gateway.',
    )
  }

  // sessionId -> transport. Each session is bound to the principal that
  // authenticated its initialize request; later requests must present the
  // same token.
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; token: string }>()

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      if (url.pathname !== '/mcp') {
        deny(res, 404, 'not found, MCP endpoint is /mcp')
        return
      }

      const auth = req.headers.authorization ?? ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      const principal = core.findPrincipal(token)
      if (!principal) {
        deny(res, 401, 'missing or unknown bearer token')
        return
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (sessionId) {
        const session = sessions.get(sessionId)
        if (!session) {
          deny(res, 404, 'unknown session')
          return
        }
        if (session.token !== token) {
          deny(res, 403, 'session belongs to a different principal')
          return
        }
        await session.transport.handleRequest(req, res, await readBody(req))
        return
      }

      // No session header: this must be an initialize POST.
      if (req.method !== 'POST') {
        deny(res, 400, 'expected initialize POST or mcp-session-id header')
        return
      }
      const body = await readBody(req)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, token })
        },
      })
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId)
      }
      const server = createSessionServer(core, principal)
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (err) {
      console.error('serve: request failed:', err)
      if (!res.headersSent) deny(res, 500, 'internal error')
    }
  })

  await new Promise<void>((resolveStarted) => httpServer.listen(port, host, resolveStarted))
  console.error(
    `toolwarden-gateway: serving MCP at http://${host}:${port}/mcp ` +
      `for ${principals.length} principal(s)`,
  )

  return async () => {
    for (const { transport } of sessions.values()) await transport.close()
    await new Promise<void>((resolveClosed) => httpServer.close(() => resolveClosed()))
  }
}
