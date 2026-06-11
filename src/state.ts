import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type MonthState = { spent: number; calls: number }
type StateFile = { months: Record<string, MonthState> }

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
    this.state = existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, 'utf8')) as StateFile)
      : { months: {} }
  }

  private monthKey(): string {
    return new Date().toISOString().slice(0, 7)
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

  reserve(amount: number): void {
    this.pending = Number((this.pending + amount).toFixed(10))
  }

  /** Settle a reservation: charge it if the call succeeded, drop it otherwise. */
  settle(amount: number, charge: boolean): void {
    this.pending = Math.max(0, Number((this.pending - amount).toFixed(10)))
    if (charge) this.charge(amount)
  }

  charge(amount: number): void {
    const key = this.monthKey()
    const month = this.state.months[key] ?? { spent: 0, calls: 0 }
    month.spent = Number((month.spent + amount).toFixed(10))
    month.calls += 1
    this.state.months[key] = month
    writeFileSync(this.path, JSON.stringify(this.state, null, 2))
  }
}
