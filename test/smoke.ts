// End-to-end smoke test: spawn the gateway over stdio as a real MCP client,
// exercise allow / deny / ask / budget paths, then verify receipts landed.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = resolve(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'toolmeter-smoke-'))

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
  dir: ${work}/.toolmeter
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
const configPath = join(work, 'toolmeter.yaml')
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
  names.includes('toolmeter_status') && names.includes('echo') && names.includes('dataset_export'),
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
  arguments: { url: 'https://toolmeter.ai' },
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

const status = await client.callTool({ name: 'toolmeter_status', arguments: {} })
const statusJson = JSON.parse((status.content as Array<{ text: string }>)[0].text)
check(
  'status tool reports spend of exactly one screenshot',
  statusJson.spent_this_month === 0.01 && statusJson.budget_monthly === 5,
  `spent=${statusJson.spent_this_month}`,
)

const receipts = readFileSync(join(work, '.toolmeter', 'receipts.jsonl'), 'utf8')
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
console.log(failures === 0 ? '\nSmoke test passed.' : `\n${failures} smoke check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
