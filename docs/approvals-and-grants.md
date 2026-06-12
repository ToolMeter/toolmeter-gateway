# Approvals and grants

An `ask` verdict pauses a tool call until a human decides. This page
covers where that decision happens, how long it waits, what a grant is,
and the rule that makes the whole design safe: **everything fails toward
denial**.

## Local approvals (no cloud)

Without an `approvals` block, the gateway uses MCP elicitation: your MCP
client (Claude Code, Claude Desktop) shows a yes/no prompt in place. If
the client does not support elicitation, the call is denied with a clear
reason. Good for a single person on a laptop.

## Cloud approvals

```yaml
approvals:
  url: https://cloud.example/v1/approvals
  token: ${TOOLWARDEN_TOKEN}
  timeout_seconds: 120   # how long the call waits for a decision
  poll_ms: 1500
```

With this block, `ask` verdicts escalate to ToolWarden Cloud instead:

1. The gateway POSTs the request (gateway, principal, tool, estimated
   cost, reason) and holds the tool call.
2. The request appears in the dashboard inbox, and, if a Slack webhook
   is configured, in Slack with one-tap signed approve/deny links.
3. The gateway polls until someone decides, the `timeout_seconds`
   elapse, or the request expires server-side (15 minutes).
4. Approved: the call proceeds. Denied, expired, timed out, network
   error, cloud unreachable: the call is denied. There is no failure
   mode in which an unanswered question becomes a yes.

The receipt records the decision either way (`ask_approved` /
`ask_denied`), so the audit trail shows who was asked and what happened.

### Slack links

Slack messages carry one-time links signed with the cloud's Ed25519 key
over `approval-id|action`. Opening the link (GET) only shows a confirm
page; the decision happens on the button press (POST), so link
prefetchers and previewers cannot approve anything. The signature is the
authorization: the link works for exactly one approval and one action.

## Grants: pre-approval with an expiry

Answering the same question every few minutes teaches people to click
yes without reading. A grant fixes the fatigue without widening policy:
it auto-approves a specific principal calling a specific tool, on
gateways matching a glob, until it expires.

Two ways to create one:

- **While deciding.** The inbox's Approve button has a scope selector:
  once, for 1 hour, or for 24 hours. Choosing a duration creates a grant
  from that approval.
- **In advance.** The dashboard's grant form pre-approves a
  principal/tool/gateway-glob for 1 hour, 24 hours, or 7 days, before
  the first escalation ever fires.

While a grant matches, escalations decide instantly as approved, and the
approval record names the grant that decided it (`grant:<id>`), so
auto-approvals are first-class audit events, not silence. Grants are
revocable at any time from the dashboard and expire on their own.

Grants do not bypass policy: they answer the `ask`, nothing else.
Budgets, ceilings, and rate limits still apply to every call.

## Choosing timeouts

`timeout_seconds` is how long the agent blocks mid-task. For interactive
use, 120 seconds is comfortable. For unattended runs, prefer policies
that do not ask at all (default-deny with explicit allows), because
nobody is there to answer: see the strict-CI template.
