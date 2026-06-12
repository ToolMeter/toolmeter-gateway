import { existsSync, readFileSync, accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { hostname } from 'node:os'
import { loadConfig, type Config } from './config.js'
import { readReceipts, verifyChain } from './receipts.js'

type Level = 'pass' | 'warn' | 'fail'
const ICON: Record<Level, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' }

let failures = 0
let warnings = 0
function report(level: Level, area: string, detail: string): void {
  if (level === 'fail') failures++
  if (level === 'warn') warnings++
  console.log(`${ICON[level]}  ${area.padEnd(16)} ${detail}`)
}

async function timed<T>(ms: number, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((unused, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms)),
  ])
}

/**
 * One command that answers "why isn't my gateway working": config, storage,
 * upstreams, local chain, and every configured cloud surface (sink auth,
 * head agreement, policy signature, approvals reachability).
 */
export async function runDoctor(configPath: string): Promise<void> {
  console.log(`toolwarden doctor · ${configPath}\n`)

  // 1. Config
  let config: Config
  try {
    config = loadConfig(configPath)
    report('pass', 'config', `parses, ${config.servers.length} server(s)`)
  } catch (err) {
    report('fail', 'config', `${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  // 2. Storage
  try {
    accessSync(config.storage.dir, constants.W_OK)
    report('pass', 'storage', config.storage.dir)
  } catch {
    report('warn', 'storage', `${config.storage.dir} not writable or missing (created on first run)`)
  }

  // 3. Local chain
  const receiptsFile = join(config.storage.dir, 'receipts.jsonl')
  let localHead: string | undefined
  if (existsSync(receiptsFile)) {
    const lines = readFileSync(receiptsFile, 'utf8').trim().split('\n').filter(Boolean)
    const chain = verifyChain(lines)
    if (chain.ok) {
      const all = readReceipts(receiptsFile)
      localHead = all[all.length - 1]?.hash
      report('pass', 'local chain', `${chain.count} receipts, intact`)
    } else {
      report('fail', 'local chain', `broken at line ${chain.brokenAt}: ${chain.error}`)
    }
  } else {
    report('pass', 'local chain', 'no receipts yet')
  }

  // 4. Upstreams
  for (const sc of config.servers) {
    try {
      const client = new Client({ name: 'toolwarden-doctor', version: '0.0.0' })
      const transport = sc.url
        ? new StreamableHTTPClientTransport(new URL(sc.url))
        : new StdioClientTransport({
            command: sc.command!,
            args: sc.args,
            env: { ...process.env, ...sc.env } as Record<string, string>,
          })
      await timed(15_000, client.connect(transport))
      const { tools } = await timed(10_000, client.listTools())
      report('pass', `upstream:${sc.name}`, `${tools.length} tool(s)`)
      await client.close()
    } catch (err) {
      report('fail', `upstream:${sc.name}`, `${err instanceof Error ? err.message : err}`)
    }
  }

  const gatewayId = config.sink?.gateway_id ?? hostname()

  // 5. Sink and chain-head agreement
  if (config.sink) {
    try {
      const base = new URL(config.sink.url)
      const att = await timed(
        10_000,
        fetch(new URL(`/v1/attestations/${gatewayId}`, base), {
          headers: { authorization: `Bearer ${config.sink.token}` },
        }),
      )
      if (att.status === 401) {
        report('fail', 'sink', 'token rejected (401)')
      } else if (att.status === 404) {
        report('warn', 'sink', 'auth ok, gateway not seen by the cloud yet')
      } else if (att.ok) {
        const body = (await att.json()) as { chain_head: string }
        if (!localHead) {
          report('pass', 'sink', 'auth ok')
        } else if (body.chain_head === localHead) {
          report('pass', 'sink', 'auth ok, cloud head matches local head')
        } else {
          const all = readReceipts(receiptsFile)
          const cloudIsBehind = all.some((r) => r.hash === body.chain_head)
          report(
            cloudIsBehind ? 'warn' : 'fail',
            'sink',
            cloudIsBehind
              ? 'cloud is behind local (receipts pending delivery, normal during activity)'
              : 'cloud head is not in the local chain: another gateway may share this gateway_id',
          )
        }
      } else {
        report('warn', 'sink', `unexpected status ${att.status}`)
      }
    } catch (err) {
      report('fail', 'sink', `${err instanceof Error ? err.message : err}`)
    }
  } else {
    report('warn', 'sink', 'not configured (receipts stay local only)')
  }

  // 6. Central policy
  if (config.policy_source) {
    try {
      const url = new URL(config.policy_source.url)
      url.searchParams.set('gateway', gatewayId)
      const res = await timed(
        10_000,
        fetch(url, { headers: { authorization: `Bearer ${config.policy_source.token}` } }),
      )
      if (res.status === 401) {
        report('fail', 'policy', 'token rejected (401)')
      } else if (res.status === 402) {
        report('fail', 'policy', 'plan does not include central policy (402)')
      } else if (res.status === 404) {
        report('warn', 'policy', 'auth ok, no policy published yet')
      } else if (res.ok) {
        const body = (await res.json()) as {
          org: string
          version: number
          yaml_sha256: string
          signature: string
          signed_at: string
        }
        let pem = config.policy_source.public_key
        if (!pem) {
          pem = await (await fetch(new URL('/v1/public-key', url))).text()
        }
        const payload = `toolwarden-policy|${body.org}|${body.version}|${body.yaml_sha256}|${body.signed_at}`
        const valid = cryptoVerify(
          null,
          Buffer.from(payload),
          createPublicKey(pem),
          Buffer.from(body.signature, 'base64'),
        )
        report(
          valid ? 'pass' : 'fail',
          'policy',
          valid
            ? `v${body.version} signature verifies${config.policy_source.public_key ? ' (pinned key)' : ' (TOFU key, consider pinning)'}`
            : `v${body.version} SIGNATURE INVALID`,
        )
      } else {
        report('warn', 'policy', `unexpected status ${res.status}`)
      }
    } catch (err) {
      report('fail', 'policy', `${err instanceof Error ? err.message : err}`)
    }
  } else {
    report('warn', 'policy', 'no policy_source (local policy.yaml only)')
  }

  // 7. Approvals reachability
  if (config.approvals) {
    try {
      const res = await timed(
        10_000,
        fetch(`${config.approvals.url}/00000000-0000-0000-0000-000000000000`, {
          headers: { authorization: `Bearer ${config.approvals.token}` },
        }),
      )
      if (res.status === 404) report('pass', 'approvals', 'reachable, auth ok')
      else if (res.status === 401) report('fail', 'approvals', 'token rejected (401)')
      else report('warn', 'approvals', `unexpected status ${res.status}`)
    } catch (err) {
      report('fail', 'approvals', `${err instanceof Error ? err.message : err}`)
    }
  } else {
    report('warn', 'approvals', 'not configured (ask verdicts use in-client elicitation)')
  }

  console.log(
    `\n${failures} failure(s), ${warnings} warning(s).` +
      (failures ? ' Fix the failures above.' : warnings ? ' Warnings are usually fine.' : ' All good.'),
  )
  process.exit(failures > 0 ? 1 : 0)
}
