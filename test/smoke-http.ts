// HTTP serve mode smoke test: one shared gateway, two principals with
// different budgets, proving auth, budget isolation, and attribution.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const root = resolve(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'toolwarden-http-'))
const PORT = 8499

const config = `
policy:
  budget:
    monthly: 5.00
    currency: USD
  limits:
    max_per_call: 0.05
  default: allow
storage:
  dir: ${work}/.toolwarden
serve:
  port: ${PORT}
  host: 127.0.0.1
  principals:
    - name: alice
      token: tw_alice_test_token
      monthly_budget: 0.02
    - name: bot
      token: tw_bot_test_token
servers:
  - name: demo
    command: ${process.execPath}
    args:
      - ${root}/node_modules/tsx/dist/cli.mjs
      - ${root}/examples/demo-server.ts
    prices:
      render_screenshot: 0.01
      "*": 0.0
`
const configPath = join(work, 'toolwarden.yaml')
writeFileSync(configPath, config)

const gateway = spawn(
  process.execPath,
  [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'src/cli.ts'), 'serve', '--config', configPath],
  { stdio: ['ignore', 'ignore', 'pipe'] },
)
const ready = new Promise<void>((res, rej) => {
  gateway.stderr.on('data', (chunk: Buffer) => {
    if (chunk.toString().includes('serving MCP')) res()
  })
  gateway.on('exit', (code) => rej(new Error(`gateway exited early: ${code}`)))
  setTimeout(() => rej(new Error('gateway start timeout')), 20000)
})
await ready

let failures = 0
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

function connect(token: string): { client: Client; transport: StreamableHTTPClientTransport } {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  return { client: new Client({ name: 'http-smoke', version: '0.0.0' }), transport }
}

// Unknown token must be rejected.
const bad = connect('tw_wrong_token')
let unauthorized = false
try {
  await bad.client.connect(bad.transport)
} catch {
  unauthorized = true
}
check('unknown bearer token is rejected', unauthorized)

// Alice has a tight per-principal budget: two screenshots fit, the third does not.
const alice = connect('tw_alice_test_token')
await alice.client.connect(alice.transport)
const a1 = await alice.client.callTool({ name: 'render_screenshot', arguments: { url: 'https://a.example' } })
const a2 = await alice.client.callTool({ name: 'render_screenshot', arguments: { url: 'https://b.example' } })
check('alice can spend inside her budget', !a1.isError && !a2.isError)

const a3 = await alice.client.callTool({ name: 'render_screenshot', arguments: { url: 'https://c.example' } })
const a3text = JSON.stringify(a3.content)
check(
  'alice is blocked at her principal budget',
  a3.isError === true && a3text.includes('alice') && a3text.includes('exhausted'),
)

// Bot has no principal budget and stays bound by the global one only.
const bot = connect('tw_bot_test_token')
await bot.client.connect(bot.transport)
const b1 = await bot.client.callTool({ name: 'render_screenshot', arguments: { url: 'https://d.example' } })
check('bot still spends after alice is exhausted', !b1.isError)

const statusTool = await bot.client.callTool({ name: 'toolwarden_status', arguments: {} })
const statusJson = JSON.parse((statusTool.content as Array<{ text: string }>)[0].text)
check(
  'status reports per-principal spend',
  statusJson.principal === 'bot' && statusJson.principal_spent_this_month === 0.01,
  `principal=${statusJson.principal} spent=${statusJson.principal_spent_this_month}`,
)
check('global spend aggregates both principals', statusJson.spent_this_month === 0.03)

const receipts = readFileSync(join(work, '.toolwarden', 'receipts.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
const alicePrincipals = receipts.filter((r) => r.principal === 'alice')
const botPrincipals = receipts.filter((r) => r.principal === 'bot')
check(
  'receipts attribute calls to principals',
  alicePrincipals.length === 3 && botPrincipals.length >= 1,
  `alice=${alicePrincipals.length} bot=${botPrincipals.length}`,
)
const blockedAlice = alicePrincipals.filter((r) => r.status === 'blocked')
check('alice budget denial is receipted', blockedAlice.length === 1)

await alice.client.close()
await bot.client.close()
gateway.kill('SIGTERM')

console.log(failures === 0 ? '\nHTTP smoke test passed.' : `\n${failures} HTTP smoke check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
