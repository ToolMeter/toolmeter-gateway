// End-to-end smoke test: spawn the gateway over stdio as a real MCP client,
// exercise allow / deny / ask / budget paths, then verify receipts landed.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const root = resolve(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'toolwarden-smoke-'))

const config = `
policy:
  budget:
    monthly: 5.00
    currency: USD
  limits:
    max_per_call: 0.05
    ask_above: 0.02
  rules:
    - match: "demo:dataset_export"
      action: deny
      reason: training use forbidden
  default: allow
storage:
  dir: ${work}/.toolwarden
servers:
  - name: demo
    command: ${process.execPath}
    args:
      - ${root}/node_modules/tsx/dist/cli.mjs
      - ${root}/examples/demo-server.ts
    prices:
      render_screenshot: 0.01
      market_snapshot: 0.03
      "*": 0.0
`
const configPath = join(work, 'toolwarden.yaml')
writeFileSync(configPath, config)

const client = new Client({ name: 'smoke-test', version: '0.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'src/cli.ts'), '--config', configPath],
})
await client.connect(transport)

let failures = 0
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

const { tools } = await client.listTools()
const names = tools.map((t) => t.name).sort()
check(
  'tools exposed including status tool',
  names.includes('toolwarden_status') && names.includes('echo') && names.includes('dataset_export'),
  names.join(', '),
)

const priced = tools.find((t) => t.name === 'render_screenshot')
check(
  'price annotation appears in tool description',
  priced?.description?.includes('$0.01') ?? false,
)

const echo = await client.callTool({ name: 'echo', arguments: { message: 'hi' } })
check('free tool call succeeds', !echo.isError)

const shot = await client.callTool({
  name: 'render_screenshot',
  arguments: { url: 'https://toolwarden.ai' },
})
check('cheap paid call is allowed', !shot.isError)

const denied = await client.callTool({
  name: 'dataset_export',
  arguments: { dataset: 'everything' },
})
const deniedText = JSON.stringify(denied.content)
check(
  'deny rule blocks the call with reason',
  denied.isError === true && deniedText.includes('training use forbidden'),
)

// market_snapshot costs 0.03, at or above ask_above 0.02. This client has no
// elicitation capability, so the gateway must fall back to deny.
const ask = await client.callTool({ name: 'market_snapshot', arguments: { symbol: 'TM' } })
const askText = JSON.stringify(ask.content)
check(
  'ask without elicitation support falls back to deny',
  ask.isError === true && askText.includes('approval'),
)

const status = await client.callTool({ name: 'toolwarden_status', arguments: {} })
const statusJson = JSON.parse((status.content as Array<{ text: string }>)[0].text)
check(
  'status tool reports spend of exactly one screenshot',
  statusJson.spent_this_month === 0.01 && statusJson.budget_monthly === 5,
  `spent=${statusJson.spent_this_month}`,
)

const receipts = readFileSync(join(work, '.toolwarden', 'receipts.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
check('four receipts written (echo is free but still logged)', receipts.length === 4, `${receipts.length}`)
check(
  'receipt fields are complete',
  receipts.every(
    (r) =>
      r.receipt_id?.startsWith('rcpt_') &&
      r.input_hash?.startsWith('sha256:') &&
      typeof r.spent_month_after === 'number',
  ),
)
const blocked = receipts.filter((r) => r.status === 'blocked')
check('two blocked receipts (deny rule + unapproved ask)', blocked.length === 2, `${blocked.length}`)

await client.close()

// Second session: a client that supports elicitation and auto-approves.
// Also proves the receipt chain resumes across gateway restarts.
const approver = new Client(
  { name: 'smoke-approver', version: '0.0.0' },
  { capabilities: { elicitation: {} } },
)
approver.setRequestHandler(ElicitRequestSchema, async (req) => {
  const msg = req.params.message
  return msg.includes('market_snapshot')
    ? { action: 'accept' as const, content: { approve: true } }
    : { action: 'decline' as const }
})
const approverTransport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'src/cli.ts'), '--config', configPath],
})
await approver.connect(approverTransport)

const approved = await approver.callTool({ name: 'market_snapshot', arguments: { symbol: 'TM' } })
check('ask with elicitation approval goes through', !approved.isError)

const status2 = await approver.callTool({ name: 'toolwarden_status', arguments: {} })
const statusJson2 = JSON.parse((status2.content as Array<{ text: string }>)[0].text)
check(
  'spend now includes the approved snapshot',
  statusJson2.spent_this_month === 0.04,
  `spent=${statusJson2.spent_this_month}`,
)
await approver.close()

const receipts2 = readFileSync(join(work, '.toolwarden', 'receipts.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
const approvedReceipt = receipts2[receipts2.length - 1]
check(
  'approved call logged as ask_approved success',
  approvedReceipt.decision === 'ask_approved' && approvedReceipt.status === 'success',
)

// CLI: verify must pass on the intact chain, then fail once tampered.
const tsxBin = join(root, 'node_modules/tsx/dist/cli.mjs')
const cliPath = join(root, 'src/cli.ts')
const dir = join(work, '.toolwarden')
const verifyOut = execFileSync(process.execPath, [tsxBin, cliPath, 'verify', '--dir', dir], {
  encoding: 'utf8',
})
check('cli verify reports intact chain', verifyOut.includes('chain intact'), verifyOut.trim())

const summaryOut = execFileSync(
  process.execPath,
  [tsxBin, cliPath, 'receipts', '--dir', dir],
  { encoding: 'utf8' },
)
check(
  'cli receipts summarizes spend by tool',
  summaryOut.includes('spent:') && summaryOut.includes('demo:market_snapshot'),
)

const receiptFile = join(dir, 'receipts.jsonl')
const lines = readFileSync(receiptFile, 'utf8').trim().split('\n')
const tampered = JSON.parse(lines[1])
tampered.est_cost = 0
lines[1] = JSON.stringify(tampered)
writeFileSync(receiptFile, lines.join('\n') + '\n')
let tamperCaught = false
try {
  execFileSync(process.execPath, [tsxBin, cliPath, 'verify', '--dir', dir], { encoding: 'utf8' })
} catch (err) {
  tamperCaught = (err as { status?: number }).status === 2
}
check('cli verify exits 2 on tampered log', tamperCaught)

// Resilience: crash the upstream, then verify the gateway reconnects and
// the next call succeeds without restarting the gateway.
const crashClient = new Client({ name: 'smoke-crash', version: '0.0.0' })
const crashTransport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'src/cli.ts'), '--config', configPath],
})
await crashClient.connect(crashTransport)
await crashClient.callTool({ name: 'crash_server', arguments: {} }).catch(() => null)
await new Promise((r) => setTimeout(r, 3500)) // allow reconnect backoff
const afterCrash = await crashClient.callTool({ name: 'echo', arguments: { message: 'back' } })
check('gateway recovers after upstream crash', !afterCrash.isError)
await crashClient.close()

console.log(failures === 0 ? '\nSmoke test passed.' : `\n${failures} smoke check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
