import type { Policy, ServerConfig } from './config.js'
import { globMatch } from './glob.js'

export type Verdict = {
  decision: 'allow' | 'deny' | 'ask'
  reason: string
  estCost: number
}

export function estimateCost(server: ServerConfig, tool: string): number {
  if (tool in server.prices) return server.prices[tool]
  if ('*' in server.prices) return server.prices['*']
  return 0
}

/**
 * Evaluation order:
 * 1. First matching rule wins for deny.
 * 2. Cost ceilings always apply: max_per_call, then remaining monthly budget.
 * 3. An explicit allow rule is pre-approval: it skips ask_above.
 * 4. With no matching rule, ask_above escalates an allow default to ask.
 */
export function evaluate(
  policy: Policy,
  key: string,
  estCost: number,
  spentThisMonth: number,
): Verdict {
  const rule = policy.rules.find((r) => globMatch(r.match, key))

  if (rule?.action === 'deny') {
    return { decision: 'deny', reason: rule.reason ?? `denied by rule "${rule.match}"`, estCost }
  }

  const maxPerCall = policy.limits.max_per_call
  if (maxPerCall !== undefined && estCost > maxPerCall) {
    return {
      decision: 'deny',
      reason: `estimated cost $${estCost} exceeds max_per_call $${maxPerCall}`,
      estCost,
    }
  }

  if (policy.budget.monthly > 0 && spentThisMonth + estCost > policy.budget.monthly) {
    return {
      decision: 'deny',
      reason: `monthly budget exhausted ($${spentThisMonth.toFixed(4)} spent of $${policy.budget.monthly})`,
      estCost,
    }
  }

  if (rule?.action === 'ask') {
    return { decision: 'ask', reason: rule.reason ?? `rule "${rule.match}" requires approval`, estCost }
  }
  if (rule?.action === 'allow') {
    return { decision: 'allow', reason: `allowed by rule "${rule.match}"`, estCost }
  }

  const askAbove = policy.limits.ask_above
  if (askAbove !== undefined && estCost >= askAbove && policy.default === 'allow') {
    return {
      decision: 'ask',
      reason: `estimated cost $${estCost} is at or above ask_above $${askAbove}`,
      estCost,
    }
  }

  return { decision: policy.default, reason: `default policy: ${policy.default}`, estCost }
}
