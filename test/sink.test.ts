import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReceiptSink } from '../src/sink.js'
import { ReceiptLog, newReceiptId, type Receipt, type ReceiptBody } from '../src/receipts.js'

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

function body(): ReceiptBody {
  const { prev, hash, ...rest } = receipt()
  return rest
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

describe('ReceiptSink resync', () => {
  let server: Server
  let url: string
  let received: Receipt[][]
  let collectorHead: string

  // A collector that actually tracks its head like the real one.
  beforeEach(async () => {
    received = []
    collectorHead = 'sha256:genesis'
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const batch = (JSON.parse(raw) as { receipts: Receipt[] }).receipts
        if (batch[0].prev !== collectorHead) {
          res
            .writeHead(409, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: 'mismatch', expected_head: collectorHead }))
          return
        }
        received.push(batch)
        collectorHead = batch[batch.length - 1].hash
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

  it('recovers from a dropped batch by resending the local suffix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-sink-resync-'))
    const log = new ReceiptLog(dir)
    const sink = new ReceiptSink({
      url,
      token: 'tw_org_token',
      gateway: 'gw',
      flushMs: 10,
      receiptsFile: log.file,
    })

    // First two receipts written locally but never enqueued: a "dropped batch".
    log.append(body())
    log.append(body())
    // Third receipt goes through the sink; its prev does not match the
    // collector's GENESIS head, so the collector 409s and the sink must
    // resync the full suffix from the file.
    const third = log.append(body())
    sink.enqueue(third)

    await new Promise((r) => setTimeout(r, 300))
    const delivered = received.flat()
    expect(delivered.length).toBe(3)
    expect(delivered[2].hash).toBe(third.hash)
    expect(collectorHead).toBe(third.hash)
  })

  it('disables itself when the collector head is not in the local chain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-sink-foreign-'))
    const log = new ReceiptLog(dir)
    collectorHead = 'sha256:some-foreign-chain-head'

    const sink = new ReceiptSink({
      url,
      token: 'tw_org_token',
      gateway: 'gw',
      flushMs: 10,
      receiptsFile: log.file,
    })
    sink.enqueue(log.append(body()))
    await new Promise((r) => setTimeout(r, 300))
    expect(received.length).toBe(0)

    // Further receipts are ignored without errors once disabled.
    sink.enqueue(log.append(body()))
    await new Promise((r) => setTimeout(r, 100))
    expect(received.length).toBe(0)
  })
})
