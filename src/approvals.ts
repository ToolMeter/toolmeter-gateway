import type { ApprovalsConfig } from './config.js'

export type ApprovalRequest = {
  gateway: string
  principal: string
  tool: string
  est_cost: number
  currency: string
  reason: string
}

/**
 * Escalates "ask" verdicts to ToolWarden Cloud and polls for the human
 * decision. The tool call is held (bounded by timeout_seconds) while a
 * person approves from the dashboard inbox or a signed Slack link. Errors
 * and timeouts resolve to denial: the safe direction.
 */
export class CloudApprover {
  constructor(private config: ApprovalsConfig) {}

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.config.token}`,
    }
  }

  async requestApproval(req: ApprovalRequest): Promise<boolean> {
    let id: string
    try {
      const res = await fetch(this.config.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`approval create: ${res.status}`)
      id = ((await res.json()) as { id: string }).id
    } catch (err) {
      console.error(
        `toolwarden-gateway: approval escalation failed, denying: ${
          err instanceof Error ? err.message : err
        }`,
      )
      return false
    }

    const deadline = Date.now() + this.config.timeout_seconds * 1000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.config.poll_ms))
      try {
        const res = await fetch(`${this.config.url}/${id}`, {
          headers: this.headers(),
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) continue
        const { status } = (await res.json()) as { status: string }
        if (status === 'approved') return true
        if (status === 'denied' || status === 'expired') return false
      } catch {
        // transient; keep polling until the deadline
      }
    }
    console.error(
      `toolwarden-gateway: approval ${id} timed out after ${this.config.timeout_seconds}s, denying.`,
    )
    return false
  }
}
