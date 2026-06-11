import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import type { Config, ServerConfig } from './config.js'
import { estimateCost, evaluate } from './policy.js'
import { SpendState } from './state.js'
import { ReceiptLog, hashPayload, newReceiptId, type ReceiptBody } from './receipts.js'

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

export class Gateway {
  readonly server: Server
  private upstreams: Upstream[] = []
  private routes = new Map<string, RouteEntry>()
  private state: SpendState
  private receipts: ReceiptLog

  constructor(private config: Config) {
    this.state = new SpendState(config.storage.dir)
    this.receipts = new ReceiptLog(config.storage.dir)
    this.server = new Server(
      { name: 'toolwarden-gateway', version: '0.1.0' },
      { capabilities: { tools: {} } },
    )
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [STATUS_TOOL, ...this.exposedTools()],
    }))
    this.server.setRequestHandler(CallToolRequestSchema, async (request) =>
      this.handleCall(request.params.name, request.params.arguments ?? {}),
    )
  }

  async connectUpstreams(): Promise<void> {
    for (const sc of this.config.servers) {
      const client = new Client({ name: 'toolwarden-gateway', version: '0.1.0' })
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

  private exposedTools(): Tool[] {
    return [...this.routes.entries()].map(([exposed, { upstream, tool }]) => {
      const cost = estimateCost(upstream.config, tool.name)
      const priceNote = cost > 0 ? ` [ToolWarden: ~$${cost} ${this.config.policy.budget.currency} per call]` : ''
      return { ...tool, name: exposed, description: `${tool.description ?? ''}${priceNote}` }
    })
  }

  private async handleCall(name: string, args: Record<string, unknown>) {
    if (name === 'toolwarden_status') return this.statusResult()

    const route = this.routes.get(name)
    if (!route) {
      return errorResult(`Unknown tool: ${name}`)
    }
    const { upstream, tool } = route
    const key = `${upstream.config.name}:${tool.name}`
    const estCost = estimateCost(upstream.config, tool.name)
    // committed includes reservations held by concurrent in-flight calls,
    // so parallel calls cannot jointly overdraw the budget.
    const verdict = evaluate(this.config.policy, key, estCost, {
      committed: this.state.committedThisMonth(),
      spentMatching: (p) => this.state.spentThisMonthMatching(p),
      callsLastHourMatching: (p) => this.state.callsLastHourMatching(p),
    })

    const base = {
      receipt_id: newReceiptId(),
      ts: new Date().toISOString(),
      server: upstream.config.name,
      tool: tool.name,
      est_cost: estCost,
      currency: this.config.policy.budget.currency,
      input_hash: hashPayload(args),
      budget_monthly: this.config.policy.budget.monthly,
    }

    let decision: ReceiptBody['decision']
    if (verdict.decision === 'deny') {
      this.receipts.append({
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
      const approved = await this.askApproval(key, estCost, verdict.reason)
      decision = approved ? 'ask_approved' : 'ask_denied'
      if (!approved) {
        this.receipts.append({
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
      this.state.settle(estCost, !result.isError && estCost > 0, key)
      this.receipts.append({
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
      this.state.settle(estCost, false, key)
      this.receipts.append({
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

  private async askApproval(key: string, estCost: number, reason: string): Promise<boolean> {
    const caps = this.server.getClientCapabilities()
    if (!caps?.elicitation) return false
    try {
      const res = await this.server.elicitInput({
        message: `Approve paid tool call ${key} (estimated $${estCost} ${this.config.policy.budget.currency})? Policy: ${reason}`,
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

  private statusResult() {
    const budget = this.config.policy.budget
    const spent = this.state.spentThisMonth()
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              budget_monthly: budget.monthly,
              currency: budget.currency,
              spent_this_month: spent,
              remaining: budget.monthly > 0 ? Number((budget.monthly - spent).toFixed(10)) : null,
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
    await Promise.allSettled(this.upstreams.map((u) => u.client.close()))
  }
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}
