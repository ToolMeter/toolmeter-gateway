# HTTP API: governance for agents that do not speak MCP

The gateway is one client of ToolWarden Cloud, not the only one. The
same HTTP surface lets any agent (a LangGraph app, a custom loop, a CI
script) request human approvals, file tamper-evident receipts, and read
policy and spend, without running the MCP gateway at all.

`@toolwarden/sdk` (in `sdk/` of this repo) wraps exactly this surface
for TypeScript. Everything below also works with plain `fetch` or curl.

## Authentication

Bearer tokens, two kinds:

- `twgw_…` per-gateway token (recommended): pinned to one gateway
  identity, scoped to the endpoints below, cannot open the dashboard.
- `tworg_…` org token: works for all gateways; keep it for dashboard
  and automation use.

```
Authorization: Bearer twgw_...
```

## Approvals

### `POST /v1/approvals`: ask a human

```bash
curl -s https://cloud.example/v1/approvals \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{
    "gateway": "checkout-bot",
    "principal": "agent-7",
    "tool": "payments:refund",
    "est_cost": 0.0,
    "reason": "refund order #4153, customer request"
  }'
```

Response, three shapes:

```jsonc
{ "id": "…", "status": "pending", "expires_at": "…" }   // a human will decide
{ "id": "…", "status": "approved", "granted_by": "…" }  // a standing grant decided instantly
{ "id": "…", "status": "denied" }
```

If a Slack webhook is configured for the org, the request posts there
with signed one-tap links. Requests expire server-side after 15 minutes.

### `GET /v1/approvals/:id`: poll the decision

```jsonc
{ "id": "…", "status": "pending" | "approved" | "denied" | "expired" }
```

Poll every second or two until it leaves `pending`. Treat everything
except `approved` as a no, including your own timeout: unanswered
questions must fail toward denial.

## Receipts

### `POST /v1/ingest`: file receipts

Receipts are hash-chained per gateway. Each receipt embeds `prev` (the
hash of its predecessor, or `sha256:genesis` for the first) and `hash`
(sha256 over the receipt JSON minus the `hash` field, key order
preserved). The cloud verifies the chain continues its stored head,
appends, and returns an Ed25519 countersignature over the new head.

```bash
curl -s https://cloud.example/v1/ingest \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{ "gateway": "checkout-bot", "receipts": [ { ...receipt... } ] }'
```

Receipt fields (all required; see `src/receipts.ts`):

```jsonc
{
  "receipt_id": "rcpt_x7f3…",          // unique id
  "ts": "2026-06-12T19:02:11.000Z",
  "principal": "agent-7",
  "server": "payments",                 // with tool, forms the key payments:refund
  "tool": "refund",
  "decision": "ask_approved",           // allow | deny | ask_approved | ask_denied
  "reason": "approved via inbox",
  "est_cost": 0,
  "currency": "USD",
  "status": "success",                  // success | error | blocked
  "latency_ms": 412,                    // null if not executed
  "input_hash": "sha256:…",             // hash of the call arguments
  "output_hash": "sha256:…",            // null if not executed
  "spent_month_after": 1.23,
  "budget_monthly": 25,
  "prev": "sha256:…",
  "hash": "sha256:…"
}
```

Success returns `{ ok, accepted, chain_head, countersignature,
countersigned_at }`. A `409` means your batch does not continue the
stored head; the body carries `expected_head` so you can resync (send
everything after that hash). Limits: 500 receipts or 2 MB per batch,
120 requests/minute per org.

### `GET /v1/attestations/:gateway`

The stored chain head, its countersignature, timestamp, and the cloud's
public key: everything needed to verify the trail independently.

## Policy and spend

- `GET /v1/policy[?gateway=name]`: the org's current signed policy
  (YAML + Ed25519 signature + version). Send `If-None-Match` with the
  returned ETag; unchanged policy costs a 304.
- `GET /v1/spend?month=YYYY-MM[&exclude_gateway=name]`: settled spend
  for the month, for budget decisions that span a fleet.
- `GET /v1/public-key`: the countersigning public key (PEM). Pin it.

## TypeScript example

```ts
import { ToolWarden } from '@toolwarden/sdk'

const tw = new ToolWarden({
  url: 'https://cloud.example',
  token: process.env.TOOLWARDEN_TOKEN!,
  gateway: 'checkout-bot',
})

// Hold a risky action until a human says yes.
const ok = await tw.approve({
  principal: 'agent-7',
  tool: 'payments:refund',
  reason: 'refund order #4153, customer request',
  timeoutMs: 120_000,
})
if (!ok) throw new Error('refund was not approved')

// File the receipt; the chain state persists in ~/.toolwarden-sdk.
await tw.fileReceipt({
  principal: 'agent-7',
  server: 'payments',
  tool: 'refund',
  decision: 'ask_approved',
  reason: 'approved via inbox',
  status: 'success',
  input: { order: 4153 },
  output: { refunded: true },
  latencyMs: 412,
})
```
