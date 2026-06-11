import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { globMatch } from './glob.js'

type MonthState = {
  spent: number
  calls: number
  byKey: Record<string, number>
  byPrincipal: Record<string, number>
}
type StateFile = {
  months: Record<string, MonthState>
  // Epoch ms of executed calls per server:tool key, pruned to the last hour.
  // Used for max_calls_per_hour rate limits.
  recent: Record<string, number[]>
}

const HOUR_MS = 60 * 60 * 1000

export class SpendState {
  private path: string
  private state: StateFile
  // In-flight reservations. Concurrent calls each reserve their estimated
  // cost before execution, so two calls cannot both pass the budget check
  // and overdraw together. In-memory only: a crash drops reservations,
  // which fails safe because nothing was charged.
  private pending = 0

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, 'state.json')
    const loaded = existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StateFile>)
      : {}
    this.state = { months: loaded.months ?? {}, recent: loaded.recent ?? {} }
    for (const month of Object.values(this.state.months)) {
      month.byKey ??= {}
      month.byPrincipal ??= {}
    }
  }

  private monthKey(): string {
    return new Date().toISOString().slice(0, 7)
  }

  private persist(): void {
    writeFileSync(this.path, JSON.stringify(this.state, null, 2))
  }

  spentThisMonth(): number {
    return this.state.months[this.monthKey()]?.spent ?? 0
  }

  /** Spend that budget checks must count: settled charges plus reservations. */
  committedThisMonth(): number {
    return this.spentThisMonth() + this.pending
  }

  callsThisMonth(): number {
    return this.state.months[this.monthKey()]?.calls ?? 0
  }

  /** Settled spend this month attributed to one principal. */
  spentThisMonthByPrincipal(principal: string): number {
    return this.state.months[this.monthKey()]?.byPrincipal[principal] ?? 0
  }

  /** Settled spend this month across keys matching a policy glob. */
  spentThisMonthMatching(pattern: string): number {
    const byKey = this.state.months[this.monthKey()]?.byKey ?? {}
    let sum = 0
    for (const [key, amount] of Object.entries(byKey)) {
      if (globMatch(pattern, key)) sum += amount
    }
    return Number(sum.toFixed(10))
  }

  /** Record that a call to this key is being executed, for rate limiting. */
  recordCall(key: string): void {
    const now = Date.now()
    const calls = (this.state.recent[key] ?? []).filter((t) => now - t < HOUR_MS)
    calls.push(now)
    this.state.recent[key] = calls
    this.persist()
  }

  /** Executed calls in the last hour across keys matching a policy glob. */
  callsLastHourMatching(pattern: string): number {
    const now = Date.now()
    let count = 0
    for (const [key, times] of Object.entries(this.state.recent)) {
      if (!globMatch(pattern, key)) continue
      count += times.filter((t) => now - t < HOUR_MS).length
    }
    return count
  }

  reserve(amount: number): void {
    this.pending = Number((this.pending + amount).toFixed(10))
  }

  /** Settle a reservation: charge it if the call succeeded, drop it otherwise. */
  settle(amount: number, charge: boolean, key?: string, principal?: string): void {
    this.pending = Math.max(0, Number((this.pending - amount).toFixed(10)))
    if (charge) this.charge(amount, key, principal)
  }

  charge(amount: number, key?: string, principal?: string): void {
    const monthKey = this.monthKey()
    const month = this.state.months[monthKey] ?? { spent: 0, calls: 0, byKey: {}, byPrincipal: {} }
    month.spent = Number((month.spent + amount).toFixed(10))
    month.calls += 1
    if (key) {
      month.byKey[key] = Number(((month.byKey[key] ?? 0) + amount).toFixed(10))
    }
    if (principal) {
      month.byPrincipal[principal] = Number(((month.byPrincipal[principal] ?? 0) + amount).toFixed(10))
    }
    this.state.months[monthKey] = month
    this.persist()
  }
}
