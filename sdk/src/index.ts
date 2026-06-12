// @toolwarden/sdk: the ToolWarden Cloud HTTP surface for agents that do
// not run the MCP gateway. Zero dependencies; WebCrypto only, so it runs
// on Node 20+, Workers, Deno, and Bun.
//
// Two capabilities:
//   approve()      hold an action until a human (or a standing grant) decides
//   fileReceipt()  append a hash-chained, countersigned receipt to the trail
//
// Everything fails toward denial: timeouts, expiry, and network errors
// all resolve approvals to "no".

export const GENESIS = 'sha256:genesis'

export type ToolWardenOptions = {
  /** ToolWarden Cloud origin, e.g. https://cloud.example */
  url: string
  /** Per-gateway token (twgw_…) or org token (tworg_…). */
  token: string
  /** Gateway identity receipts and approvals are filed under. */
  gateway: string
  /** Injectable for tests. */
  fetch?: typeof fetch
}

export type ApprovalParams = {
  principal: string
  /** Tool key, conventionally "server:tool". */
  tool: string
  reason?: string
  estCost?: number
  currency?: string
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired'

export type ReceiptParams = {
  principal: string
  server: string
  tool: string
  decision: 'allow' | 'deny' | 'ask_approved' | 'ask_denied'
  reason: string
  status: 'success' | 'error' | 'blocked'
  estCost?: number
  currency?: string
  latencyMs?: number | null
  /** Hashed locally (sha256, truncated like the gateway); never sent raw. */
  input?: unknown
  output?: unknown
  spentMonthAfter?: number
  budgetMonthly?: number
}

export type FiledReceipt = {
  receiptId: string
  hash: string
  chainHead: string
  countersignature: string
  countersignedAt: string
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Same convention as the gateway: truncated payload hash. */
async function hashPayload(payload: unknown): Promise<string> {
  const json = JSON.stringify(payload) ?? 'null'
  return `sha256:${(await sha256Hex(json)).slice(0, 16)}`
}

function randomId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return `rcpt_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class ToolWarden {
  /** Local view of the gateway's chain head; lazily synced from the cloud. */
  private head: string | undefined

  constructor(private opts: ToolWardenOptions) {}

  private get fetchFn(): typeof fetch {
    return this.opts.fetch ?? globalThis.fetch
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.opts.token}`,
    }
  }

  private api(path: string): string {
    return new URL(path, this.opts.url).toString()
  }

  /** Create an approval request. Grants may decide it instantly. */
  async requestApproval(params: ApprovalParams): Promise<{ id: string; status: ApprovalStatus }> {
    const res = await this.fetchFn(this.api('/v1/approvals'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        gateway: this.opts.gateway,
        principal: params.principal,
        tool: params.tool,
        est_cost: params.estCost ?? 0,
        currency: params.currency ?? 'USD',
        reason: params.reason ?? '',
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`approval create failed: ${res.status}`)
    return (await res.json()) as { id: string; status: ApprovalStatus }
  }

  /** Poll until the request leaves pending or timeoutMs elapses. */
  async awaitDecision(
    id: string,
    timeoutMs = 120_000,
    pollMs = 1500,
  ): Promise<ApprovalStatus | 'timeout'> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const res = await this.fetchFn(this.api(`/v1/approvals/${id}`), {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        const body = (await res.json()) as { status: ApprovalStatus }
        if (body.status !== 'pending') return body.status
      }
      await sleep(pollMs)
    }
    return 'timeout'
  }

  /**
   * The whole flow in one call: returns true only on an explicit yes.
   * Denied, expired, timed out, or unreachable all return false.
   */
  async approve(params: ApprovalParams & { timeoutMs?: number; pollMs?: number }): Promise<boolean> {
    try {
      const created = await this.requestApproval(params)
      if (created.status === 'approved') return true
      if (created.status !== 'pending') return false
      return (await this.awaitDecision(created.id, params.timeoutMs, params.pollMs)) === 'approved'
    } catch {
      return false
    }
  }

  /** The cloud's stored chain head for this gateway (GENESIS if new). */
  async currentHead(): Promise<string> {
    const res = await this.fetchFn(this.api(`/v1/attestations/${this.opts.gateway}`), {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 404) return GENESIS
    if (!res.ok) throw new Error(`attestation fetch failed: ${res.status}`)
    return ((await res.json()) as { chain_head: string }).chain_head
  }

  private async buildReceipt(params: ReceiptParams, prev: string) {
    const body = {
      receipt_id: randomId(),
      ts: new Date().toISOString(),
      principal: params.principal,
      server: params.server,
      tool: params.tool,
      decision: params.decision,
      reason: params.reason,
      est_cost: params.estCost ?? 0,
      currency: params.currency ?? 'USD',
      status: params.status,
      latency_ms: params.latencyMs ?? null,
      input_hash: await hashPayload(params.input),
      output_hash: params.output === undefined ? null : await hashPayload(params.output),
      spent_month_after: params.spentMonthAfter ?? 0,
      budget_monthly: params.budgetMonthly ?? 0,
      prev,
    }
    // The chain rule: hash = sha256 over the receipt JSON minus its hash
    // field, key order preserved. Must stay byte-compatible with the
    // gateway and the cloud verifier.
    const hash = `sha256:${await sha256Hex(JSON.stringify(body))}`
    return { ...body, hash }
  }

  /**
   * Append one receipt to this gateway's chain and return the
   * countersigned head. On a head conflict (another writer advanced the
   * chain) the receipt is rebuilt on the fresh head and retried once.
   */
  async fileReceipt(params: ReceiptParams): Promise<FiledReceipt> {
    this.head ??= await this.currentHead()
    for (let attempt = 0; ; attempt++) {
      const receipt = await this.buildReceipt(params, this.head)
      const res = await this.fetchFn(this.api('/v1/ingest'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ gateway: this.opts.gateway, receipts: [receipt] }),
        signal: AbortSignal.timeout(10_000),
      })
      if (res.status === 409 && attempt === 0) {
        const body = (await res.json().catch(() => null)) as { expected_head?: string } | null
        this.head = body?.expected_head ?? (await this.currentHead())
        continue
      }
      if (!res.ok) throw new Error(`ingest failed: ${res.status}`)
      const out = (await res.json()) as {
        chain_head: string
        countersignature: string
        countersigned_at: string
      }
      this.head = out.chain_head
      return {
        receiptId: receipt.receipt_id,
        hash: receipt.hash,
        chainHead: out.chain_head,
        countersignature: out.countersignature,
        countersignedAt: out.countersigned_at,
      }
    }
  }

  /** Current signed policy for this org (undefined when none published). */
  async policy(): Promise<{ version: number; yaml: string } | undefined> {
    const res = await this.fetchFn(this.api('/v1/policy'), {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 404) return undefined
    if (!res.ok) throw new Error(`policy fetch failed: ${res.status}`)
    const body = (await res.json()) as { version: number; yaml: string }
    return { version: body.version, yaml: body.yaml }
  }

  /** Settled org spend for a month (defaults to the current month). */
  async spend(month?: string): Promise<number> {
    const m = month ?? new Date().toISOString().slice(0, 7)
    const res = await this.fetchFn(this.api(`/v1/spend?month=${m}`), {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`spend fetch failed: ${res.status}`)
    return ((await res.json()) as { spent: number }).spent
  }
}
