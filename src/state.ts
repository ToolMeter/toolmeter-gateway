import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type MonthState = { spent: number; calls: number }
type StateFile = { months: Record<string, MonthState> }

export class SpendState {
  private path: string
  private state: StateFile

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

  callsThisMonth(): number {
    return this.state.months[this.monthKey()]?.calls ?? 0
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
