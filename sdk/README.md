# @toolwarden/sdk

Approvals and tamper-evident receipts for any agent, no MCP gateway
required. Zero dependencies, WebCrypto only: Node 20+, Workers, Deno,
Bun.

```ts
import { ToolWarden } from '@toolwarden/sdk'

const tw = new ToolWarden({
  url: 'https://cloud.example',
  token: process.env.TOOLWARDEN_TOKEN!,
  gateway: 'checkout-bot',
})

// Hold a risky action until a human (or a standing grant) says yes.
// Denied, expired, timed out, unreachable: all of those are "no".
const ok = await tw.approve({
  principal: 'agent-7',
  tool: 'payments:refund',
  reason: 'refund order #4153, customer request',
})

// File a hash-chained receipt; the cloud countersigns the chain head.
await tw.fileReceipt({
  principal: 'agent-7',
  server: 'payments',
  tool: 'refund',
  decision: ok ? 'ask_approved' : 'ask_denied',
  reason: ok ? 'approved via inbox' : 'not approved',
  status: ok ? 'success' : 'blocked',
  input: { order: 4153 },
})
```

The full wire protocol, including curl examples, is documented in
[docs/http-api.md](../docs/http-api.md). Receipts use the same chain
rule as the gateway (sha256 over the receipt JSON minus its hash
field), so the offline verifier checks SDK-filed trails identically.
