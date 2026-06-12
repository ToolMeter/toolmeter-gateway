# Quickstart: zero to a governed agent

Five minutes from "my agent can call anything" to budgets, approvals, and
receipts. The gateway is a single process between any MCP client and your
MCP servers; the servers stay unchanged.

## 1. Install

```bash
git clone https://github.com/toolwarden/toolwarden-gateway
cd toolwarden-gateway && pnpm install && pnpm build
```

Or use the container image:

```bash
docker pull ghcr.io/toolwarden/gateway
```

(An npm package, `@toolwarden/gateway`, is coming; until then run from
source or Docker.)

## 2. Wrap your existing servers

```bash
node dist/cli.js init     # reads .mcp.json or the Claude Desktop config
```

`init` writes a `toolwarden.yaml` that wraps every server you already use
with a starter policy, and prints the client config to swap in. The shape:

```yaml
policy:
  budget:
    monthly: 5.00          # USD across all tools this month
  limits:
    max_per_call: 0.05     # hard per-call ceiling
    ask_above: 0.02        # at or above this, a human approves first
  rules:
    - match: "fs:write*"   # globs against server:tool
      action: ask
      reason: writes need a human
  default: allow

storage:
  dir: ~/.toolwarden       # receipts.jsonl and state.json

servers:
  - name: fs
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/you/allow"]
```

Point your MCP client at the gateway instead of the servers. For Claude
Code, `.mcp.json` becomes:

```json
{
  "mcpServers": {
    "toolwarden": {
      "command": "node",
      "args": ["/path/to/toolwarden-gateway/dist/cli.js", "--config", "/path/to/toolwarden.yaml"]
    }
  }
}
```

## 3. Watch a call get held

Ask your agent to write a file. The `fs:write*` rule returns an `ask`
verdict: the call pauses, your MCP client shows an approval prompt
(elicitation), and the call proceeds only on yes. Everything else flows
untouched. Denials and budget exhaustion come back to the agent as clear
tool errors it can react to.

## 4. Look at the receipts

```bash
node dist/cli.js receipts        # spend summary, by tool, recent calls
node dist/cli.js verify          # recompute the hash chain end to end
node dist/cli.js report          # self-contained HTML audit report
```

Every decision appended one line to `~/.toolwarden/receipts.jsonl`. Each
receipt embeds the hash of its predecessor, so the file is tamper-evident:
`verify` catches any edit or deletion.

## 5. Optional: connect ToolWarden Cloud

The cloud adds a fleet dashboard, centrally signed policy, an approvals
inbox with Slack links, alerts, and countersigned audit trails. Add to
`toolwarden.yaml`:

```yaml
sink:                       # ship receipts (hashes only, never payloads)
  url: https://cloud.example/v1/ingest
  token: ${TOOLWARDEN_TOKEN}
  gateway_id: my-laptop

policy_source:              # pull signed central policy
  url: https://cloud.example/v1/policy
  token: ${TOOLWARDEN_TOKEN}

approvals:                  # escalate ask verdicts to the inbox/Slack
  url: https://cloud.example/v1/approvals
  token: ${TOOLWARDEN_TOKEN}
```

Use a per-gateway token (`twgw_…`, issued in the dashboard) rather than
the org token: it is pinned to one gateway identity and cannot open the
dashboard. `${VAR}` expands from the environment so the config can be
committed.

## 6. When something is off

```bash
node dist/cli.js doctor --config toolwarden.yaml
```

checks config syntax, storage, the local chain, upstream connectivity,
cloud reachability, chain-head agreement, and the policy signature, and
prints a diagnosis.

Next: [policy reference](policy-reference.md) ·
[approvals and grants](approvals-and-grants.md) ·
[security model](security-model.md) · [HTTP API](http-api.md)
