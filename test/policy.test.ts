import { describe, expect, it } from 'vitest'
import { evaluate, estimateCost, type PolicyContext } from '../src/policy.js'
import { globMatch } from '../src/glob.js'
import type { Policy, ServerConfig } from '../src/config.js'

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    budget: { monthly: 20, currency: 'USD' },
    limits: { max_per_call: 0.05, ask_above: 0.1 },
    rules: [],
    default: 'allow',
    ...overrides,
  }
}

function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    committed: 0,
    spentMatching: () => 0,
    callsLastHourMatching: () => 0,
    ...overrides,
  }
}

describe('globMatch', () => {
  it('matches exact strings', () => {
    expect(globMatch('demo:echo', 'demo:echo')).toBe(true)
    expect(globMatch('demo:echo', 'demo:other')).toBe(false)
  })

  it('star does not cross the server:tool separator', () => {
    expect(globMatch('demo:*', 'demo:echo')).toBe(true)
    expect(globMatch('demo:*', 'other:echo')).toBe(false)
    expect(globMatch('*:echo', 'demo:echo')).toBe(true)
  })

  it('bare star matches everything', () => {
    expect(globMatch('*', 'demo:echo')).toBe(true)
  })
})

describe('estimateCost', () => {
  const server: ServerConfig = {
    name: 'demo',
    command: 'node',
    args: [],
    env: {},
    prices: { screenshot: 0.01, '*': 0.001 },
  }

  it('uses exact tool price first', () => {
    expect(estimateCost(server, 'screenshot')).toBe(0.01)
  })

  it('falls back to wildcard price', () => {
    expect(estimateCost(server, 'anything')).toBe(0.001)
  })

  it('defaults to zero without prices', () => {
    expect(estimateCost({ ...server, prices: {} }, 'x')).toBe(0)
  })
})

describe('evaluate', () => {
  it('allows a cheap call under default allow', () => {
    const v = evaluate(policy(), 'demo:echo', 0.01, ctx())
    expect(v.decision).toBe('allow')
  })

  it('deny rule wins over everything', () => {
    const p = policy({ rules: [{ match: 'demo:export', action: 'deny', reason: 'no training use' }] })
    const v = evaluate(p, 'demo:export', 0, ctx())
    expect(v.decision).toBe('deny')
    expect(v.reason).toBe('no training use')
  })

  it('denies above max_per_call even with an allow rule', () => {
    const p = policy({ rules: [{ match: 'demo:*', action: 'allow' }] })
    const v = evaluate(p, 'demo:big', 0.2, ctx())
    expect(v.decision).toBe('deny')
    expect(v.reason).toContain('max_per_call')
  })

  it('denies when monthly budget would be exceeded', () => {
    const v = evaluate(policy(), 'demo:echo', 0.01, ctx({ committed: 19.995 }))
    expect(v.decision).toBe('deny')
    expect(v.reason).toContain('budget')
  })

  it('budget of zero means no budget enforcement', () => {
    const p = policy({ budget: { monthly: 0, currency: 'USD' } })
    const v = evaluate(p, 'demo:echo', 0.01, ctx({ committed: 999 }))
    expect(v.decision).toBe('allow')
  })

  it('asks at or above ask_above with no explicit rule', () => {
    const p = policy({ limits: { max_per_call: 1, ask_above: 0.1 } })
    const v = evaluate(p, 'demo:pricey', 0.1, ctx())
    expect(v.decision).toBe('ask')
  })

  it('explicit allow rule is pre-approval and skips ask_above', () => {
    const p = policy({
      limits: { max_per_call: 1, ask_above: 0.1 },
      rules: [{ match: 'demo:pricey', action: 'allow' }],
    })
    const v = evaluate(p, 'demo:pricey', 0.5, ctx())
    expect(v.decision).toBe('allow')
  })

  it('ask rule escalates even cheap calls', () => {
    const p = policy({ rules: [{ match: 'demo:sensitive', action: 'ask' }] })
    const v = evaluate(p, 'demo:sensitive', 0, ctx())
    expect(v.decision).toBe('ask')
  })

  it('first matching rule wins', () => {
    const p = policy({
      rules: [
        { match: 'demo:tool', action: 'deny', reason: 'specific' },
        { match: 'demo:*', action: 'allow' },
      ],
    })
    expect(evaluate(p, 'demo:tool', 0, ctx()).decision).toBe('deny')
    expect(evaluate(p, 'demo:other', 0, ctx()).decision).toBe('allow')
  })

  it('default deny blocks unmatched tools', () => {
    const p = policy({ default: 'deny' })
    const v = evaluate(p, 'demo:echo', 0, ctx())
    expect(v.decision).toBe('deny')
  })

  it('scoped monthly_budget denies when its bucket is exhausted', () => {
    const p = policy({
      rules: [{ match: 'fs:*', action: 'allow', monthly_budget: 2 }],
    })
    const v = evaluate(p, 'fs:read_file', 0.01, ctx({ spentMatching: () => 1.995 }))
    expect(v.decision).toBe('deny')
    expect(v.reason).toContain('budget for "fs:*"')
  })

  it('scoped budget leaves other tools untouched', () => {
    const p = policy({
      rules: [{ match: 'fs:*', action: 'allow', monthly_budget: 2 }],
    })
    const v = evaluate(p, 'web:fetch', 0.01, ctx({ spentMatching: () => 999 }))
    expect(v.decision).toBe('allow')
  })

  it('rate limit denies at the hourly threshold', () => {
    const p = policy({
      rules: [{ match: 'demo:*', action: 'allow', max_calls_per_hour: 100 }],
    })
    const v = evaluate(p, 'demo:echo', 0, ctx({ callsLastHourMatching: () => 100 }))
    expect(v.decision).toBe('deny')
    expect(v.reason).toContain('rate limit')
  })

  it('rate limit allows under the threshold', () => {
    const p = policy({
      rules: [{ match: 'demo:*', action: 'allow', max_calls_per_hour: 100 }],
    })
    const v = evaluate(p, 'demo:echo', 0, ctx({ callsLastHourMatching: () => 99 }))
    expect(v.decision).toBe('allow')
  })

  it('rate limit applies even to an ask rule before approval', () => {
    const p = policy({
      rules: [{ match: 'demo:pricey', action: 'ask', max_calls_per_hour: 5 }],
    })
    const v = evaluate(p, 'demo:pricey', 0.01, ctx({ callsLastHourMatching: () => 5 }))
    expect(v.decision).toBe('deny')
  })

  it('principal budget denies when that caller is exhausted', () => {
    const v = evaluate(
      policy(),
      'demo:echo',
      0.01,
      ctx({ principal: { name: 'alice', spent: 1.995, monthlyBudget: 2 } }),
    )
    expect(v.decision).toBe('deny')
    expect(v.reason).toContain('principal "alice"')
  })

  it('principal without a budget is only bound by global limits', () => {
    const v = evaluate(
      policy(),
      'demo:echo',
      0.01,
      ctx({ principal: { name: 'bob', spent: 999 } }),
    )
    expect(v.decision).toBe('allow')
  })
})
