import { createServer, type Server } from 'node:http'
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PolicySource } from '../src/policy-source.js'
import type { Policy } from '../src/config.js'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

function signedPolicy(version: number, monthly: number, tamper?: 'yaml' | 'signature') {
  const yaml = `policy:\n  budget:\n    monthly: ${monthly}\n  default: allow\n`
  const sha = createHash('sha256').update(yaml).digest('hex')
  const signedAt = new Date().toISOString()
  const payload = `toolwarden-policy|acme|${version}|${sha}|${signedAt}`
  let signature = cryptoSign(null, Buffer.from(payload), privateKey).toString('base64')
  let body = yaml
  if (tamper === 'yaml') body = yaml.replace(`monthly: ${monthly}`, 'monthly: 9999')
  if (tamper === 'signature') signature = signature.slice(0, -8) + 'AAAAAAAA'
  return {
    org: 'acme',
    version,
    yaml: body,
    yaml_sha256: sha,
    signature,
    signed_at: signedAt,
  }
}

describe('PolicySource', () => {
  let server: Server
  let url: string
  let responses: Array<ReturnType<typeof signedPolicy>>
  let applied: Array<{ policy: Policy; version: number }>

  beforeEach(async () => {
    responses = []
    applied = []
    server = createServer((req, res) => {
      const current = responses[responses.length - 1]
      if (!current) {
        res.writeHead(404).end('{}')
        return
      }
      if (req.headers['if-none-match'] === `"v${current.version}"`) {
        res.writeHead(304).end()
        return
      }
      res
        .writeHead(200, { 'content-type': 'application/json', etag: `"v${current.version}"` })
        .end(JSON.stringify(current))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1/policy`
  })

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  function source() {
    return new PolicySource(
      { url, token: 'tw_org_token', poll_seconds: 3600, public_key: publicKeyPem },
      (policy, version) => applied.push({ policy, version }),
    )
  }

  it('applies a correctly signed policy', async () => {
    responses.push(signedPolicy(1, 7))
    const ps = source()
    await ps.start()
    ps.stop()
    expect(applied.length).toBe(1)
    expect(applied[0].version).toBe(1)
    expect(applied[0].policy.budget.monthly).toBe(7)
  })

  it('rejects tampered yaml (hash mismatch)', async () => {
    responses.push(signedPolicy(1, 7, 'yaml'))
    const ps = source()
    await ps.start()
    ps.stop()
    expect(applied.length).toBe(0)
  })

  it('rejects a bad signature', async () => {
    responses.push(signedPolicy(1, 7, 'signature'))
    const ps = source()
    await ps.start()
    ps.stop()
    expect(applied.length).toBe(0)
  })

  it('refuses version downgrades', async () => {
    responses.push(signedPolicy(5, 7))
    const ps = source()
    await ps.start()
    expect(applied.length).toBe(1)

    // Server starts serving an older signed version (replay).
    responses.push(signedPolicy(3, 1))
    // @ts-expect-error reach into the private tick for a deterministic test
    await ps.tick()
    ps.stop()
    expect(applied.length).toBe(1)
  })

  it('handles 404 (nothing published) and applies later versions', async () => {
    const ps = source()
    await ps.start()
    expect(applied.length).toBe(0)

    responses.push(signedPolicy(1, 2))
    // @ts-expect-error private tick
    await ps.tick()
    ps.stop()
    expect(applied.length).toBe(1)
    expect(applied[0].policy.budget.monthly).toBe(2)
  })
})
