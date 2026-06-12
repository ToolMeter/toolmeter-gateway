import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import { PolicySchema, type Policy, type PolicySourceConfig } from './config.js'

type PolicyResponse = {
  org: string
  version: number
  yaml: string
  yaml_sha256: string
  signature: string
  signed_at: string
}

/** Must match the cloud's policyPayload() byte for byte. */
function policyPayload(org: string, version: number, yamlSha256: string, signedAt: string): string {
  return `toolwarden-policy|${org}|${version}|${yamlSha256}|${signedAt}`
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Polls a central policy endpoint and applies verified updates. Trust
 * model: every policy version is signed by the cloud's countersigning key.
 * The gateway verifies the signature (against a pinned key when configured,
 * else a key fetched once at startup) and refuses version downgrades, so
 * neither a tampered transport nor a replayed old policy can change what
 * the gateway enforces. On any failure the current policy stays active.
 */
export class PolicySource {
  private publicKeyPem: string | undefined
  private appliedVersion = 0
  private etag: string | undefined
  private timer: NodeJS.Timeout | undefined
  private stopped = false

  constructor(
    private config: PolicySourceConfig,
    private onPolicy: (policy: Policy, version: number) => void,
    private gatewayId?: string,
  ) {
    this.publicKeyPem = config.public_key
  }

  /** Fetch once immediately, then poll. Never throws. */
  async start(): Promise<void> {
    await this.tick()
    const schedule = () => {
      if (this.stopped) return
      this.timer = setTimeout(async () => {
        await this.tick()
        schedule()
      }, this.config.poll_seconds * 1000)
      this.timer.unref?.()
    }
    schedule()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
  }

  private keyUrl(): string {
    return new URL('/v1/public-key', this.config.url).toString()
  }

  private async tick(): Promise<void> {
    try {
      if (!this.publicKeyPem) {
        const res = await fetch(this.keyUrl(), { signal: AbortSignal.timeout(10_000) })
        if (!res.ok) throw new Error(`public key fetch: ${res.status}`)
        this.publicKeyPem = await res.text()
        console.error(
          'toolwarden-gateway: policy_source fetched the signing key on first use. ' +
            'Pin it in the config (policy_source.public_key) to remove this trust-on-first-use step.',
        )
      }

      const headers: Record<string, string> = {
        authorization: `Bearer ${this.config.token}`,
      }
      if (this.etag) headers['if-none-match'] = this.etag
      const url = new URL(this.config.url)
      if (this.gatewayId) url.searchParams.set('gateway', this.gatewayId)
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
      if (res.status === 304) return
      if (res.status === 404) return // nothing published yet
      if (!res.ok) throw new Error(`policy fetch: ${res.status}`)

      const body = (await res.json()) as PolicyResponse
      if (body.version <= this.appliedVersion) {
        if (body.version < this.appliedVersion) {
          console.error(
            `toolwarden-gateway: policy_source served version ${body.version} but ` +
              `${this.appliedVersion} is already applied; refusing the downgrade.`,
          )
        }
        return
      }

      const sha = await sha256Hex(body.yaml)
      if (sha !== body.yaml_sha256) throw new Error('policy content hash mismatch')
      const payload = policyPayload(body.org, body.version, body.yaml_sha256, body.signed_at)
      const valid = cryptoVerify(
        null,
        Buffer.from(payload),
        createPublicKey(this.publicKeyPem),
        Buffer.from(body.signature, 'base64'),
      )
      if (!valid) throw new Error('policy signature verification failed')

      const doc = parseYaml(body.yaml) as { policy?: unknown }
      const policy = PolicySchema.parse(doc.policy)
      this.onPolicy(policy, body.version)
      this.appliedVersion = body.version
      this.etag = res.headers.get('etag') ?? undefined
      console.error(`toolwarden-gateway: applied central policy v${body.version}`)
    } catch (err) {
      console.error(
        `toolwarden-gateway: policy_source check failed, keeping current policy: ${
          err instanceof Error ? err.message : err
        }`,
      )
    }
  }
}
