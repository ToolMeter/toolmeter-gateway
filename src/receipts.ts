import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'

export type Receipt = {
  receipt_id: string
  ts: string
  server: string
  tool: string
  decision: 'allow' | 'deny' | 'ask_approved' | 'ask_denied'
  reason: string
  est_cost: number
  currency: string
  status: 'success' | 'error' | 'blocked'
  latency_ms: number | null
  input_hash: string
  output_hash: string | null
  spent_month_after: number
  budget_monthly: number
}

export function hashPayload(payload: unknown): string {
  const json = JSON.stringify(payload) ?? 'null'
  return `sha256:${createHash('sha256').update(json).digest('hex').slice(0, 16)}`
}

export function newReceiptId(): string {
  return `rcpt_${randomBytes(6).toString('hex')}`
}

export class ReceiptLog {
  private path: string

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, 'receipts.jsonl')
  }

  append(receipt: Receipt): void {
    appendFileSync(this.path, JSON.stringify(receipt) + '\n')
  }

  get file(): string {
    return this.path
  }
}
