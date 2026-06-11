import { existsSync, readFileSync } from 'node:fs'
import { readReceipts, verifyChain, type Receipt } from './receipts.js'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function money(n: number): string {
  return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.00')}`
}

export function buildReport(file: string, month: string): string {
  const all = existsSync(file) ? readReceipts(file) : []
  const receipts = all.filter((r) => r.ts.startsWith(month))
  const lines = existsSync(file)
    ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    : []
  const chain = verifyChain(lines)

  const spent = receipts.filter((r) => r.status === 'success').reduce((s, r) => s + r.est_cost, 0)
  const blocked = receipts.filter((r) => r.status === 'blocked').length
  const asked = receipts.filter((r) => r.decision.startsWith('ask')).length
  const currency = receipts[0]?.currency ?? 'USD'

  const byTool = new Map<string, { calls: number; spent: number; blocked: number; latency: number[] }>()
  for (const r of receipts) {
    const key = `${r.server}:${r.tool}`
    const row = byTool.get(key) ?? { calls: 0, spent: 0, blocked: 0, latency: [] }
    row.calls++
    if (r.status === 'success') row.spent += r.est_cost
    if (r.status === 'blocked') row.blocked++
    if (r.latency_ms !== null) row.latency.push(r.latency_ms)
    byTool.set(key, row)
  }

  const byPrincipal = new Map<string, { calls: number; spent: number; blocked: number }>()
  for (const r of receipts) {
    const name = r.principal ?? 'local'
    const row = byPrincipal.get(name) ?? { calls: 0, spent: 0, blocked: 0 }
    row.calls++
    if (r.status === 'success') row.spent += r.est_cost
    if (r.status === 'blocked') row.blocked++
    byPrincipal.set(name, row)
  }
  const principalRows =
    byPrincipal.size > 1
      ? [...byPrincipal.entries()]
          .sort((a, b) => b[1].spent - a[1].spent)
          .map(
            ([name, row]) =>
              `<tr><td class="mono">${esc(name)}</td><td>${row.calls}</td><td>${money(row.spent)}</td><td>${
                row.blocked || ''
              }</td></tr>`,
          )
          .join('\n')
      : ''

  const toolRows = [...byTool.entries()]
    .sort((a, b) => b[1].spent - a[1].spent)
    .map(([key, row]) => {
      const median = row.latency.length
        ? [...row.latency].sort((a, b) => a - b)[Math.floor(row.latency.length / 2)]
        : null
      return `<tr><td class="mono">${esc(key)}</td><td>${row.calls}</td><td>${money(row.spent)}</td><td>${
        row.blocked || ''
      }</td><td>${median === null ? '' : `${median} ms`}</td></tr>`
    })
    .join('\n')

  const badge = (r: Receipt) =>
    r.status === 'success'
      ? '<span class="b ok">success</span>'
      : r.status === 'blocked'
        ? '<span class="b no">blocked</span>'
        : '<span class="b err">error</span>'

  const recent = receipts
    .slice(-50)
    .reverse()
    .map(
      (r) =>
        `<tr><td class="mono dim">${esc(r.ts.slice(5, 19).replace('T', ' '))}</td><td class="mono">${esc(
          `${r.server}:${r.tool}`,
        )}</td><td>${esc(r.decision)}</td><td>${badge(r)}</td><td>${money(r.est_cost)}</td><td class="dim">${esc(
          r.reason,
        )}</td></tr>`,
    )
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ToolWarden report ${esc(month)}</title>
<style>
  body { background:#0a0a0c; color:#e4e4e7; font:14px/1.5 -apple-system, "Segoe UI", sans-serif; margin:0; padding:48px; }
  .wrap { max-width: 960px; margin: 0 auto; }
  h1 { font-size:20px; font-weight:600; letter-spacing:-0.02em; }
  h1 .dim, .dim { color:#71717a; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin:24px 0 36px; }
  .card { border:1px solid #27272a; border-radius:10px; padding:16px; background:#101013; }
  .card .v { font-size:22px; font-weight:600; margin-top:4px; }
  .card .ok { color:#34d399; } .card .no { color:#f87171; }
  table { width:100%; border-collapse:collapse; margin:12px 0 36px; }
  th { text-align:left; color:#71717a; font-weight:500; font-size:12px; text-transform:uppercase; letter-spacing:0.05em; padding:8px 10px; border-bottom:1px solid #27272a; }
  td { padding:8px 10px; border-bottom:1px solid #1c1c1f; vertical-align:top; }
  .mono { font-family:ui-monospace, Menlo, monospace; font-size:12.5px; }
  .b { font-size:11px; padding:2px 8px; border-radius:99px; border:1px solid; }
  .b.ok { color:#34d399; border-color:#34d39933; background:#34d3990d; }
  .b.no { color:#f87171; border-color:#f8717133; background:#f871710d; }
  .b.err { color:#fbbf24; border-color:#fbbf2433; background:#fbbf240d; }
  h2 { font-size:14px; font-weight:600; margin-top:8px; }
  .chain { padding:10px 14px; border-radius:8px; border:1px solid; display:inline-block; font-size:13px; }
  .chain.ok { color:#34d399; border-color:#34d39933; }
  .chain.bad { color:#f87171; border-color:#f8717133; }
</style>
</head>
<body><div class="wrap">
  <h1>ToolWarden <span class="dim">· audit report · ${esc(month)}</span></h1>
  <div class="cards">
    <div class="card"><div class="dim">Calls</div><div class="v">${receipts.length}</div></div>
    <div class="card"><div class="dim">Spent</div><div class="v">${money(spent)} <span class="dim" style="font-size:13px">${esc(currency)}</span></div></div>
    <div class="card"><div class="dim">Blocked</div><div class="v ${blocked ? 'no' : ''}">${blocked}</div></div>
    <div class="card"><div class="dim">Approval flow</div><div class="v">${asked}</div></div>
  </div>
  <div class="chain ${chain.ok ? 'ok' : 'bad'}">
    ${
      chain.ok
        ? `Receipt chain intact: ${chain.count} entries verified`
        : `Receipt chain BROKEN at entry ${chain.brokenAt}: ${esc(chain.error ?? '')}`
    }
  </div>
  ${
    principalRows
      ? `<h2 style="margin-top:36px">By principal</h2>
  <table>
    <thead><tr><th>Principal</th><th>Calls</th><th>Spent</th><th>Blocked</th></tr></thead>
    <tbody>${principalRows}</tbody>
  </table>`
      : ''
  }
  <h2 style="margin-top:36px">By tool</h2>
  <table>
    <thead><tr><th>Tool</th><th>Calls</th><th>Spent</th><th>Blocked</th><th>Median latency</th></tr></thead>
    <tbody>${toolRows || '<tr><td colspan="5" class="dim">No calls this month</td></tr>'}</tbody>
  </table>
  <h2>Recent decisions <span class="dim">(last ${Math.min(50, receipts.length)})</span></h2>
  <table>
    <thead><tr><th>Time</th><th>Tool</th><th>Decision</th><th>Status</th><th>Cost</th><th>Reason</th></tr></thead>
    <tbody>${recent || '<tr><td colspan="6" class="dim">Nothing yet</td></tr>'}</tbody>
  </table>
  <p class="dim" style="font-size:12px">Generated by toolwarden-gateway. Input and output payloads are hashed in receipts, never stored.</p>
</div></body></html>`
}
