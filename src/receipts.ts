import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'

export type ReceiptBody = {
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

// Each receipt links to the previous one and carries its own hash, so any
// edit, deletion, or reordering inside the log is detectable with `verify`.
export type Receipt = ReceiptBody & {
  prev: string
  hash: string
}

export const GENESIS = 'sha256:genesis'

export function hashPayload(payload: unknown): string {
  const json = JSON.stringify(payload) ?? 'null'
  return `sha256:${createHash('sha256').update(json).digest('hex').slice(0, 16)}`
}

export function newReceiptId(): string {
  return `rcpt_${randomBytes(6).toString('hex')}`
}

function receiptHash(body: ReceiptBody, prev: string): string {
  const canonical = JSON.stringify({ ...body, prev })
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

export type ChainVerification = {
  ok: boolean
  count: number
  brokenAt: number | null
  error: string | null
}

export function verifyChain(lines: string[]): ChainVerification {
  let prev = GENESIS
  for (let i = 0; i < lines.length; i++) {
    let receipt: Receipt
    try {
      receipt = JSON.parse(lines[i]) as Receipt
    } catch {
      return { ok: false, count: lines.length, brokenAt: i + 1, error: 'invalid JSON' }
    }
    if (receipt.prev !== prev) {
      return {
        ok: false,
        count: lines.length,
        brokenAt: i + 1,
        error: `prev mismatch: expected ${prev}, found ${receipt.prev}`,
      }
    }
    const { hash, ...rest } = receipt
    const expected = receiptHash(rest as ReceiptBody & { prev: string }, receipt.prev)
    if (hash !== expected) {
      return { ok: false, count: lines.length, brokenAt: i + 1, error: 'hash mismatch, entry was modified' }
    }
    prev = hash
  }
  return { ok: true, count: lines.length, brokenAt: null, error: null }
}

export function readReceipts(file: string): Receipt[] {
  if (!existsSync(file)) return []
  const raw = readFileSync(file, 'utf8').trim()
  if (!raw) return []
  return raw.split('\n').map((l) => JSON.parse(l) as Receipt)
}

export class ReceiptLog {
  private path: string
  private head: string

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, 'receipts.jsonl')
    // Resume the chain from the last receipt on disk.
    const existing = readReceipts(this.path)
    this.head = existing.length > 0 ? existing[existing.length - 1].hash : GENESIS
  }

  append(body: ReceiptBody): Receipt {
    const prev = this.head
    const hash = receiptHash(body, prev)
    const receipt: Receipt = { ...body, prev, hash }
    appendFileSync(this.path, JSON.stringify(receipt) + '\n')
    this.head = hash
    return receipt
  }

  get file(): string {
    return this.path
  }
}
