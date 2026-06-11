import type { Receipt } from './receipts.js'

export type SinkOptions = {
  url: string
  token: string
  gateway: string
  batchSize?: number
  flushMs?: number
}

/**
 * Ships receipts to a collector (ToolWarden Cloud or anything speaking the
 * same wire schema). Fire-and-forget by design: enqueue never blocks the
 * call path, batches are retried with backoff, and a batch that keeps
 * failing is dropped with a stderr warning rather than wedging the gateway.
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
  private readonly batchSize: number
  private readonly flushMs: number

  constructor(private opts: SinkOptions) {
    this.batchSize = opts.batchSize ?? 20
    this.flushMs = opts.flushMs ?? 2000
  }

  enqueue(receipt: Receipt): void {
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
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.slice(0, this.batchSize)
        try {
          await this.post(batch)
          this.queue.splice(0, batch.length)
          this.consecutiveFailures = 0
        } catch (err) {
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
    if (!res.ok) {
      throw new Error(`collector responded ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
  }

  /** Final best-effort flush on shutdown. */
  async close(): Promise<void> {
    clearTimeout(this.timer)
    if (this.queue.length === 0) return
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
