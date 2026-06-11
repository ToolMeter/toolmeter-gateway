import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { hostname } from 'node:os'
import type { Config, Policy, Principal, ServerConfig } from './config.js'
import { estimateCost, evaluate } from './policy.js'
import { SpendState } from './state.js'
import { ReceiptLog, hashPayload, newReceiptId, type Receipt, type ReceiptBody } from './receipts.js'
import { ReceiptSink } from './sink.js'

type Upstream = {
  config: ServerConfig
  client: Client
  tools: Tool[]
}

type RouteEntry = { upstream: Upstream; tool: Tool }

const STATUS_TOOL: Tool = {
  name: 'toolwarden_status',
  description:
    'Budget and usage status for this ToolWarden gateway: monthly budget, spend so far, calls made, and the receipts file location. Call this before expensive paid tools to check remaining budget.',
  inputSchema: { type: 'object', properties: {} },
}

/**
 * Shared state behind every session: upstream connections, policy, spend,
 * receipts. Stdio mode runs one session; serve mode runs one per client.
 */
export class GatewayCore {
  private upstreams: Upstream[] = []
  private routes = new Map<string, RouteEntry>()
  readonly state: SpendState
  readonly receipts: ReceiptLog
  private policy: Policy
  private prices = new Map<string, ServerConfig['prices']>()
  private sink: ReceiptSink | undefined

  constructor(private config: Config) {
    this.state = new SpendState(config.storage.dir)
    this.receipts = new ReceiptLog(config.storage.dir)
    this.policy = config.policy
    for (const s of config.servers) this.prices.set(s.name, s.prices)
    if (config.sink) {
      this.sink = new ReceiptSink({
        url: config.sink.url,
        token: config.sink.token,
        gateway: config.sink.gateway_id ?? hostname(),
        batchSize: config.sink.batch_size,
        flushMs: config.sink.flush_ms,
        receiptsFile: this.receipts.file,
      })
    }
  }

  private record(body: ReceiptBody): Receipt {
    const receipt = this.receipts.append(body)
    this.sink?.enqueue(receipt)
    return receipt
  }

  get currency(): string {
    return this.policy.budget.currency
  }

  get budgetMonthly(): number {
    return this.policy.budget.monthly
  }

  /** Hot-swap policy and prices from a re-read config. Servers stay as they are. */
  applyConfig(next: Config): void {
    this.policy = next.policy
    this.prices.clear()
    for (const s of next.servers) this.prices.set(s.name, s.prices)
  }

  /** Swap only the policy (central policy_source updates). */
  applyPolicy(policy: Policy): void {
    this.policy = policy
  }

  findPrincipal(token: string): Principal | undefined {
    return this.config.serve.principals.find((p) => p.token === token)
  }

  async connectUpstreams(): Promise<void> {
    for (const sc of this.config.servers) {
      const client = new Client({ name: 'toolwarden-gateway', version: '0.4.0' })
      const transport = sc.url
        ? new StreamableHTTPClientTransport(new URL(sc.url))
        : new StdioClientTransport({
            command: sc.command!,
            args: sc.args,
            env: { ...process.env, ...sc.env } as Record<string, string>,
          })
      await client.connect(transport)
      const { tools } = await client.listTools()
      this.upstreams.push({ config: sc, client, tools })
    }
    this.buildRoutes()
  }

  private buildRoutes(): void {
    this.routes.clear()
    const single = this.upstreams.length === 1
    for (const up of this.upstreams) {
      for (const tool of up.tools) {
        const exposed = single ? tool.name : `${up.config.name}__${tool.name}`
        this.routes.set(exposed, { upstream: up, tool })
      }
    }
  }

  private estimate(server: string, tool: string): number {
    const prices = this.prices.get(server) ?? {}
    return estimateCost({ prices } as ServerConfig, tool)
  }

  exposedTools(): Tool[] {
    return [...this.routes.entries()].map(([exposed, { upstream, tool }]) => {
      const cost = this.estimate(upstream.config.name, tool.name)
      const priceNote = cost > 0 ? ` [ToolWarden: ~$${cost} ${this.currency} per call]` : ''
      return { ...tool, name: exposed, description: `${tool.description ?? ''}${priceNote}` }
    })
  }

