import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GENESIS, ReceiptLog, newReceiptId, verifyChain, type ReceiptBody } from '../src/receipts.js'
import { SpendState } from '../src/state.js'

function body(overrides: Partial<ReceiptBody> = {}): ReceiptBody {
  return {
    receipt_id: newReceiptId(),
    ts: new Date().toISOString(),
    principal: 'local',
    server: 'demo',
    tool: 'echo',
    decision: 'allow',
    reason: 'test',
    est_cost: 0.01,
    currency: 'USD',
    status: 'success',
    latency_ms: 5,
    input_hash: 'sha256:abc',
    output_hash: 'sha256:def',
    spent_month_after: 0.01,
    budget_monthly: 5,
    ...overrides,
  }
}

describe('receipt chain', () => {
  it('links receipts and verifies an intact chain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-receipts-'))
    const log = new ReceiptLog(dir)
    const first = log.append(body())
    const second = log.append(body())
    expect(first.prev).toBe(GENESIS)
    expect(second.prev).toBe(first.hash)

    const lines = readFileSync(log.file, 'utf8').trim().split('\n')
    expect(verifyChain(lines).ok).toBe(true)
  })

  it('resumes the chain across restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-receipts-'))
    const a = new ReceiptLog(dir)
    const last = a.append(body())
    const b = new ReceiptLog(dir)
    const next = b.append(body())
    expect(next.prev).toBe(last.hash)

    const lines = readFileSync(join(dir, 'receipts.jsonl'), 'utf8').trim().split('\n')
    expect(verifyChain(lines).ok).toBe(true)
  })

  it('detects a modified entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-receipts-'))
    const log = new ReceiptLog(dir)
    log.append(body())
    log.append(body())

    const lines = readFileSync(log.file, 'utf8').trim().split('\n')
    const tampered = JSON.parse(lines[0])
    tampered.est_cost = 0 // hide a cost
    lines[0] = JSON.stringify(tampered)
    writeFileSync(log.file, lines.join('\n') + '\n')

    const result = verifyChain(lines)
    expect(result.ok).toBe(false)
    expect(result.brokenAt).toBe(1)
  })

  it('detects a deleted entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-receipts-'))
    const log = new ReceiptLog(dir)
    log.append(body())
    log.append(body())
    log.append(body())

    const lines = readFileSync(log.file, 'utf8').trim().split('\n')
    lines.splice(1, 1) // remove the middle receipt
    const result = verifyChain(lines)
    expect(result.ok).toBe(false)
    expect(result.brokenAt).toBe(2)
  })
})

describe('spend reservations', () => {
  it('counts reservations against the budget until settled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-state-'))
    const state = new SpendState(dir)
    state.reserve(0.03)
    expect(state.committedThisMonth()).toBeCloseTo(0.03)
    expect(state.spentThisMonth()).toBe(0)

    state.settle(0.03, true)
    expect(state.spentThisMonth()).toBeCloseTo(0.03)
    expect(state.committedThisMonth()).toBeCloseTo(0.03)
  })

  it('releases reservations without charging on failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-state-'))
    const state = new SpendState(dir)
    state.reserve(0.03)
    state.settle(0.03, false)
    expect(state.spentThisMonth()).toBe(0)
    expect(state.committedThisMonth()).toBe(0)
  })
})
