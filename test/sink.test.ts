import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReceiptSink } from '../src/sink.js'
import { newReceiptId, type Receipt } from '../src/receipts.js'

function receipt(): Receipt {
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
    prev: 'sha256:genesis',
    hash: 'sha256:fake',
  }
}

type Captured = { auth: string | undefined; body: { gateway: string; receipts: Receipt[] } }

describe('ReceiptSink', () => {
  let server: Server
  let url: string
  let captured: Captured[]
  let failures: number

  beforeEach(async () => {
    captured = []
    failures = 0
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        if (failures > 0) {
          failures--
          res.writeHead(503).end('unavailable')
          return
        }
        captured.push({ auth: req.headers.authorization, body: JSON.parse(raw) })
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1/ingest`
  })

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('delivers a batch with auth header and gateway name', async () => {
    const sink = new ReceiptSink({ url, token: 'tw_org_token', gateway: 'gw-test', flushMs: 10 })
    sink.enqueue(receipt())
    sink.enqueue(receipt())
    await new Promise((r) => setTimeout(r, 150))
    expect(captured.length).toBe(1)
    expect(captured[0].auth).toBe('Bearer tw_org_token')
    expect(captured[0].body.gateway).toBe('gw-test')
    expect(captured[0].body.receipts.length).toBe(2)
  })

  it('flushes immediately at batch size', async () => {
    const sink = new ReceiptSink({ url, token: 'tw_org_token', gateway: 'gw', batchSize: 3, flushMs: 60_000 })
    sink.enqueue(receipt())
    sink.enqueue(receipt())
    sink.enqueue(receipt())
    await new Promise((r) => setTimeout(r, 150))
    expect(captured.length).toBe(1)
    expect(captured[0].body.receipts.length).toBe(3)
  })

  it('retries after transient failure without losing receipts', async () => {
    failures = 1
    const sink = new ReceiptSink({ url, token: 'tw_org_token', gateway: 'gw', flushMs: 20 })
    sink.enqueue(receipt())
    await new Promise((r) => setTimeout(r, 400))
    expect(captured.length).toBe(1)
    expect(captured[0].body.receipts.length).toBe(1)
  })

  it('close performs a final flush', async () => {
    const sink = new ReceiptSink({ url, token: 'tw_org_token', gateway: 'gw', flushMs: 60_000 })
    sink.enqueue(receipt())
    await sink.close()
    expect(captured.length).toBe(1)
  })
})
