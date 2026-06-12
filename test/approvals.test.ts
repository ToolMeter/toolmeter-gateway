import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CloudApprover } from '../src/approvals.js'

describe('CloudApprover', () => {
  let server: Server
  let url: string
  // Script the cloud: status returned per poll, in order.
  let statuses: string[]
  let created: Array<Record<string, unknown>>

  beforeEach(async () => {
    statuses = []
    created = []
    server = createServer((req, res) => {
      if (req.method === 'POST') {
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
          created.push(JSON.parse(raw))
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ id: 'apr-1', expires_at: new Date().toISOString() }))
        })
        return
      }
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0] ?? 'pending'
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1/approvals`
  })

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  function approver(timeoutSeconds = 5) {
    return new CloudApprover({
      url,
      token: 'tw_org_token',
      timeout_seconds: timeoutSeconds,
      poll_ms: 50,
    })
  }

  const req = {
    gateway: 'gw',
    principal: 'alice',
    tool: 'fs:write_file',
    est_cost: 0,
    currency: 'USD',
    reason: 'writes need approval',
  }

  it('resolves true when the cloud approves', async () => {
    statuses = ['pending', 'pending', 'approved']
    expect(await approver().requestApproval(req)).toBe(true)
    expect(created[0].tool).toBe('fs:write_file')
  })

  it('resolves false when the cloud denies', async () => {
    statuses = ['pending', 'denied']
    expect(await approver().requestApproval(req)).toBe(false)
  })

  it('resolves false on expiry', async () => {
    statuses = ['expired']
    expect(await approver().requestApproval(req)).toBe(false)
  })

  it('times out to denial when nobody decides', async () => {
    statuses = ['pending']
    expect(await approver(1).requestApproval(req)).toBe(false)
  })

  it('denies when the cloud is unreachable', async () => {
    await new Promise<void>((r) => server.close(() => r()))
    expect(await approver().requestApproval(req)).toBe(false)
    server = createServer(() => {})
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  })
})
