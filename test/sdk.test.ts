import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { GENESIS, ToolWarden } from '../sdk/src/index.js'

type ReceiptWire = { prev: string; hash: string } & Record<string, unknown>

/**
 * In-memory collector speaking the cloud wire schema, verifying chains
 * exactly like the cloud does (recomputed hash over JSON minus hash).
 */
function fakeCollector(opts?: {
  createStatus?: 'pending' | 'approved' | 'denied'
  pollStatuses?: string[]
  initialHead?: string
  hideAttestationOnce?: boolean
}) {
  let head = opts?.initialHead ?? GENESIS
  let attestationHidden = opts?.hideAttestationOnce ?? false
  const polls = [...(opts?.pollStatuses ?? [])]
  const stats = { ingested: 0, polled: 0, conflicts: 0 }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

    if (url.pathname === '/v1/approvals' && init?.method === 'POST') {
      return json({ id: 'apr-1', status: opts?.createStatus ?? 'pending' })
    }
    if (url.pathname.startsWith('/v1/approvals/')) {
      stats.polled++
      return json({ id: 'apr-1', status: polls.shift() ?? 'pending' })
    }
    if (url.pathname.startsWith('/v1/attestations/')) {
      if (attestationHidden) {
        attestationHidden = false
        return json({ error: 'unknown gateway' }, 404)
      }
      return json({ chain_head: head })
    }
    if (url.pathname === '/v1/ingest' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { receipts: ReceiptWire[] }
      for (const r of body.receipts) {
        if (r.prev !== head) {
          stats.conflicts++
          return json({ error: 'chain verification failed', expected_head: head }, 409)
        }
        const { hash, ...rest } = r
        const expected = `sha256:${createHash('sha256').update(JSON.stringify(rest)).digest('hex')}`
        if (hash !== expected) return json({ error: 'hash mismatch' }, 409)
        head = hash
        stats.ingested++
      }
      return json({
        ok: true,
        chain_head: head,
        countersignature: 'sig',
        countersigned_at: new Date().toISOString(),
      })
    }
    return json({ error: 'not found' }, 404)
  }) as typeof fetch

  return { fetchImpl, stats, get head() { return head } }
}

function client(collector: ReturnType<typeof fakeCollector>) {
  return new ToolWarden({
    url: 'https://cloud.test',
    token: 'twgw_test',
    gateway: 'sdk-bot',
    fetch: collector.fetchImpl,
  })
}

describe('ToolWarden SDK approvals', () => {
  it('resolves true when a human approves after polling', async () => {
    const c = fakeCollector({ pollStatuses: ['pending', 'approved'] })
    const ok = await client(c).approve({ principal: 'a', tool: 't:x', pollMs: 5, timeoutMs: 1000 })
    expect(ok).toBe(true)
    expect(c.stats.polled).toBe(2)
  })

  it('short-circuits on an instant grant decision, no polling', async () => {
    const c = fakeCollector({ createStatus: 'approved' })
    expect(await client(c).approve({ principal: 'a', tool: 't:x' })).toBe(true)
    expect(c.stats.polled).toBe(0)
  })

  it('fails toward denial: denied, timeout, and network error are all false', async () => {
    expect(
      await client(fakeCollector({ createStatus: 'denied' })).approve({ principal: 'a', tool: 't:x' }),
    ).toBe(false)
    expect(
      await client(fakeCollector()).approve({ principal: 'a', tool: 't:x', pollMs: 5, timeoutMs: 25 }),
    ).toBe(false)
    const broken = new ToolWarden({
      url: 'https://cloud.test',
      token: 'twgw_test',
      gateway: 'g',
      fetch: (async () => {
        throw new Error('network down')
      }) as typeof fetch,
    })
    expect(await broken.approve({ principal: 'a', tool: 't:x' })).toBe(false)
  })
})

describe('ToolWarden SDK receipts', () => {
  it('files receipts the collector verifies, chaining across calls', async () => {
    const c = fakeCollector()
    const tw = client(c)
    const first = await tw.fileReceipt({
      principal: 'agent-7',
      server: 'payments',
      tool: 'refund',
      decision: 'ask_approved',
      reason: 'approved via inbox',
      status: 'success',
      input: { order: 4153 },
      output: { refunded: true },
      latencyMs: 412,
    })
    const second = await tw.fileReceipt({
      principal: 'agent-7',
      server: 'payments',
      tool: 'refund',
      decision: 'allow',
      reason: 'within policy',
      status: 'success',
      input: { order: 4154 },
    })
    expect(c.stats.ingested).toBe(2)
    expect(first.chainHead).toBe(first.hash)
    expect(second.chainHead).toBe(second.hash)
    expect(c.head).toBe(second.hash)
    expect(first.countersignature).toBe('sig')
  })

  it('recovers from a head conflict by rebuilding on the fresh head', async () => {
    // The collector already holds a chain the SDK has never seen, and the
    // attestation endpoint 404s once, so the SDK starts from GENESIS,
    // collides, learns the real head from the 409, and retries.
    const c = fakeCollector({ initialHead: 'sha256:somebody-elses-head', hideAttestationOnce: true })
    const filed = await client(c).fileReceipt({
      principal: 'a',
      server: 's',
      tool: 't',
      decision: 'allow',
      reason: 'r',
      status: 'success',
    })
    expect(c.stats.conflicts).toBe(1)
    expect(c.stats.ingested).toBe(1)
    expect(filed.chainHead).toBe(filed.hash)
  })
})
