import { describe, expect, it } from 'vitest'
import { evaluate, estimateCost } from '../src/policy.js'
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
    const v = evaluate(policy(), 'demo:echo', 0.01, 0)
    expect(v.decision).toBe('allow')
  })

  it('deny rule wins over everything', () => {
    const p = policy({ rules: [{ match: 'demo:export', action: 'deny', reason: 'no training use' }] })
    const v = evaluate(p, 'demo:export', 0, 0)
    expect(v.decision).toBe('deny')
    expect(v.reason).toBe('no training use')
  })

  it('denies above max_per_call even with an allow rule', () => {
    const p = policy({ rules: [{ match: 'demo:*', action: 'allow' }] })
    const v = evaluate(p, 'demo:big', 0.2, 0)
    expect(v.decision).toBe('deny')
    expect(v.reason).toContain('max_per_call')
  })

  it('denies when monthly budget would be exceeded', () => {
    const v = evaluate(policy(), 'demo:echo', 0.01, 19.995)
    expect(v.decision).toBe('deny')
    expect(v.reason).toContain('budget')
  })

  it('budget of zero means no budget enforcement', () => {
    const p = policy({ budget: { monthly: 0, currency: 'USD' } })
    const v = evaluate(p, 'demo:echo', 0.01, 999)
    expect(v.decision).toBe('allow')
  })

  it('asks at or above ask_above with no explicit rule', () => {
    const p = policy({ limits: { max_per_call: 1, ask_above: 0.1 } })
    const v = evaluate(p, 'demo:pricey', 0.1, 0)
    expect(v.decision).toBe('ask')
  })

  it('explicit allow rule is pre-approval and skips ask_above', () => {
    const p = policy({
      limits: { max_per_call: 1, ask_above: 0.1 },
      rules: [{ match: 'demo:pricey', action: 'allow' }],
    })
    const v = evaluate(p, 'demo:pricey', 0.5, 0)
    expect(v.decision).toBe('allow')
  })

  it('ask rule escalates even cheap calls', () => {
    const p = policy({ rules: [{ match: 'demo:sensitive', action: 'ask' }] })
    const v = evaluate(p, 'demo:sensitive', 0, 0)
    expect(v.decision).toBe('ask')
  })

  it('first matching rule wins', () => {
    const p = policy({
      rules: [
        { match: 'demo:tool', action: 'deny', reason: 'specific' },
        { match: 'demo:*', action: 'allow' },
      ],
    })
    expect(evaluate(p, 'demo:tool', 0, 0).decision).toBe('deny')
    expect(evaluate(p, 'demo:other', 0, 0).decision).toBe('allow')
  })

  it('default deny blocks unmatched tools', () => {
    const p = policy({ default: 'deny' })
    const v = evaluate(p, 'demo:echo', 0, 0)
    expect(v.decision).toBe('deny')
  })
})
