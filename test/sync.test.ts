import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { planSync } from '../src/sync.js'
import { GENESIS, type Receipt, type ReceiptBody } from '../src/receipts.js'

function chain(count: number): Receipt[] {
  const receipts: Receipt[] = []
  let prev = GENESIS
  for (let i = 0; i < count; i++) {
    const body: ReceiptBody & { prev: string } = {
      receipt_id: `rcpt_${i}`,
      ts: new Date(1700000000000 + i * 1000).toISOString(),
      principal: 'local',
      server: 'demo',
      tool: 'echo',
      decision: 'allow',
      reason: 'within policy',
      est_cost: 0,
      currency: 'USD',
      status: 'success',
      latency_ms: 1,
      input_hash: 'sha256:abc',
      output_hash: null,
      spent_month_after: 0,
      budget_monthly: 0,
      prev,
    }
    const hash = `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`
    receipts.push({ ...body, hash })
    prev = hash
  }
  return receipts
}

describe('planSync', () => {
  const all = chain(5)

  it('pushes everything when the collector is at genesis', () => {
    const plan = planSync(all, GENESIS)
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.suffix.length).toBe(5)
  })

  it('pushes only the suffix after the collector head', () => {
    const plan = planSync(all, all[2].hash)
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.suffix.length).toBe(2)
      expect(plan.suffix[0].hash).toBe(all[3].hash)
    }
  })

  it('pushes nothing when the collector is already at the local head', () => {
    const plan = planSync(all, all[4].hash)
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.suffix.length).toBe(0)
  })

  it('refuses a foreign collector head', () => {
    const plan = planSync(all, 'sha256:not-in-this-chain')
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.error).toContain('not in the local chain')
  })
})