  async handleCall(
    principal: Principal,
    askApproval: (message: string) => Promise<boolean>,
    name: string,
    args: Record<string, unknown>,
  ) {
    if (name === 'toolwarden_status') return this.statusResult(principal)

    const route = this.routes.get(name)
    if (!route) {
      return errorResult(`Unknown tool: ${name}`)
    }
    const { upstream, tool } = route
    const key = `${upstream.config.name}:${tool.name}`
    const estCost = this.estimate(upstream.config.name, tool.name)
    // committed includes reservations held by concurrent in-flight calls,
    // so parallel calls cannot jointly overdraw the budget.
    const verdict = evaluate(this.policy, key, estCost, {
      committed: this.state.committedThisMonth(),
      spentMatching: (p) => this.state.spentThisMonthMatching(p),
      callsLastHourMatching: (p) => this.state.callsLastHourMatching(p),
      principal: {
        name: principal.name,
        spent: this.state.spentThisMonthByPrincipal(principal.name),
        monthlyBudget: principal.monthly_budget,
      },
    })

    const base = {
      receipt_id: newReceiptId(),
      ts: new Date().toISOString(),
      principal: principal.name,
      server: upstream.config.name,
      tool: tool.name,
      est_cost: estCost,
      currency: this.currency,
      input_hash: hashPayload(args),
      budget_monthly: this.budgetMonthly,
    }

    let decision: ReceiptBody['decision']
    if (verdict.decision === 'deny') {
      this.record({
        ...base,
        decision: 'deny',
        reason: verdict.reason,
        status: 'blocked',
        latency_ms: null,
        output_hash: null,
        spent_month_after: this.state.spentThisMonth(),
      })
      return errorResult(
        `ToolWarden blocked this call: ${verdict.reason}. ` +
          `Receipt ${base.receipt_id} logged. Adjust policy.yaml to change this.`,
      )
    } else if (verdict.decision === 'ask') {
      const approved = await askApproval(
        `Approve paid tool call ${key} (estimated $${estCost} ${this.currency})? Policy: ${verdict.reason}`,
      )
      decision = approved ? 'ask_approved' : 'ask_denied'
      if (!approved) {
        this.record({
          ...base,
          decision,
          reason: verdict.reason,
          status: 'blocked',
          latency_ms: null,
          output_hash: null,
          spent_month_after: this.state.spentThisMonth(),
        })
        return errorResult(
          `ToolWarden requires approval for this call (${verdict.reason}) and it was not approved. ` +
            `Receipt ${base.receipt_id} logged.`,
        )
      }
    } else {
      decision = 'allow'
    }

    const started = Date.now()
    this.state.reserve(estCost)
    // Rate limits count execution attempts, so a looping agent is stopped
    // even when its calls are free or failing.
    this.state.recordCall(key)
    try {
      const result = await upstream.client.callTool({ name: tool.name, arguments: args })
      const latency = Date.now() - started
      // Meter only successful calls: a tool error is the provider's failure,
      // so the budget is not charged for it.
      this.state.settle(estCost, !result.isError && estCost > 0, key, principal.name)
      this.record({
        ...base,
        decision,
        reason: verdict.reason,
        status: result.isError ? 'error' : 'success',
        latency_ms: latency,
        output_hash: hashPayload(result.content),
        spent_month_after: this.state.spentThisMonth(),
      })
      return result
    } catch (err) {
      this.state.settle(estCost, false, key, principal.name)
      this.record({
        ...base,
        decision,
        reason: verdict.reason,
        status: 'error',
        latency_ms: Date.now() - started,
        output_hash: null,
        spent_month_after: this.state.spentThisMonth(),
      })
      return errorResult(`Upstream tool failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private statusResult(principal: Principal) {
    const spent = this.state.spentThisMonth()
    const principalSpent = this.state.spentThisMonthByPrincipal(principal.name)
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              principal: principal.name,
              budget_monthly: this.budgetMonthly,
              currency: this.currency,
              spent_this_month: spent,
              remaining: this.budgetMonthly > 0 ? Number((this.budgetMonthly - spent).toFixed(10)) : null,
              principal_spent_this_month: principalSpent,
              principal_budget:
                principal.monthly_budget === undefined
                  ? null
                  : {
                      monthly: principal.monthly_budget,
                      remaining: Number((principal.monthly_budget - principalSpent).toFixed(10)),
                    },
              calls_this_month: this.state.callsThisMonth(),
              receipts_file: this.receipts.file,
            },
            null,
            2,
          ),
        },
      ],
    }
  }

  async close(): Promise<void> {
    await this.sink?.close()
    await Promise.allSettled(this.upstreams.map((u) => u.client.close()))
  }
}

export const LOCAL_PRINCIPAL: Principal = { name: 'local', token: 'local-stdio' }

/** One MCP server session bound to a principal, routing into the shared core. */
export function createSessionServer(core: GatewayCore, principal: Principal): Server {
  const server = new Server(
    { name: 'toolwarden-gateway', version: '0.4.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [STATUS_TOOL, ...core.exposedTools()],
  }))
  const askApproval = async (message: string): Promise<boolean> => {
    const caps = server.getClientCapabilities()
    if (!caps?.elicitation) return false
    try {
      const res = await server.elicitInput({
        message,
        requestedSchema: {
          type: 'object',
          properties: {
            approve: { type: 'boolean', title: 'Approve this call' },
          },
          required: ['approve'],
        },
      })
      return res.action === 'accept' && (res.content as { approve?: boolean })?.approve === true
    } catch {
      return false
    }
  }
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    core.handleCall(principal, askApproval, request.params.name, request.params.arguments ?? {}),
  )
  return server
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}
