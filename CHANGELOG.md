# Changelog

All notable changes to `@toolwarden/gateway` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/). Until 1.0.0, minor versions may contain breaking changes; they are called out explicitly.

## [Unreleased]

Nothing yet.

## [0.6.0] - 2026-06-12

The sink became infrastructure.

### Added

- Sink resync: when the collector answers 409 (its stored head does not match, e.g. after a dropped batch or a collector restore), the sink locates the collector's head in the local `receipts.jsonl`, rebuilds its queue from everything after it, and redelivers. The local file is the source of truth.
- Sink self-disable on unrecoverable divergence (collector head unknown locally, or a second conflict immediately after a resync), with a loud stderr explanation. Tool calls are never affected; the local receipts file stays complete.

## [0.5.0] - 2026-06-12

The open half of fleet observability.

### Added

- `sink` config block: the gateway ships every receipt, in chain order, to a collector URL with a bearer token (`${ENV_VAR}` expansion supported). Delivery is batched, retried with backoff, and never blocks the tool-call path; if the collector is unreachable, calls keep flowing and the local `receipts.jsonl` stays complete. The wire schema is documented in the README so any collector can implement it.

## [0.4.0] - 2026-06-11

Team mode: one shared gateway, many authenticated callers.

### Added

- `serve` command: runs the gateway as a Streamable HTTP MCP service (`/mcp`) instead of stdio. Sessions authenticate with bearer tokens; unknown tokens get 401, and a session opened by one principal cannot be reused with another's token.
- Principals: named callers configured under `serve.principals`, each with a token (supports `${ENV_VAR}` expansion so config files stay secret-free) and an optional `monthly_budget` enforced inside the global budget.
- Per-principal attribution everywhere: receipts carry a `principal` field, `toolwarden_status` reports the caller's own spend and remaining budget, the `receipts` CLI shows the caller per entry, and the HTML report adds a "By principal" table when more than one is active.
- Live policy reload: the gateway watches the config file and applies policy and price changes to running sessions without a restart. A malformed edit is rejected and the previous policy stays active.
- HTTP smoke test (auth rejection, per-principal budget isolation, attribution, session-token binding), wired into CI.

### Changed

- Internal restructure: the gateway is now a shared core (upstreams, policy, spend state, receipt chain) with one MCP server per session on top. Stdio mode runs a single session under the built-in `local` principal.
- **Breaking**: receipts gained the `principal` field, which changes receipt hashes. Chains written by 0.3.0 remain internally valid; entries appended by 0.4.0 continue the chain with the new field.

## [0.3.0] - 2026-06-11

Deeper policy, visible audit, one-minute onboarding.

### Added

- Rule-scoped limits: rules accept `monthly_budget` (a budget covering only the tools that rule matches) and `max_calls_per_hour`. Rate limits count execution attempts, so a looping agent is stopped even when its calls are free or failing.
- `report` command: renders a self-contained HTML audit report with summary cards, receipt-chain verification status, spend by tool with median latency, and the recent decision log.
- `init` command: reads an existing `.mcp.json` or Claude Desktop config and generates a `toolwarden.yaml` wrapping every server with a starter policy, then prints the client snippet to swap in.

### Changed

- **Project renamed from ToolMeter to ToolWarden.** Package is `@toolwarden/gateway`, binary is `toolwarden-gateway`, the status tool is `toolwarden_status`, and the default storage directory moved from `~/.toolmeter` to `~/.toolwarden`.

## [0.2.0] - 2026-06-11

Receipts you can trust, budgets that survive concurrency.

### Added

- Hash-chained receipts: every entry carries the hash of the previous entry plus its own content hash, making the log tamper-evident. The chain resumes across gateway restarts.
- `verify` command: walks the chain and exits 2 on any modification, deletion, or reordering.
- `receipts` command: monthly spend summary, totals by tool, blocked-call counts, recent entries.
- End-to-end approval coverage: the smoke test drives a real MCP elicitation round trip (`ask_approved`) and the tamper-detection path.
- CI on GitHub Actions and a governance-without-payments example wrapping the official filesystem server (reads allowed, writes need approval, destructive operations denied).

### Fixed

- Budget race: concurrent calls could each pass the budget check before either charged. Calls now reserve their estimated cost up front; reservations settle on success and release on failure.

## [0.1.0] - 2026-06-11

Initial release, as ToolMeter.

### Added

- Stdio MCP proxy that re-exposes tools from any number of upstream MCP servers (stdio or Streamable HTTP) with price annotations in tool descriptions.
- `policy.yaml`: global monthly budget, `max_per_call` ceiling, `ask_above` approval threshold, first-match-wins allow/ask/deny rules with globs (`*` does not cross the `server:tool` separator), and a default action.
- Approval flow via MCP elicitation, falling back to an explained deny for clients without elicitation support.
- JSONL receipts with input/output payload hashes (payloads are never stored), success-only metering, and a `toolwarden_status` tool agents can call to check their own remaining budget.

[Unreleased]: https://github.com/ToolWarden/toolwarden-gateway/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/ToolWarden/toolwarden-gateway/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/ToolWarden/toolwarden-gateway/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ToolWarden/toolwarden-gateway/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ToolWarden/toolwarden-gateway/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ToolWarden/toolwarden-gateway/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ToolWarden/toolwarden-gateway/releases/tag/v0.1.0
