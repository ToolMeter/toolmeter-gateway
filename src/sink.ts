import type { Receipt } from './receipts.js'
import { readReceipts, GENESIS } from './receipts.js'

export type SinkOptions = {
  url: string
  token: string
  gateway: string
  batchSize?: number
  flushMs?: number
  /** Path to the local receipts.jsonl, used to resync after a 409. */
  receiptsFile?: string
}

class HeadConflictError extends Error {
  constructor(readonly expectedHead: string | undefined) {
    super('collector reported a chain head mismatch')
  }
}

/**
 * Ships receipts to a collector (ToolWarden Cloud or anything speaking the
 * same wire schema). Fire-and-forget by design: enqueue never blocks the
 * call path, batches are retried with backoff, and a batch that keeps
 * failing is dropped with a stderr warning rather than wedging the gateway.
 *
 * If the collector answers 409 (its stored head does not match this batch,
 * e.g. after a dropped batch or a collector restore), the sink resyncs:
 * it locates the collector's head in the local receipts.jsonl, rebuilds the
 * queue from everything after it, and redelivers. The local file is always
 * the source of truth. If the head cannot be found locally, the chains are
 * incompatible and the sink disables itself loudly instead of looping.
 *
 * Wire schema: POST {url} with Authorization: Bearer {token} and body
 * { "gateway": string, "receipts": Receipt[] }. Receipts preserve their
 * chain order; the collector verifies hashes and continuity.
 */
export class ReceiptSink {
  private queue: Receipt[] = []
  private timer: NodeJS.Timeout | undefined
  private flushing = false
  private consecutiveFailures = 0
  private resyncedOnce = false
  private disabled = false
  private readonly batchSize: number
  private readonly flushMs: number

  constructor(private opts: SinkOptions) {
    this.batchSize = opts.batchSize ?? 20
    this.flushMs = opts.flushMs ?? 2000
  }

  enqueue(receipt: Receipt): void {
    if (this.disabled) return
    this.queue.push(receipt)
    if (this.queue.length >= this.batchSize) {
      void this.flush()
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.flushMs)
      this.timer.unref?.()
    }
  }

  private async flush(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.flushing || this.disabled) return
    this.flushing = true
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.slice(0, this.batchSize)
        try {
          await this.post(batch)
          this.queue.splice(0, batch.length)
          this.consecutiveFailures = 0
          this.resyncedOnce = false
        } catch (err) {
          if (err instanceof HeadConflictError) {
            if (!this.resync(err.expectedHead)) break
            continue
          }
          this.consecutiveFailures++
          if (this.consecutiveFailures >= 5) {
            console.error(
              `toolwarden-gateway: sink dropped ${batch.length} receipt(s) after ` +
                `${this.consecutiveFailures} failed attempts: ${err instanceof Error ? err.message : err}. ` +
                `Local receipts.jsonl remains complete.`,
            )
            this.queue.splice(0, batch.length)
            this.consecutiveFailures = 0
          } else {
            // Back off and let the next enqueue or timer retry.
            this.timer = setTimeout(
              () => void this.flush(),
              this.flushMs * 2 ** this.consecutiveFailures,
            )
            this.timer.unref?.()
          }
          break
        }
      }
    } finally {
      this.flushing = false
    }
  }

  /**
   * Rebuild the queue from the local chain so the next batch continues
   * exactly from the collector's head. Returns false when recovery is
   * impossible (no file configured, head unknown locally, or a second
   * conflict right after a resync, which means something is actively
   * diverging and retrying would loop).
   */
  private resync(collectorHead: string | undefined): boolean {
    if (!this.opts.receiptsFile || !collectorHead || this.resyncedOnce) {
      this.disable(
        this.resyncedOnce
          ? 'collector rejected the chain again immediately after a resync'
          : 'collector reported a head mismatch and no local receipts file is configured',
      )
      return false
    }
    const all = readReceipts(this.opts.receiptsFile)
    let suffix: Receipt[]
    if (collectorHead === GENESIS) {
      suffix = all
    } else {
      const idx = all.findIndex((r) => r.hash === collectorHead)
      if (idx === -1) {
        this.disable(
          `collector head ${collectorHead.slice(0, 24)}… is not in the local chain. ` +
            `Possible causes: two gateways sharing the same gateway_id, or a replaced local receipts file.`,
        )
        return false
      }
      suffix = all.slice(idx + 1)
    }
    this.queue = suffix
    this.resyncedOnce = true
    console.error(
      `toolwarden-gateway: sink resyncing ${suffix.length} receipt(s) from the local chain ` +
        `after collector head mismatch.`,
    )
    return true
  }

  private disable(reason: string): void {
    this.disabled = true
    this.queue = []
    console.error(
      `toolwarden-gateway: sink disabled: ${reason}. Tool calls continue unaffected; ` +
        `local receipts.jsonl remains complete. Restart the gateway after resolving.`,
    )
  }

  private async post(batch: Receipt[]): Promise<void> {
    const res = await fetch(this.opts.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.token}`,
      },
      body: JSON.stringify({ gateway: this.opts.gateway, receipts: batch }),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as { expected_head?: string } | null
      throw new HeadConflictError(body?.expected_head)
    }
    if (!res.ok) {
      throw new Error(`collector responded ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
  }

  /** Final best-effort flush on shutdown. */
  async close(): Promise<void> {
    clearTimeout(this.timer)
    if (this.disabled || this.queue.length === 0) return
    const batch = this.queue.splice(0)
    try {
      await this.post(batch)
    } catch {
      console.error(
        `toolwarden-gateway: sink could not deliver ${batch.length} receipt(s) on shutdown. ` +
          `Local receipts.jsonl remains complete.`,
      )
    }
  }
}
