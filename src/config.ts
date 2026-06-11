import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'

const RuleSchema = z.object({
  match: z.string(),
  action: z.enum(['allow', 'deny', 'ask']),
  reason: z.string().optional(),
  // Scoped to the calls this rule matches, on top of the global budget.
  monthly_budget: z.number().nonnegative().optional(),
  max_calls_per_hour: z.number().int().positive().optional(),
})

const PolicySchema = z.object({
  budget: z
    .object({
      monthly: z.number().nonnegative(),
      currency: z.string().default('USD'),
    })
    .default({ monthly: 0, currency: 'USD' }),
  limits: z
    .object({
      max_per_call: z.number().nonnegative().optional(),
      ask_above: z.number().nonnegative().optional(),
    })
    .default({}),
  rules: z.array(RuleSchema).default([]),
  default: z.enum(['allow', 'deny', 'ask']).default('allow'),
})

const ServerSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'server name must be alphanumeric, dash, or underscore'),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    url: z.string().url().optional(),
    prices: z.record(z.string(), z.number().nonnegative()).default({}),
  })
  .refine((s) => s.command || s.url, {
    message: 'server needs either command (stdio) or url (streamable http)',
  })

const PrincipalSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'principal name must be alphanumeric, dash, or underscore'),
  token: z.string().min(8, 'tokens shorter than 8 characters are too guessable'),
  monthly_budget: z.number().nonnegative().optional(),
})

const ServeSchema = z.object({
  port: z.number().int().positive().default(8484),
  host: z.string().default('127.0.0.1'),
  principals: z.array(PrincipalSchema).default([]),
})

const SinkSchema = z.object({
  url: z.string().url(),
  token: z.string().min(8),
  gateway_id: z.string().regex(/^[a-zA-Z0-9._-]+$/).optional(),
  batch_size: z.number().int().positive().optional(),
  flush_ms: z.number().int().positive().optional(),
})

export const ConfigSchema = z.object({
  policy: PolicySchema.prefault({}),
  storage: z
    .object({
      dir: z.string().default('~/.toolwarden'),
    })
    .default({ dir: '~/.toolwarden' }),
  serve: ServeSchema.prefault({}),
  sink: SinkSchema.optional(),
  servers: z.array(ServerSchema).min(1),
})

export type Config = z.infer<typeof ConfigSchema>
export type Policy = z.infer<typeof PolicySchema>
export type ServerConfig = z.infer<typeof ServerSchema>
export type Rule = z.infer<typeof RuleSchema>
export type Principal = z.infer<typeof PrincipalSchema>
export type SinkConfig = z.infer<typeof SinkSchema>

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2))
  return p
}

// ${VAR} in token values resolves from the environment, so config files
// can be committed without secrets in them.
function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (whole, name) => process.env[name] ?? whole)
}

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, 'utf8')
  const parsed = parse(raw)
  const config = ConfigSchema.parse(parsed)
  for (const principal of config.serve.principals) {
    principal.token = expandEnv(principal.token)
  }
  if (config.sink) {
    config.sink.token = expandEnv(config.sink.token)
  }
  // Relative paths resolve against the config file location, not the process
  // cwd, so the same config works from any directory.
  const base = dirname(resolve(path))
  config.storage.dir = resolve(base, expandHome(config.storage.dir))
  for (const server of config.servers) {
    server.args = server.args.map((a) =>
      a.startsWith('./') || a.startsWith('../') ? resolve(base, a) : a,
    )
  }
  return config
}
