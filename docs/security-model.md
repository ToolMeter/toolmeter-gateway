# Security model

What the cryptography actually guarantees, what it does not, and where
the trust boundaries sit. Buyers should be able to check these claims,
so each one names the mechanism that backs it.

## Assets

1. **The audit trail**: receipts must be complete and unmodified, or
   tampering must be provable.
2. **Policy integrity**: gateways must enforce the policy the org
   published, not something injected or rolled back.
3. **Credentials**: org tokens (dashboard), gateway tokens (ingest),
   the cloud signing key.
4. **Payload privacy**: tool inputs and outputs.

## Trust boundaries

```
agent/MCP client | gateway (your machine) | network | ToolWarden Cloud | auditor
```

- The **gateway host** is trusted at decision time. It runs your
  policy; whoever roots it can call tools as the agent could.
- The **network** is untrusted: everything is TLS, policy and approval
  links are additionally signed end to end.
- The **cloud** is trusted for availability and approval routing, but
  NOT for history: it cannot forge receipts (it does not know future
  hashes' preimages and its countersignatures pin what it saw), and a
  cloud that rewrites history diverges from local files in a provable
  way.
- The **auditor** trusts neither side: the audit pack verifies offline
  in a browser, no ToolWarden service involved.

## Guarantees and their mechanisms

**Receipts are tamper-evident.** Each receipt's hash is sha256 over its
content including the previous receipt's hash. Editing or deleting any
receipt breaks every later link; `toolwarden-gateway verify` and the
offline verifier recompute the whole chain.

**History cannot be quietly rewritten after ingest.** On every accepted
batch the cloud Ed25519-countersigns
`org|gateway|chain_head|timestamp`. A countersigned head is third-party
evidence that this exact chain state existed then. Rewriting the past on
either side produces two incompatible chains for the same countersigned
head, which is exactly the proof of tampering.

**Policy cannot be injected or rolled back in transit.** Central policy
versions are signed over `org|version|sha256(yaml)|signed_at`. The
gateway verifies against a pinned public key (recommended; otherwise
fetched once at startup, trust on first use) and refuses version
downgrades. On any failure it keeps the current policy.

**A leaked gateway config does not compromise the org.** Per-gateway
tokens (`twgw_`) are pinned to one gateway identity and scoped to
ingest, policy fetch, approvals, and spend. They cannot open the
dashboard, publish policy, read other gateways' data, or ingest under
another name (the cloud forces the bound gateway id).

**Unanswered approvals deny.** Timeouts, expiry, network failures, and
cloud outages all resolve `ask` to no. Slack links are one-time
Ed25519-signed; GET only confirms, POST decides, so prefetchers cannot
approve.

**Payloads never leave your machine.** Receipts carry sha256 hashes of
tool inputs and outputs, never contents. The hash still binds the
receipt to the exact payload: present the payload later and anyone can
check it matches.

**Dashboard hardening.** Same-origin CSRF guard on state-changing
forms, Secure/HttpOnly/SameSite session cookies, per-IP login rate
limit, ingest rate and size caps.

## What this does NOT defend against

Honesty here is the point; treat anything not listed above as out of
scope.

- **A compromised gateway host at write time.** Receipts are written by
  the gateway. An attacker who controls the host can suppress a receipt
  before it is written or chained. What they cannot do is doctor
  history that already reached a countersigned head, and a gateway that
  goes silent triggers a silent-gateway alert within hours.
- **A malicious gateway operator pre-ingest.** Same boundary: the chain
  proves continuity from genesis, not that genesis happened on an
  honest machine. For adversarial-operator settings, ship receipts
  frequently (small `flush_ms`) so the countersigned head trails
  reality by seconds.
- **Cloud denial of service.** A down cloud cannot corrupt anything,
  but approvals deny and ingest queues locally until it returns. The
  local receipts file remains the complete record.
- **Tool-call content risks.** The gateway decides whether a call may
  happen, not whether its arguments are wise. Prompt injection that
  persuades an agent to make an allowed call is a policy-writing
  problem (tighten rules, lower ask thresholds), not something the
  chain detects.
- **Cost estimate gaming.** Budgets act on configured estimates. A tool
  priced at $0 spends $0 of budget no matter what it really costs you;
  rate limits are the defense that does not depend on estimates.
- **Key loss.** If the cloud signing key leaks, countersignatures and
  policy signatures lose their meaning from that moment (history
  already countersigned stays verifiable against the old key). Rotate
  by republishing policy under a new key and re-pinning gateways.

## Reporting

Security reports: hello@toolwarden.ai. We commit to acknowledging
within 48 hours and to crediting reporters unless they prefer
otherwise.
