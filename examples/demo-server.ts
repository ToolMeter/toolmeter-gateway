// A small MCP server with tools that pretend to cost money.
// Used by the README demo and the smoke test.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'demo-tools', version: '0.1.0' })

server.tool(
  'echo',
  'Echo a message back. Free.',
  { message: z.string() },
  async ({ message }) => ({
    content: [{ type: 'text', text: `echo: ${message}` }],
  }),
)

server.tool(
  'render_screenshot',
  'Pretend to render a screenshot of a URL. Cheap paid tool.',
  { url: z.string(), viewport: z.string().optional() },
  async ({ url, viewport }) => ({
    content: [
      {
        type: 'text',
        text: `screenshot of ${url} at ${viewport ?? 'desktop'}: [1280x800 PNG would be here]`,
      },
    ],
  }),
)

server.tool(
  'market_snapshot',
  'Pretend to fetch a market data snapshot. Expensive paid tool.',
  { symbol: z.string() },
  async ({ symbol }) => ({
    content: [{ type: 'text', text: `snapshot for ${symbol}: { price: 42.0, volume: 1337 }` }],
  }),
)

server.tool(
  'dataset_export',
  'Pretend to export a full dataset. Should be denied by policy.',
  { dataset: z.string() },
  async ({ dataset }) => ({
    content: [{ type: 'text', text: `full export of ${dataset}` }],
  }),
)

server.tool(
  'crash_server',
  'Kill this server process immediately (used by the resilience smoke test).',
  {},
  async () => {
    setTimeout(() => process.exit(1), 50)
    return { content: [{ type: 'text', text: 'crashing' }] }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
