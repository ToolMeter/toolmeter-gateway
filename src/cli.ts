#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from './config.js'
import { Gateway } from './gateway.js'

function usage(): never {
  console.error('Usage: toolmeter-gateway --config <toolmeter.yaml>')
  process.exit(1)
}

async function main() {
  const idx = process.argv.indexOf('--config')
  const configPath = idx >= 0 ? process.argv[idx + 1] : undefined
  if (!configPath) usage()

  const config = loadConfig(configPath)
  const gateway = new Gateway(config)
  await gateway.connectUpstreams()

  const transport = new StdioServerTransport()
  await gateway.server.connect(transport)
  // stderr only: stdout belongs to the MCP protocol
  console.error(
    `toolmeter-gateway: proxying ${config.servers.length} server(s), ` +
      `budget $${config.policy.budget.monthly} ${config.policy.budget.currency}/month, ` +
      `receipts in ${config.storage.dir}`,
  )

  const shutdown = async () => {
    await gateway.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('toolmeter-gateway failed to start:', err)
  process.exit(1)
})
