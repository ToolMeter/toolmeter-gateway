# Policy reference

The policy decides every tool call. It lives under `policy:` in
`toolwarden.yaml`, or arrives signed from ToolWarden Cloud when a
`policy_source` is configured. The schema below is `PolicySchema` in
`src/config.ts`; the evaluation order is `evaluate()` in `src/policy.ts`.
This document follows both exactly.

## Schema

```yaml
policy:
  budget:
    monthly: 5.00          # number >= 0. Total successful spend allowed per
                           # calendar month, all tools. 0 disables the check.
    currency: USD          # label only, no FX. Default USD.
  limits:
    max_per_call: 0.05     # optional. Calls estimated above this are denied.
    ask_above: 0.10        # optional. With default: allow and no matching
                           # rule, calls at or above this become ask.
  rules:                   # optional list, FIRST MATCH WINS.
    - match: "search:*"    # glob against "server:tool". * matches any run of
                           # characters EXCEPT ":", so "demo:*" covers one
                           # server only; a bare "*" matches everything.
                           # Several * per pattern are fine ("*:read*").
      action: allow        # allow | deny | ask
      reason: optional human-readable string, shown in receipts and errors
      monthly_budget: 2.00       # optional. Monthly spend cap counted across
                                 # calls matching THIS pattern.
      max_calls_per_hour: 100    # optional. Sliding-hour execution cap
                                 # across calls matching THIS pattern.
  default: allow           # allow | deny | ask. Applies when no rule matches.
```

Cost estimates come from the server's `prices:` map (`tool: USD`, `"*"` as
a catch-all); a tool with no price estimates to $0. Budgets and `ask_above`
only bite when estimates are nonzero, but rate limits and allow/ask/deny
rules govern free tools all the same.

## Evaluation order

For a call with key `server:tool` and estimated cost `c`:

1. **Deny rule.** If the first matching rule says `deny`, deny. Nothing
   overrides an explicit deny.
2. **Per-call ceiling.** If `limits.max_per_call` is set and `c` exceeds
   it, deny.
3. **Global budget.** If `budget.monthly > 0` and committed spend
   (settled receipts plus in-flight reservations) plus `c` would exceed
   it, deny. Reservations make this safe under concurrency: parallel
   calls cannot stampede past the cap.
4. **Principal budget.** In serve mode, if the calling principal has a
   `monthly_budget` and would exceed it, deny.
5. **Rule rate limit.** If the matching rule has `max_calls_per_hour`
   and the sliding hour is full, deny.
6. **Rule scoped budget.** If the matching rule has `monthly_budget`
   and matching spend plus `c` would exceed it, deny.
7. **Rule action.** A matching `ask` rule asks. A matching `allow` rule
   allows; explicit allow is pre-approval and skips `ask_above`.
8. **ask_above.** No matching rule, `default: allow`, `ask_above` set,
   and `c >= ask_above`: ask.
9. **Default.** Otherwise the policy default applies.

An `ask` verdict pauses the call for a human: see
[approvals and grants](approvals-and-grants.md). A deny returns a tool
error with the `reason`.

## Where policy comes from, and which wins

- **Local file.** The `policy:` block is hot-reloaded when the config
  file changes; no restart.
- **Central, signed.** With `policy_source`, the gateway polls the cloud
  for the org's current policy version. Every version is Ed25519-signed
  over `org|version|sha256(yaml)|signed_at`; the gateway verifies against
  a pinned key (or one fetched once at startup) and refuses version
  downgrades. A verified central policy replaces the local block and
  keeps surviving config reloads; on any fetch or verification failure
  the current policy stays active. Tampered transport cannot inject
  policy, and a replayed old version cannot roll you back.
- Per-gateway scoping: the cloud can publish versions bound to a gateway
  glob, so `prod-*` and laptops can run different policy.

## Worked examples

Deny one tool, cap a category, let the rest flow but confirm anything
expensive:

```yaml
policy:
  budget: { monthly: 25.00 }
  limits: { max_per_call: 1.00, ask_above: 0.10 }
  rules:
    - match: "dataset:export"
      action: deny
      reason: license forbids training use
    - match: "search:*"
      action: allow
      monthly_budget: 5.00
      max_calls_per_hour: 200
  default: allow
```

Default-deny for an unattended CI runner (nothing waits on a human):

```yaml
policy:
  budget: { monthly: 10.00 }
  rules:
    - { match: "*:read*", action: allow }
    - { match: "*:list*", action: allow }
  default: deny
```
