# ToolWarden Gateway

A policy-enforcing MCP gateway. Put it between any MCP client and your MCP servers, write a `policy.yaml`, and every tool call gets checked against budgets, per-call ceilings, and allow/ask/deny rules. Every decision produces a receipt.

Payments for AI tools are getting solved by open protocols (x402, Stripe MPP, AP2). What those protocols don't answer: should this agent be allowed to make this call, under whose budget, and how do you audit what happened? That's what this gateway does.

```text
MCP client (Claude Code, Claude Desktop, any MCP host)
        |
  toolwarden-gateway     <- policy.yaml: budgets, limits, rules
        |                  receipts.jsonl: one line per decision
  your MCP servers      <- unchanged
```

## Quick start

```bash
git clone https://github.com/toolwarden/toolwarden-gateway
cd toolwarden-gateway && pnpm install
```

Already have MCP servers configured? Wrap them all in one command:

```bash
toolwarden-gateway init        # reads .mcp.json or the Claude Desktop config
```

It generates a `toolwarden.yaml` around your existing servers with a starter policy and prints the client config to swap in.

Or create `toolwarden.yaml` by hand:

```yaml
policy:
  budget:
    monthly: 5.00        # USD; 0 disables budget enforcement
    currency: USD
  limits:
    max_per_call: 0.05   # hard ceiling, denies anything above
    ask_above: 0.02      # calls at or above this require approval
  rules:                 # first match wins, matched against server:tool
    - match: "demo:dataset_export"
      action: deny
      reason: training use forbidden in this workspace
    - match: "demo:echo"
      action: allow      # explicit allow is pre-approval, skips ask_above
    - match: "search:*"
      action: allow
      monthly_budget: 2.00      # scoped budget for just these tools
      max_calls_per_hour: 100   # stops looping agents, even on free tools
  default: allow

storage:
  dir: ~/.toolwarden      # receipts.jsonl and state.json live here

servers:
  - name: demo
    command: npx
    args: [tsx, ./examples/demo-server.ts]
    prices:              # cost estimates per tool call, USD
      render_screenshot: 0.01
      market_snapshot: 0.03
      "*": 0.0
```

Add the gateway to your MCP client. For Claude Code:

```json
{
  "mcpServers": {
    "toolwarden": {
      "command": "npx",
      "args": ["tsx", "src/cli.ts", "--config", "toolwarden.yaml"]
    }
  }
}
```

The agent now sees your servers' tools (with price annotations in the descriptions), plus a built-in `toolwarden_status` tool it can call to check its own remaining budget.

## What the agent experiences

- A call under the limits goes straight through.
- A call matching a deny rule comes back as an error with the policy reason and a receipt id.
- A call at or above `ask_above` triggers an approval prompt in clients that support MCP elicitation. Clients without elicitation get a clean deny that explains why.
- A failed upstream call is never charged against the budget.

## Governance works before payments exist

Policy is useful on entirely free tools. `examples/govern-free-tools.yaml` wraps the official filesystem MCP server so reads pass, writes require approval, destructive operations are denied, and everything is logged. No prices involved.

```yaml
rules:
  - match: "fs:read_*"
    action: allow
  - match: "fs:write_file"
    action: ask
    reason: writes need human approval in this workspace
  - match: "fs:move_file"
    action: deny
    reason: destructive operations are disabled
default: deny
```

## Receipts

Every decision appends one line to `receipts.jsonl`. Receipts are hash-chained: each entry carries the hash of the previous one and its own content hash, so any edit, deletion, or reordering of the log is detectable.

```json
{
  "receipt_id": "rcpt_3f9a1c2b4d5e",
  "ts": "2026-06-11T14:02:11.000Z",
  "server": "demo",
  "tool": "render_screenshot",
  "decision": "allow",
  "reason": "default policy: allow",
  "est_cost": 0.01,
  "currency": "USD",
  "status": "success",
  "latency_ms": 412,
  "input_hash": "sha256:a1b2c3d4e5f60708",
  "output_hash": "sha256:0807f6e5d4c3b2a1",
  "spent_month_after": 0.21,
  "budget_monthly": 5,
  "prev": "sha256:...",
  "hash": "sha256:..."
}
```

Input and output are hashed, not stored: the receipt proves what was called without retaining payloads.

Inspect and audit from the command line:

```bash
toolwarden-gateway receipts             # month summary, totals by tool, recent calls
toolwarden-gateway receipts --month 2026-05 --limit 20
toolwarden-gateway report               # self-contained HTML audit report
toolwarden-gateway verify               # walk the hash chain, exit 2 if tampered
```

## Policy semantics

1. The first rule whose `match` glob fits `server:tool` decides allow/ask/deny. `*` does not cross the `:` separator, so `demo:*` covers one server only.
2. `max_per_call` and the monthly budget always apply, even to calls a rule allows.
3. An explicit `allow` rule is pre-approval: it skips `ask_above`.
4. A matching rule's own `max_calls_per_hour` and `monthly_budget` apply next. Rate limits count execution attempts, so a looping agent is stopped even when its calls are free or failing.
5. Unmatched calls fall back to `default`, with `ask_above` escalating allow to ask.
6. Concurrent calls reserve their estimated cost before executing, so parallel calls cannot jointly overdraw the budget. Reservations settle on success and release on failure.

## Development

```bash
pnpm test     # policy engine unit tests
pnpm smoke    # end-to-end: spawns the gateway and exercises every policy path
pnpm build    # tsc to dist/
```

## Status

Early prototype, built to test a hypothesis: that teams running agents need spend governance and audit before they need payment rails. If that matches a problem you have, open an issue or write to hello@toolwarden.ai.

MIT license.
