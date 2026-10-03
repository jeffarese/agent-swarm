export type SwarmPhase =
  | 'spawning'
  | 'thinking'
  | 'writing'
  | 'tool'
  | 'done'
  | 'failed'
  | 'stopped'

export type SwarmTrailItem = { tool: string; isError: boolean }

/** One row of an agent's activity timeline, as the inspector draws it. */
export type SwarmLogEntry =
  | { kind: 'think' | 'text'; at: number; text: string }
  | {
      kind: 'tool'
      at: number
      id: string
      tool: string
      arg?: string
      status: 'run' | 'ok' | 'error'
      ms?: number
      summary?: string
    }
  | { kind: 'end'; at: number; phase: SwarmPhase; text?: string }

/** Token counts summed over an agent's model responses. */
export type SwarmUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type SwarmAgent = {
  id: string
  description: string
  /** The task the agent was given, cut to a few hundred characters. */
  prompt?: string
  /** Its latest activity, oldest first, capped. */
  log?: SwarmLogEntry[]
  type: string
  name?: string
  model: string
  /** The model id a response reported, when it names a family the configured id (e.g. a Bedrock ARN) does not. */
  servedModel?: string
  effort?: string
  /** 0 unknown, 1 low … 5 max */
  effortLevel: number
  phase: SwarmPhase
  tool?: string
  toolArg?: string
  toolsRunning: number
  tools: number
  steps: number
  trail: SwarmTrailItem[]
  /** Activity per second, 0..4, newest last: tool calls plus stream rate. */
  spark?: number[]
  startedAt: number
  endedAt?: number
  usage?: SwarmUsage
  /** Estimated US dollars at list price, summed over the priced responses. */
  costUsd?: number
  /** Some response's model had no known price, so `costUsd` is a floor. */
  isCostPartial?: boolean
  /** Tokens in the context after the latest response: its prompt plus output. */
  context?: number
  parentId?: string
  isBackground: boolean
  isStub: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'agent-swarm': {
      agents: SwarmAgent[]
      isDismissed: boolean
      isCompact: boolean
      /** The band shows the whole view rather than its squares. */
      isOpen: boolean
      /** The agent the inspector shows; empty for none. */
      selectedId: string
      /** Redraw counters: bumped when what the pane, or the band, shows has changed. */
      paneRev: number
      bandRev: number
      /** How many agents are running; the footer pill draws from it alone. */
      live: number
    }
  }
}
