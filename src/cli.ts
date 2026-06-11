#!/usr/bin/env node
import { join } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { expandHome, loadConfig } from './config.js'
import { GatewayCore, createSessionServer, LOCAL_PRINCIPAL } from './gateway.js'
import { readReceipts, verifyChain, type Receipt } from './receipts.js'
import { buildReport } from './report.js'
import { runInit } from './init.js'
import { serve } from './serve.js'
import { readFileSync, existsSync, writeFileSync, watch } from 'node:fs'

function usage(): never {
  console.error(`Usage:
  toolwarden-gateway --config <toolwarden.yaml>          run the gateway (default command)
  toolwarden-gateway serve --config <toolwarden.yaml>    shared HTTP gateway with bearer auth
  toolwarden-gateway init [--from <mcp.json>] [--out <toolwarden.yaml>]
                                                       wrap an existing MCP config
  toolwarden-gateway receipts [--dir <dir>] [--month YYYY-MM] [--limit N]
                                                       spend summary and recent receipts
  toolwarden-gateway report [--dir <dir>] [--month YYYY-MM] [--out <report.html>]
                                                       self-contained HTML audit report
  toolwarden-gateway verify [--dir <dir>]               verify receipt chain integrity`)
  process.exit(1)
}

/** Re-read policy and prices when the config file changes, without restart. */
function watchPolicy(configPath: string, core: import('./gateway.js').GatewayCore): void {
  let timer: NodeJS.Timeout | undefined
  try {
    watch(configPath, () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        try {
          core.applyConfig(loadConfig(configPath))
          console.error(`toolwarden-gateway: reloaded policy from ${configPath}`)
        } catch (err) {
          console.error(
            `toolwarden-gateway: config reload failed, keeping previous policy: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }, 300)
    })
  } catch {
    // Watching is best-effort; a restart always picks up changes.
  }
}

function flag(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`)
  return idx >= 0 ? process.argv[idx + 1] : fallback
}

async function runGateway() {
  const configPath = flag('config')
  if (!configPath) usage()

  const config = loadConfig(configPath)
  const core = new GatewayCore(config)
  await core.connectUpstreams()
  watchPolicy(configPath, core)

  const server = createSessionServer(core, LOCAL_PRINCIPAL)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // stderr only: stdout belongs to the MCP protocol
  console.error(
    `toolwarden-gateway: proxying ${config.servers.length} server(s), ` +
      `budget $${config.policy.budget.monthly} ${config.policy.budget.currency}/month, ` +
      `receipts in ${config.storage.dir}`,
  )

  const shutdown = async () => {
    await core.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function runServe() {
  const configPath = flag('config')
  if (!configPath) usage()

  const config = loadConfig(configPath)
  const core = new GatewayCore(config)
  await core.connectUpstreams()
  watchPolicy(configPath, core)

  const stop = await serve(core, config)
  const shutdown = async () => {
    await stop()
    await core.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function receiptsFile(): string {
  const dir = expandHome(flag('dir', '~/.toolwarden')!)
  return join(dir, 'receipts.jsonl')
}

function runReceipts() {
  const file = receiptsFile()
  const month = flag('month', new Date().toISOString().slice(0, 7))!
  const limit = Number(flag('limit', '10'))
  const all = readReceipts(file)
  const inMonth = all.filter((r) => r.ts.startsWith(month))

  if (inMonth.length === 0) {
    console.log(`No receipts for ${month} in ${file}`)
    return
  }

  const spent = inMonth
    .filter((r) => r.status === 'success')
    .reduce((sum, r) => sum + r.est_cost, 0)
  const blocked = inMonth.filter((r) => r.status === 'blocked')
  const currency = inMonth[0].currency

  console.log(`Receipts for ${month}  (${file})`)
  console.log(`  calls:    ${inMonth.length}`)
  console.log(`  spent:    $${spent.toFixed(4)} ${currency}`)
  console.log(`  blocked:  ${blocked.length}`)

  const byTool = new Map<string, { calls: number; spent: number; blocked: number }>()
  for (const r of inMonth) {
    const key = `${r.server}:${r.tool}`
    const row = byTool.get(key) ?? { calls: 0, spent: 0, blocked: 0 }
    row.calls++
    if (r.status === 'success') row.spent += r.est_cost
    if (r.status === 'blocked') row.blocked++
    byTool.set(key, row)
  }
  console.log('\nBy tool:')
  const rows = [...byTool.entries()].sort((a, b) => b[1].spent - a[1].spent)
  for (const [key, row] of rows) {
    console.log(
      `  ${key.padEnd(36)} ${String(row.calls).padStart(5)} calls   $${row.spent
        .toFixed(4)
        .padStart(9)}   ${row.blocked ? `${row.blocked} blocked` : ''}`,
    )
  }

  console.log(`\nLast ${Math.min(limit, inMonth.length)}:`)
  for (const r of inMonth.slice(-limit)) {
    const who = r.principal && r.principal !== 'local' ? ` ${r.principal.padEnd(10)}` : ''
    console.log(
      `  ${r.ts}  ${r.receipt_id} ${who} ${(r.server + ':' + r.tool).padEnd(30)} ${r.decision.padEnd(12)} ${
        r.status.padEnd(8)
      } $${r.est_cost}`,
    )
  }
}

function runVerify() {
  const file = receiptsFile()
  if (!existsSync(file)) {
    console.log(`No receipts file at ${file}`)
    return
  }
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
  const result = verifyChain(lines)
  if (result.ok) {
    console.log(`OK: ${result.count} receipts, chain intact.`)
  } else {
    console.error(`TAMPERED: chain broken at line ${result.brokenAt} of ${result.count}: ${result.error}`)
    process.exit(2)
  }
}

function runReport() {
  const file = receiptsFile()
  const month = flag('month', new Date().toISOString().slice(0, 7))!
  const out = flag('out', 'toolwarden-report.html')!
  const html = buildReport(file, month)
  writeFileSync(out, html)
  console.log(`Wrote ${out} for ${month}`)
}

const command = process.argv[2]
if (command === 'receipts') {
  runReceipts()
} else if (command === 'verify') {
  runVerify()
} else if (command === 'report') {
  runReport()
} else if (command === 'init') {
  runInit(flag('from'), flag('out', 'toolwarden.yaml')!)
} else if (command === 'serve') {
  runServe().catch((err) => {
    console.error('toolwarden-gateway serve failed to start:', err)
    process.exit(1)
  })
} else if (command === 'run' || command?.startsWith('--')) {
  runGateway().catch((err) => {
    console.error('toolwarden-gateway failed to start:', err)
    process.exit(1)
  })
} else {
  usage()
}
