import { hostname } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { GENESIS, readReceipts, type Receipt } from './receipts.js'

// The collector caps batches at 500 receipts / 2 MB; stay safely under both.
const BATCH = 200

export type SyncPlan =
  | { ok: true; suffix: Receipt[]; collectorHead: string }
  | { ok: false; error: string }

/**
 * Everything after the collector's head, in chain order. The local file is
 * the source of truth; if the collector's head is not in it, the chains are
 * incompatible (shared gateway_id or a replaced local file) and pushing
 * would corrupt the audit trail, so refuse.
 */
export function planSync(all: Receipt[], collectorHead: string): SyncPlan {
  if (collectorHead === GENESIS) return { ok: true, suffix: all, collectorHead }
  const idx = all.findIndex((r) => r.hash === collectorHead)
  if (idx === -1) {
    return {
      ok: false,
      error:
        `collector head ${collectorHead.slice(0, 24)}… is not in the local chain. ` +
        `Possible causes: two gateways sharing the same gateway_id, or a replaced local receipts file.`,
    }
  }
  return { ok: true, suffix: all.slice(idx + 1), collectorHead }
}

/**
 * `toolwarden-gateway sync`: push the full local receipt history to the
 * configured sink, explicitly. Onboards a gateway that ran local-only, or
 * a fresh org, without waiting for the implicit 409-resync path.
 */
export async function runSync(configPath: string, dryRun: boolean): Promise<void> {
  const config = loadConfig(configPath)
  if (!config.sink) {
    console.error('sync: the config has no sink block; nothing to sync to.')
    process.exit(1)
  }
  const gateway = config.sink.gateway_id ?? hostname()
  const file = join(config.storage.dir, 'receipts.jsonl')
  const all = readReceipts(file)
  if (all.length === 0) {
    console.log(`sync: no local receipts in ${file}; nothing to do.`)
    return
  }

  const base = new URL(config.sink.url)
  const headRes = await fetch(new URL(`/v1/attestations/${gateway}`, base), {
    headers: { authorization: `Bearer ${config.sink.token}` },
    signal: AbortSignal.timeout(10_000),
  })
  let collectorHead = GENESIS
  if (headRes.ok) {
    collectorHead = ((await headRes.json()) as { chain_head: string }).chain_head
  } else if (headRes.status !== 404) {
    console.error(`sync: collector responded ${headRes.status} fetching the chain head.`)
    process.exit(1)
  }

  const plan = planSync(all, collectorHead)
  if (!plan.ok) {
    console.error(`sync: refusing to push: ${plan.error}`)
    process.exit(2)
  }
  if (plan.suffix.length === 0) {
    console.log(`sync: collector already has all ${all.length} receipt(s) for "${gateway}".`)
    return
  }
  console.log(
    `sync: collector head ${collectorHead === GENESIS ? 'GENESIS' : collectorHead.slice(0, 24) + '…'}, ` +
      `pushing ${plan.suffix.length} of ${all.length} local receipt(s) as "${gateway}".`,
  )
  if (dryRun) {
    console.log('sync: dry run, nothing sent.')
    return
  }

  let sent = 0
  for (let i = 0; i < plan.suffix.length; i += BATCH) {
    const batch = plan.suffix.slice(i, i + BATCH)
    const res = await fetch(config.sink.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.sink.token}`,
      },
      body: JSON.stringify({ gateway, receipts: batch }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      console.error(
        `sync: collector responded ${res.status} after ${sent} receipt(s): ` +
          `${(await res.text()).slice(0, 200)}`,
      )
      process.exit(1)
    }
    sent += batch.length
    console.log(`sync: ${sent}/${plan.suffix.length}`)
  }
  const last = (await (
    await fetch(new URL(`/v1/attestations/${gateway}`, base), {
      headers: { authorization: `Bearer ${config.sink.token}` },
      signal: AbortSignal.timeout(10_000),
    })
  ).json()) as { chain_head: string; countersigned_at: string }
  const localHead = all[all.length - 1].hash
  if (last.chain_head === localHead) {
    console.log(
      `sync: done. Collector head matches the local head and was countersigned at ${last.countersigned_at}.`,
    )
  } else {
    console.error(
      `sync: pushed everything but the collector head ${last.chain_head.slice(0, 24)}… ` +
        `does not match the local head ${localHead.slice(0, 24)}…. ` +
        `Another gateway may be ingesting under the same id.`,
    )
    process.exit(2)
  }
}
