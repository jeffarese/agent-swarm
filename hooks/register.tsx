import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput, Timer } from 'claude-code'

import type { SwarmAgent, SwarmLogEntry, SwarmPhase, SwarmTrailItem } from '../types'
import {
  AUTO_CLOSE_CHOICES,
  CORE_ROWS,
  addUsage,
  appendLog,
  autoCloseMs,
  costLabel,
  duration,
  fitParts,
  head,
  pillFrame,
  pillText,
  resultSummary,
  tail,
  usageParts,
  usd,
  effortCells,
  effortColor,
  clock,
  coreFrame,
  effortLabel,
  effortLevel,
  hex,
  isLightTheme,
  isLive,
  modelFamily,
  packCells,
  phaseColor,
  ramp,
  setLightTheme,
  shortModel,
  sparkFrame,
  sparkText,
  toolArg,
  toolGlyph,
  trailFrame,
  type Canvas,
} from './core'
import { DEMO, playDemo } from './demo'
import { count, perfReport, record, resetPerf } from './perf'

const TICK_MS = 80
const MIN_CARD = 30
const GAP = 1

const agentsRef = { plugin: 'agent-swarm', key: 'agents' } as const
const agentsAtom = atom(agentsRef, [])
// Drawings subscribe to these small values, not to the list: a change of the list
// bumps only the counters whose drawing it shows in.
const paneRevRef = { plugin: 'agent-swarm', key: 'paneRev' } as const
const paneRevAtom = atom(paneRevRef, 0)
const bandRevRef = { plugin: 'agent-swarm', key: 'bandRev' } as const
const bandRevAtom = atom(bandRevRef, 0)
const liveRef = { plugin: 'agent-swarm', key: 'live' } as const
const liveAtom = atom(liveRef, 0)
const dismissedAtom = atom({ plugin: 'agent-swarm', key: 'isDismissed' } as const, false)
/** The band shows the whole view (header, agents, inspector) rather than its squares. */
const openAtom = atom({ plugin: 'agent-swarm', key: 'isOpen' } as const, false)
const compactAtom = atom({ plugin: 'agent-swarm', key: 'isCompact' } as const, true)
const selectedAtom = atom({ plugin: 'agent-swarm', key: 'selectedId' } as const, '')

const BADGE: Partial<Record<SwarmPhase, string>> = {
  spawning: 'START',
  thinking: 'THINK',
  writing: 'WRITE',
  tool: 'TOOL',
}
const BADGE_INK = '#0f0f14'
// Theme keys, so chrome follows Claude Code's theme.
const COST_COLOR = 'warning'
const BRAND = 'claude'
const PILL_COLOR = '#b39dff'
/** The frame the open view draws around itself: a border and a column of padding a side. */
const FRAME = 4
const SPARK_KEEP = 600
/** The list is the module's own; state keeps a copy this often, so a reload picks up where it was. */
const PERSIST_MS = 2000
/** Timeline rows the inspector shows; older ones fold into `+N earlier`. */
const INSPECT_ROWS = 14
/** Animation ticks between redraws of a streaming block in the inspector. */
const STREAM_REDRAW_TICKS = 3
/** Ticks a redraw for a change that can wait (a step, a tool call, a sample) is held to. */
const SOON_TICKS = 3
/** Core Rasters blitted a tick at most; past it they take turns, so a big swarm costs what a few do. */
const CORES_PER_TICK = 6
/** A card's body rows: heading, core, spark, description, activity, cost, trail. */
const CARD_ROWS = 4 + CORE_ROWS + 2
const LINE_ROWS = 3
const SQUARE = 20
const SQUARE_ROWS = 5

const PHASE_GLYPH: Record<SwarmPhase, string> = {
  spawning: '◌',
  thinking: '✻',
  writing: '✎',
  tool: '▸',
  done: '✓',
  failed: '✕',
  stopped: '■',
}

const coreKeys = new Map<string, string>()
const coreKey = (id: string): string => {
  let key = coreKeys.get(id)
  if (key === undefined) {
    key = `core-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`
    coreKeys.set(id, key)
  }

  return key
}

/** A family name; an opaque id (a Bedrock ARN) only shows once a response names its model. */
const modelOf = (a: SwarmAgent): string | undefined =>
  modelFamily(a.servedModel) ??
  modelFamily(a.model) ??
  (a.model === '' || a.model.startsWith('arn:') ? undefined : shortModel(a.model))

/** `opus@high`: the card's heading; falls back to the agent's name before its model is known. */
const headingParts = (a: SwarmAgent): { lead: string; effort: string } => ({
  lead: `${a.parentId ? '↳ ' : ''}${PHASE_GLYPH[a.phase]} ${modelOf(a) ?? a.name ?? a.type}`,
  effort: modelOf(a) !== undefined && a.effort !== undefined ? `@${effortLabel(a.effort, a.effortLevel)}` : '',
})

/** What a plain Button with a hotkey takes across: `1: label`. */
const buttonWidth = (label: string, hasHotkey: boolean) => label.length + (hasHotkey ? 3 : 0)

const blank = (id: string, now: number): SwarmAgent => ({
  id,
  description: '',
  type: 'agent',
  model: '',
  effortLevel: 0,
  phase: 'spawning',
  toolsRunning: 0,
  tools: 0,
  steps: 0,
  trail: [],
  startedAt: now,
  isBackground: false,
  isStub: true,
})

/** Live cards first (oldest first), then finished ones (latest first). */
const ordered = (list: readonly SwarmAgent[]): SwarmAgent[] => [
  ...list.filter(a => isLive(a.phase)).sort((a, b) => a.startedAt - b.startedAt),
  ...list
    .filter(a => !isLive(a.phase))
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)),
]

// Module-local: the agents (copied to state every PERSIST_MS and read back
// after a reload), stream energy per agent, and the Rasters drawn last.
let snapshot: readonly SwarmAgent[] = []
let restoring: Promise<void> | undefined
let isPersistDue = false
let bandSig = ''
let lastLive = -1
let tick = 0
let isBlitting = false
let batchStart = 0
const energy = new Map<string, number>()
/** Tool calls since the last sparkline sample, per agent. */
const toolHits = new Map<string, number>()
/** A mounted core Raster: its size, the canvas it is drawn from and the cells it shows. */
type Core = { columns: number; rows: number; canvas?: Canvas; cells?: string; drawn?: string }
/** Per drawing site (the band's instance): agent id → its core Raster. */
const mounted = new Map<string, Map<string, Core>>()
let bandSite: string | undefined
/** The band instance drawing the open view, while it does. */
let fullSite: string | undefined
const isFullShown = (): boolean => fullSite !== undefined && mounted.has(fullSite)
/** The footer pill's site and text, while drawn. */
let pill: { requestId: string; text: string; canvas?: Canvas; cells?: string } | undefined
const pending = new Set<string>()
const ignored = new Set<string>()
/** Agents whose current turn has reported usage step by step (so turn.complete adds none). */
const steppedUsage = new Set<string>()

/** The block each agent is streaming now; it joins the log once whole. */
type Stream = { kind: 'think' | 'text'; index: number; at: number; text: string }
const streams = new Map<string, Stream>()
/** Mirror of the selection, so the stream knows when its text is on screen. */
let shownId = ''
let isStreamDirty = false

let autoCloseDelay = 0
/** When the open view folds itself, once every agent has finished; undefined while none is due. */
let closeAt: number | undefined
/** The person chose to keep the view open until the next batch of agents. */
let isHeld = false

const totalCost = (list: readonly SwarmAgent[]): number | undefined =>
  list.some(a => a.costUsd !== undefined)
    ? list.reduce((n, a) => n + (a.costUsd ?? 0), 0)
    : undefined

async function syncLive($: EngineInterface, list: readonly SwarmAgent[]) {
  let live = 0
  for (const a of list) if (isLive(a.phase)) live++
  if (live === lastLive) return
  const wasLive = lastLive > 0
  lastLive = live
  count('state.write')
  const wrote = $.state.set(liveRef, live).catch(() => undefined)
  if (live > 0) {
    closeAt = undefined
    isHeld = false
    wake($)
  } else if (wasLive && autoCloseDelay > 0 && !isHeld && shownId === '' && isFullShown()) {
    closeAt = (await $.clock.now()) + autoCloseDelay
    wake($)
  }
  await wrote
}

// Each period of a timer is a dispatch, so they run only while there is work:
// an agent live, a countdown due, or a held redraw. An idle session wakes for nothing.
let frameTimer: Timer | undefined
let secondTimer: Timer | undefined

function wake($: EngineInterface) {
  frameTimer ??= $.clock.every(TICK_MS, () => void animate($).catch(() => undefined))
  secondTimer ??= $.clock.every(1000, () => {
    void sample($)
      .then(() => flushDue($, true))
      .then(() => countdown($))
      .then(() => {
        if (lastLive > 0 || closeAt !== undefined || revs.pane.isDue || revs.band.isDue) return
        secondTimer?.cancel()
        secondTimer = undefined
      })
      .catch(() => undefined)
  })
}

/** Reads the agents back from state once, after a load; every reader and writer waits on it. */
function restore($: EngineInterface): Promise<void> {
  restoring ??= (async () => {
    const [list, pane, band] = await Promise.all([read($, agentsAtom), read($, paneRevAtom), read($, bandRevAtom)])
    // A reload ends a demo mid-way; its agents would stay live forever.
    snapshot = list.filter(a => !(a.id.startsWith(DEMO_PREFIX) && isLive(a.phase)))
    revs.pane.n = pane
    revs.band.n = band
    bandSig = bandSignature(list)
  })()

  return restoring
}

/**
 * A redraw counter: bumps made while its write is in flight share one trailing
 * write, and one that can wait is held until SOON_TICKS after the last.
 */
type Rev = { n: number; at: number; isDue: boolean; flight?: Promise<void>; queued?: Promise<void> }
const revs: Record<'pane' | 'band', Rev> = {
  pane: { n: 0, at: -Infinity, isDue: false },
  band: { n: 0, at: -Infinity, isDue: false },
}

function bump($: EngineInterface, which: 'pane' | 'band', { soon = false } = {}): Promise<void> {
  const rev = revs[which]
  if (soon && tick - rev.at < SOON_TICKS) {
    rev.isDue = true
    wake($)

    return Promise.resolve()
  }
  rev.at = tick
  rev.isDue = false
  rev.n += 1
  if (rev.queued !== undefined) return rev.queued
  const send = (): Promise<void> => {
    count('state.write')
    const wrote = which === 'pane' ? $.state.set(paneRevRef, rev.n) : $.state.set(bandRevRef, rev.n)
    const p = wrote.then(
      () => undefined,
      () => undefined,
    )
    rev.flight = p
    void p.then(() => {
      if (rev.flight === p) rev.flight = undefined
    })

    return p
  }
  if (rev.flight === undefined) return send()
  rev.queued = rev.flight.then(() => {
    rev.queued = undefined

    return send()
  })

  return rev.queued
}

const bandParts = new WeakMap<SwarmAgent, string>()

/** Everything the band draws, so a change it does not show leaves it be. */
function bandSignature(list: readonly SwarmAgent[]): string {
  let sig = String(batchStart)
  for (const a of list) {
    let part = bandParts.get(a)
    if (part === undefined) {
      part = `${a.id}:${a.phase}:${a.name ?? a.type}:${a.effortLevel}:${a.phase === 'tool' ? a.tool : ''}:${costLabel(a) ?? a.tools}:${a.endedAt ?? ''}`
      bandParts.set(a, part)
    }
    sig += `|${part}`
  }

  return sig
}

function refreshBand($: EngineInterface, soon = false): Promise<void> {
  const sig = bandSignature(snapshot)
  if (sig === bandSig) return Promise.resolve()
  bandSig = sig

  return bump($, 'band', { soon })
}

/** Sends the held redraws whose wait is over; `isLate` (the one-second timer) sends them all. */
function flushDue($: EngineInterface, isLate = false) {
  for (const which of ['pane', 'band'] as const) {
    const rev = revs[which]
    if (rev.isDue && (isLate || tick - rev.at >= SOON_TICKS)) void bump($, which)
  }
}

function persistSoon($: EngineInterface) {
  if (isPersistDue) return
  isPersistDue = true
  $.clock.after(PERSIST_MS, () => {
    isPersistDue = false
    count('persist')
    $.state.set(agentsRef, [...snapshot]).catch(() => undefined)
  })
}

/**
 * Applies `change` to the agents and redraws what shows it. `logOf`: the change
 * is only to that agent's timeline, which only the inspector shows. `soon`: the
 * redraw can wait a few ticks, folding into the next.
 */
async function mutate(
  $: EngineInterface,
  change: (list: readonly SwarmAgent[]) => readonly SwarmAgent[],
  { logOf, soon = false }: { logOf?: string; soon?: boolean } = {},
): Promise<readonly SwarmAgent[]> {
  await restore($)
  snapshot = change(snapshot)
  count('mutate')
  persistSoon($)
  const list = snapshot
  const writes = [syncLive($, list), refreshBand($, soon)]
  if (isFullShown() && (logOf === undefined || logOf === shownId)) writes.push(bump($, 'pane', { soon }))
  await Promise.all(writes)

  return list
}

/** Once a second while a close is due: redraw the countdown, or close when it runs out. */
async function countdown($: EngineInterface) {
  if (closeAt === undefined) return
  if (!isFullShown()) {
    closeAt = undefined

    return
  }
  if ((await $.clock.now()) < closeAt) {
    await bump($, 'pane')

    return
  }
  await closeView($, false)
  $.ui.toast('Agents view folded · /swarm to reopen')
}

function keepOpen($: EngineInterface) {
  closeAt = undefined
  isHeld = true
  void bump($, 'pane')
}

/** A change to one agent while it works: its redraw can wait a few ticks. */
function patch($: EngineInterface, id: string, change: (a: SwarmAgent) => SwarmAgent) {
  return mutate($, list => list.map(a => (a.id === id ? change(a) : a)), { soon: true })
}

const log = ($: EngineInterface, id: string, entry: SwarmLogEntry) =>
  mutate($, list => list.map(a => (a.id === id ? { ...a, log: appendLog(a.log, entry) } : a)), { logOf: id, soon: true })

/** Moves the block an agent was streaming into its log. */
async function commitStream($: EngineInterface, id: string) {
  const s = streams.get(id)
  if (s === undefined) return
  streams.delete(id)
  if (s.text.trim() !== '') await log($, id, { kind: s.kind, at: s.at, text: head(s.text, 600) })
}

/** Unfolds the band into the whole view; unasked (a spawn) only if the person has not folded it. */
async function openView($: EngineInterface, isAsked: boolean) {
  if (isAsked) {
    await update($, dismissedAtom, () => false)
  } else if (await read($, dismissedAtom)) {
    return
  }
  await update($, openAtom, () => true)
}

/** Folds the view back to the band's squares; the person's fold holds until they ask again. */
async function closeView($: EngineInterface, byPerson: boolean) {
  closeAt = undefined
  if (byPerson) await update($, dismissedAtom, () => true)
  await update($, openAtom, () => false)
}

/**
 * Shows `id` in the inspector (pressing the shown one again hides it), and
 * brings the inspector into view once drawn. Looking at an agent holds the view open.
 */
async function select($: EngineInterface, id: string, { toggle = true, open = false } = {}) {
  shownId = await update($, selectedAtom, cur => (toggle && cur === id ? '' : id))
  if (shownId !== '') closeAt = undefined
  if (open) await openView($, true)
  if (shownId !== '') {
    $.clock.after(60, () => {
      if (fullSite === undefined) return
      void $.ui.scroll({ in: fullSite, to: { key: 'inspector' }, block: 'nearest' }).catch(() => undefined)
    })
  }
}

/** Whether an agent loop is one we show, adding its card when first seen. */
async function ensure($: EngineInterface, id: string): Promise<boolean> {
  await restore($)
  if (snapshot.some(a => a.id === id)) return true
  if (ignored.has(id)) return false
  const now = await $.clock.now()
  if (pending.size > 0) {
    // Its spawn is still settling: hold a card the spawn will fill in.
    await mutate($, list => (list.some(a => a.id === id) ? list : [...list, blank(id, now)]))

    return true
  }
  const info = (await $.agent.list()).find(a => a.id === id)
  if (info === undefined) {
    ignored.add(id)

    return false
  }
  await mutate($, list =>
    list.some(a => a.id === id)
      ? list
      : [
          ...list,
          {
            ...blank(id, now),
            description: info.description,
            type: info.type,
            name: info.name,
            parentId: info.parentId,
            isStub: false,
          },
        ],
  )

  return true
}

// ── what agents do: the hooks below and the demo report through these ──

type ApiUsage = Parameters<typeof addUsage>[1]
type Card = Pick<SwarmAgent, 'description' | 'prompt' | 'type' | 'name' | 'model' | 'parentId' | 'isBackground'>

async function addCard($: EngineInterface, id: string, card: Card) {
  const now = await $.clock.now()
  await mutate($, list => [...list.filter(a => a.id !== id), { ...blank(id, now), ...card, isStub: false }])
  openView($, false).catch(() => undefined)
}

function stepStarted($: EngineInterface, id: string, effort: string | number | undefined, model: string) {
  return patch($, id, a => ({
    ...a,
    phase: a.toolsRunning > 0 ? 'tool' : 'thinking',
    effort: effort === undefined ? a.effort : String(effort),
    effortLevel: effort === undefined ? a.effortLevel : effortLevel(effort),
    model,
    steps: a.steps + 1,
    endedAt: undefined,
  }))
}

/** One streamed chunk of a step; resolves the phase the step is in after it. */
async function streamed(
  $: EngineInterface,
  id: string,
  chunk: { kind: 'text' | 'thinking'; index: number; text: string },
  phase: SwarmPhase,
): Promise<SwarmPhase> {
  energy.set(id, Math.min(1, (energy.get(id) ?? 0) + 0.06))
  const kind = chunk.kind === 'text' ? 'text' : 'think'
  const cur = streams.get(id)
  if (cur === undefined || cur.kind !== kind || cur.index !== chunk.index) {
    await commitStream($, id)
    streams.set(id, { kind, index: chunk.index, at: await $.clock.now(), text: chunk.text })
  } else {
    cur.text += chunk.text
  }
  if (id === shownId) isStreamDirty = true
  const now: SwarmPhase = chunk.kind === 'text' ? 'writing' : 'thinking'
  if (now !== phase) await patch($, id, a => (a.toolsRunning > 0 ? a : { ...a, phase: now }))

  return now
}

async function responded($: EngineInterface, id: string, usage: ApiUsage & { model: string }, model: string) {
  await commitStream($, id)
  steppedUsage.add(id)
  await patch($, id, a => ({
    ...a,
    ...addUsage(a, usage, [usage.model, model]),
    servedModel: modelFamily(usage.model) === undefined ? a.servedModel : usage.model,
  }))
}

/** A tool call starting; resolves when it started, for `toolEnded`. */
async function toolStarted($: EngineInterface, id: string, toolUseId: string, tool: string, arg: string | undefined) {
  const startedAt = await $.clock.now()
  await patch($, id, a => ({
    ...a,
    phase: 'tool',
    tool,
    toolArg: arg,
    toolsRunning: a.toolsRunning + 1,
    tools: a.tools + 1,
    log: appendLog(a.log, { kind: 'tool', at: startedAt, id: toolUseId, tool, arg, status: 'run' }),
  }))
  toolHits.set(id, (toolHits.get(id) ?? 0) + 1)

  return startedAt
}

async function toolEnded(
  $: EngineInterface,
  id: string,
  toolUseId: string,
  tool: string,
  startedAt: number,
  isError: boolean,
  summary: string | undefined,
) {
  const ms = (await $.clock.now()) - startedAt
  await patch($, id, a => {
    const running = Math.max(0, a.toolsRunning - 1)

    return {
      ...a,
      toolsRunning: running,
      phase: a.phase === 'tool' && running === 0 ? 'thinking' : a.phase,
      trail: [...a.trail, { tool, isError }].slice(-32),
      log: (a.log ?? []).map(en =>
        en.kind === 'tool' && en.id === toolUseId ? { ...en, status: isError ? 'error' : 'ok', ms, summary } : en,
      ),
    }
  })
}

async function completed(
  $: EngineInterface,
  id: string,
  reason: string,
  answer: string,
  turnUsage: (ApiUsage & { model: string }) | undefined,
) {
  await commitStream($, id)
  const now = await $.clock.now()
  const phase: SwarmPhase = reason === 'answer' ? 'done' : reason === 'aborted' ? 'stopped' : 'failed'
  const usage = steppedUsage.has(id) ? undefined : turnUsage
  const text = answer.trim() === '' ? undefined : head(answer, 600)
  await patch($, id, a => ({
    ...a,
    ...(usage === undefined ? {} : addUsage(a, usage, [usage.model, a.model])),
    phase,
    toolsRunning: 0,
    tool: undefined,
    toolArg: undefined,
    endedAt: now,
    log: appendLog(a.log, { kind: 'end', at: now, phase, text }),
  }))
  steppedUsage.delete(id)
  energy.delete(id)
}

// ── the demo: a scripted swarm through the same paths ──────────────────

const DEMO_PREFIX = 'demo-'
const DEMO_TICK_MS = 50
let isDemoRunning = false

/** One timer wakes every demo sleeper that is due, rather than a timer per sleep. */
async function startDemo($: EngineInterface) {
  isDemoRunning = true
  let now = await $.clock.now()
  let waits: { at: number; go: () => void }[] = []
  const timer = $.clock.every(DEMO_TICK_MS, () => {
    void $.clock.now().then(t => {
      now = t
      const due = waits.filter(w => w.at <= t)
      waits = waits.filter(w => w.at > t)
      for (const w of due) w.go()
    })
  })
  const sleep = (ms: number) => new Promise<void>(go => waits.push({ at: now + ms, go }))
  await openView($, true)
  void playDemo(
    {
      spawn: (id, card) => addCard($, id, card),
      step: (id, effort, model) => stepStarted($, id, effort, model),
      stream: (id, chunk, phase) => streamed($, id, chunk, phase),
      respond: (id, usage, model) => responded($, id, usage, model),
      toolStart: (id, useId, tool, arg) => toolStarted($, id, useId, tool, arg),
      toolEnd: (id, useId, tool, startedAt, isError, summary) => toolEnded($, id, useId, tool, startedAt, isError, summary),
      complete: (id, reason, answer) => completed($, id, reason, answer, undefined),
    },
    sleep,
    now.toString(36),
  )
    .catch(() => undefined)
    .finally(() => {
      timer.cancel()
      isDemoRunning = false
    })
}

/** Once a second: one sparkline sample per live agent. */
/** Sparklines and elapsed clocks show only in the open view, so a sample redraws nothing else. */
async function sample($: EngineInterface) {
  await restore($)
  if (!snapshot.some(a => isLive(a.phase))) return
  const levels = new Map<string, number>()
  for (const a of snapshot) {
    if (!isLive(a.phase)) continue
    const hits = toolHits.get(a.id) ?? 0
    const stream = energy.get(a.id) ?? 0
    const base = a.phase === 'spawning' ? 0 : 0.6
    levels.set(a.id, Math.max(0, Math.min(4, Math.round(base + hits * 1.5 + stream * 3.5))))
    toolHits.set(a.id, 0)
  }
  snapshot = snapshot.map(a => {
    const level = levels.get(a.id)
    if (level === undefined || !isLive(a.phase)) return a
    const spark = (a.spark ?? []).slice(-(SPARK_KEEP - 1))
    spark.push(level)

    return { ...a, spark }
  })
  persistSoon($)
  if (isFullShown()) await bump($, 'pane', { soon: true })
}

async function animate($: EngineInterface) {
  if (isBlitting) return
  const live = snapshot.filter(a => isLive(a.phase))
  if (live.length === 0) {
    frameTimer?.cancel()
    frameTimer = undefined

    return
  }
  isBlitting = true
  const t0 = performance.now()
  tick += 1
  if (isStreamDirty && tick % STREAM_REDRAW_TICKS === 0 && isFullShown()) {
    isStreamDirty = false
    void bump($, 'pane', { soon: true })
  }
  flushDue($)
  try {
    const blits: Promise<void>[] = []
    // The pill's spinner turns every other tick, and its sweep reads as smooth at that rate.
    if (pill !== undefined && tick % 2 === 0) {
      const p = pill
      p.canvas = pillFrame(p.text, tick, p.canvas)
      const cells = packCells(p.canvas)
      if (cells !== p.cells) {
        p.cells = cells
        blits.push(
          $.ui.blit({ requestId: p.requestId, key: 'swarm-pill', cells, columns: p.text.length + 2, rows: 1 }).then(r => {
            if (r.deny !== undefined && pill === p) pill = undefined
          }),
        )
      }
    }
    const turns: { site: string; cores: Map<string, Core>; a: SwarmAgent; core: Core }[] = []
    for (const [site, cores] of mounted) {
      for (const a of live) {
        const core = cores.get(a.id)
        if (core !== undefined) turns.push({ site, cores, a, core })
      }
    }
    const stride = Math.ceil(turns.length / CORES_PER_TICK)
    for (let i = 0; i < turns.length; i++) {
      if (stride > 1 && (i + tick) % stride !== 0) continue
      const { site, cores, a, core } = turns[i]!
      const cells = drawCore(core, a)
      // A frame like the one shown (a slow breath, a stalled stream) costs no blit.
      if (cells === core.cells) {
        count('blit.same')
        continue
      }
      core.cells = cells
      blits.push(
        $.ui
          .blit({ requestId: site, key: coreKey(a.id), cells, columns: core.columns, rows: core.rows })
          .then(r => {
            if (r.deny !== undefined) cores.delete(a.id)
          }),
      )
    }
    count('blit', blits.length)
    record('tick', performance.now() - t0)
    await Promise.all(blits)
  } finally {
    isBlitting = false
    for (const [id, v] of energy) energy.set(id, v * 0.9)
  }
}

/** What an agent's core shows this tick, drawn at most once a tick into its own canvas. */
function drawCore(core: Core, a: SwarmAgent): string {
  const key = `${tick}|${a.phase}|${a.effortLevel}|${isLightTheme()}`
  if (core.drawn === key && core.canvas !== undefined) return packCells(core.canvas)
  core.canvas = coreFrame(a, core.columns, tick, energy.get(a.id) ?? 0, core.rows, core.canvas)
  core.drawn = key

  return packCells(core.canvas)
}

/** Finished agents' frames, which change only with the agent: by agent object, then size and theme. */
const stillFrames = new WeakMap<SwarmAgent, Map<string, string>>()
const sparkFrames = new WeakMap<readonly number[], Map<string, string>>()

function memo<K extends object>(cache: WeakMap<K, Map<string, string>>, on: K, key: string, draw: () => string): string {
  let byKey = cache.get(on)
  if (byKey === undefined) {
    byKey = new Map()
    cache.set(on, byKey)
  }
  let cells = byKey.get(key)
  if (cells === undefined) {
    cells = draw()
    byKey.set(key, cells)
  }

  return cells
}

/**
 * The cells a site's render hands an agent's core Raster: a live one keeps its
 * canvas in `cores` for the animation, which this tick's frame reuses.
 */
function coreCells(prev: Map<string, Core> | undefined, cores: Map<string, Core>, a: SwarmAgent, columns: number, rows: number): string {
  if (!isLive(a.phase)) {
    return memo(stillFrames, a, `${columns}x${rows}|${isLightTheme()}`, () => packCells(coreFrame(a, columns, tick, 0, rows)))
  }
  const old = prev?.get(a.id)
  const core: Core = old !== undefined && old.columns === columns && old.rows === rows ? old : { columns, rows }
  cores.set(a.id, core)
  core.cells = drawCore(core, a)

  return core.cells
}

const sparkCells = (spark: readonly number[], columns: number, phase: SwarmPhase): string =>
  memo(sparkFrames, spark, `${columns}|${phase}|${isLightTheme()}`, () => packCells(sparkFrame(spark, columns, phase)))

const NO_SPARK: readonly number[] = []

/**
 * A finished agent's drawn card or line, which changes only with the agent object
 * (every change makes a new one) or with what `key` names: size, place, selection, theme.
 */
const finishedViews = new WeakMap<SwarmAgent, { key: string; view: unknown }>()
function finishedView<T>(a: SwarmAgent, key: string, draw: () => T): T {
  if (isLive(a.phase)) return draw()
  const hit = finishedViews.get(a)
  if (hit !== undefined && hit.key === key) return hit.view as T
  const view = draw()
  finishedViews.set(a, { key, view })

  return view
}

/** The inspector's settled rows (a finished tool call, a thought, the end), by entry and layout. */
const entryViews = new WeakMap<SwarmLogEntry, { key: string; view: unknown }>()
function entryView<T>(en: SwarmLogEntry, key: string, draw: () => T): T {
  if (en.kind === 'tool' && en.status === 'run') return draw()
  const hit = entryViews.get(en)
  if (hit !== undefined && hit.key === key) return hit.view as T
  const view = draw()
  entryViews.set(en, { key, view })

  return view
}

const trailFrames = new WeakMap<readonly SwarmTrailItem[], Map<string, string>>()
const trailCells = (trail: readonly SwarmTrailItem[], all: readonly SwarmTrailItem[]): string =>
  memo(trailFrames, all, String(trail.length), () => packCells(trailFrame(trail)))

// ── the open view: header, every agent, the inspector, framed in the band ─

async function drawFull($: EngineInterface, e: RenderInput<'AbovePrompt'>) {
  const t0 = performance.now()
  try {
    const { Box, Text, Button } = $.ui.resolve(e)
    const Raster = e.surface === 'terminal' ? $.ui.resolve(e).Raster : undefined
    const Client = e.surface === 'terminal' ? $.ui.resolve(e).Client : undefined
    /** A transparent region over the whole agent, last so it is on top: a click anywhere picks it. */
    const hitArea = (a: SwarmAgent, columns: number, rows: number, inset = 1) =>
      Client === undefined ? null : (
        <Box position="absolute" top={-inset} left={-inset}>
          <Client key={`hit-${coreKey(a.id)}`} module="./hit-area.tsx" props={{ id: a.id }} width={columns} height={rows} />
        </Box>
      )
    const [, isCompact, selectedId, now] = await Promise.all([
      read($, paneRevAtom),
      read($, compactAtom),
      read($, selectedAtom),
      $.clock.now(),
      restore($),
    ])
    const list = ordered(snapshot)
    const selected = list.find(a => a.id === selectedId)
    shownId = selected?.id ?? ''

    const bodyColumns = Math.max(8, e.props.bodyColumns - FRAME)
    const width = Math.max(MIN_CARD, bodyColumns)
    const perRow = Math.max(1, Math.min(Math.floor((width + GAP) / (MIN_CARD + GAP)), list.length || 1))
    const cardWidth = Math.floor((width - GAP * (perRow - 1)) / perRow)
    const inner = Math.max(8, cardWidth - 4)

    const live = list.filter(a => isLive(a.phase)).length
    const done = list.filter(a => a.phase === 'done').length
    const failed = list.filter(a => a.phase === 'failed' || a.phase === 'stopped').length
    const tools = list.reduce((n, a) => n + a.tools, 0)
    const cost = totalCost(list)
    const isNarrow = bodyColumns < 64
    const closesIn = closeAt === undefined ? undefined : Math.max(0, Math.ceil((closeAt - now) / 1000))

    const prevCores = mounted.get(e.requestId)
    const cores = new Map<string, Core>()
    const surfaceKey = `${e.surface}|${isLightTheme()}`
    fullSite = e.requestId
    mounted.set(e.requestId, cores)

    const heading = (a: SwarmAgent, width?: number) => {
      const isOn = isLive(a.phase)
      const { lead, effort } = headingParts(a)

      return (
        <Box width={width} flexShrink={1}>
          <Text bold={isOn} dimColor={!isOn} color={phaseColor(a.phase)} wrap="truncate-end">
            {lead}
            {effort !== '' && <Text color={effortColor(a.effortLevel)}>{effort}</Text>}
          </Text>
        </Box>
      )
    }

    const badgeOf = (a: SwarmAgent) => {
      const badge = BADGE[a.phase]

      return badge !== undefined ? (
        <Text bold color={BADGE_INK} backgroundColor={phaseColor(a.phase)}>
          {` ${badge} `}
        </Text>
      ) : (
        <Text dimColor>{a.phase.toUpperCase()}</Text>
      )
    }

    /** The agent's description as the control that opens it in the inspector; 1–9 press it. */
    const picker = (a: SwarmAgent, i: number, room: number) => {
      const hotkey = i < 9 ? String(i + 1) : undefined
      const isShown = a.id === selected?.id

      return (
        <Button
          key={`pick-${a.id}`}
          label={head(a.description || a.name || a.type, Math.max(4, room - (hotkey === undefined ? 0 : 3)))}
          hotkey={hotkey}
          plain
          dimColor={!isLive(a.phase) && !isShown}
          onPress={() => void select($, a.id)}
        />
      )
    }

    const borderOf = (a: SwarmAgent) => {
      const isOn = isLive(a.phase)
      const isShown = a.id === selected?.id

      return {
        borderStyle: isShown ? 'bold' : 'round',
        borderColor: isOn || isShown ? phaseColor(a.phase) : hex(ramp(a.phase)[2]),
        borderDimColor: !isOn && !isShown,
        hover: { borderColor: hex(ramp(a.phase)[4]), borderDimColor: false },
      }
    }

    // Compact: one line per agent, headings padded to one width so the animations line up.
    const BADGE_W = 7
    const headW = Math.min(
      Math.floor(width / 3),
      Math.max(0, ...list.map(a => headingParts(a)).map(p => p.lead.length + p.effort.length)),
    )
    const lineCore = Math.max(4, width - headW - BADGE_W - 2)

    const activityOf = (a: SwarmAgent, elapsed: number): string => {
      switch (a.phase) {
        case 'tool':
          return `▸ ${a.tool ?? 'tool'}${a.toolArg ? `  ${a.toolArg}` : ''}`
        case 'thinking':
          return `✻ thinking · step ${a.steps}`
        case 'writing':
          return `✎ writing · step ${a.steps}`
        case 'spawning':
          return `◌ starting${a.isBackground ? ' in background' : ''}…`
        default:
          return `${PHASE_GLYPH[a.phase]} ${a.phase} in ${clock(elapsed)} · ${a.steps} step${a.steps === 1 ? '' : 's'}`
      }
    }

    const line = (a: SwarmAgent, i: number) => {
      const isOn = isLive(a.phase)
      let core
      if (Raster !== undefined) {
        core = <Raster key={coreKey(a.id)} columns={lineCore} rows={1} cells={coreCells(prevCores, cores, a, lineCore, 1)} />
      } else {
        core = (
          <Text color={phaseColor(a.phase)} dimColor={!isOn} wrap="truncate-end">
            {isOn ? '· • ● • ·' : (a.description || '')}
          </Text>
        )
      }

      const elapsed = (a.endedAt ?? now) - a.startedAt
      const cost = costLabel(a)
      const stats = `${cost === undefined ? '' : `${cost} · `}⚒${a.tools} · ${clock(elapsed)}`
      const isShown = a.id === selected?.id

      return (
        <Box key={`line-${a.id}`} flexDirection="column">
          <Box gap={1}>
            {heading(a, headW)}
            <Box width={lineCore}>{core}</Box>
            <Box width={BADGE_W} justifyContent="flex-end">
              {badgeOf(a)}
            </Box>
          </Box>
          <Box paddingLeft={1}>
            <Text color={phaseColor(a.phase)}>{isShown ? '▸' : ' '}</Text>
            {picker(a, i, width - 2)}
          </Box>
          <Box justifyContent="space-between" gap={2} paddingLeft={2}>
            <Box flexShrink={1}>
              <Text color={phaseColor(a.phase)} dimColor wrap="truncate-end">
                {activityOf(a, elapsed)}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text dimColor>{stats}</Text>
            </Box>
          </Box>
          {hitArea(a, width, LINE_ROWS, 0)}
        </Box>
      )
    }

    const card = (a: SwarmAgent, i: number) => {
      const color = phaseColor(a.phase)
      const isOn = isLive(a.phase)
      const elapsed = (a.endedAt ?? now) - a.startedAt
      const stats = `⚒${a.tools} ${clock(elapsed)}`
      const trail = a.trail.slice(-Math.max(0, inner - stats.length - 1))
      const activity = { text: activityOf(a, elapsed), color }

      let core
      if (Raster !== undefined) {
        core = <Raster key={coreKey(a.id)} columns={inner} rows={CORE_ROWS} cells={coreCells(prevCores, cores, a, inner, CORE_ROWS)} />
      } else {
        core = (
          <Box height={CORE_ROWS} alignItems="center" justifyContent="center">
            <Text color={color}>{isOn ? '· • ● • ·' : `${PHASE_GLYPH[a.phase]} ${a.phase}`}</Text>
          </Box>
        )
      }

      const cost = costLabel(a)
      const metrics = fitParts(usageParts(a), inner - (cost === undefined ? 0 : cost.length + 3))

      // Live: the recent sparkline. Finished: the core above charts the whole run, so a time axis.
      const spark = a.spark ?? NO_SPARK
      const hasHistory = spark.some(v => v > 0)
      let underCore
      if (!isOn && hasHistory) {
        const end = clock(elapsed)
        underCore = (
          <Text dimColor wrap="truncate-end">
            {`0:00 ${'─'.repeat(Math.max(0, inner - end.length - 6))} ${end}`}
          </Text>
        )
      } else if (Raster !== undefined) {
        underCore = (
          <Raster
            key={`spark-${coreKey(a.id)}`}
            columns={inner}
            rows={1}
            cells={sparkCells(spark, inner, isOn ? a.phase : 'stopped')}
          />
        )
      } else {
        underCore = (
          <Text color={color} dimColor={!isOn}>
            {sparkText(spark, inner)}
          </Text>
        )
      }

      return (
        <Box key={`card-${a.id}`} flexDirection="column" width={cardWidth} paddingX={1} {...borderOf(a)}>
          <Box justifyContent="space-between" gap={1}>
            {heading(a)}
            {badgeOf(a)}
          </Box>
          {core}
          {underCore}
          {picker(a, i, inner)}
          <Text wrap="truncate-end" color={activity.color} dimColor={!isOn}>
            {activity.text}
          </Text>
          <Box>
            {cost === undefined ? (
              <Text dimColor>{metrics === '' ? '$ …' : ''}</Text>
            ) : (
              <Text bold={isOn} color={COST_COLOR} dimColor={!isOn}>
                {cost}
              </Text>
            )}
            <Text dimColor wrap="truncate-end">
              {metrics === '' ? '' : `${cost === undefined ? '' : ' · '}${metrics}`}
            </Text>
          </Box>
          <Box justifyContent="space-between">
            <Box>
              {trail.length === 0 ? (
                <Text dimColor>·</Text>
              ) : Raster !== undefined ? (
                <Raster key={`trail-${coreKey(a.id)}`} columns={trail.length} rows={1} cells={trailCells(trail, a.trail)} />
              ) : (
                trail.map(step => {
                  const g = toolGlyph(step.tool)

                  return step.isError ? (
                    <Text color="#fecaca" backgroundColor="#7f1d1d">
                      {g.glyph}
                    </Text>
                  ) : (
                    <Text color={g.color}>{g.glyph}</Text>
                  )
                })
              )}
            </Box>
            <Text dimColor>{stats}</Text>
          </Box>
          {hitArea(a, cardWidth, CARD_ROWS + 2)}
        </Box>
      )
    }

    // ── the inspector: the selected agent's task, numbers and live timeline ─

    const inspector = (a: SwarmAgent) => {
      const color = phaseColor(a.phase)
      const isOn = isLive(a.phase)
      const at = list.indexOf(a)
      const room = width - 4
      const showTime = room >= 40
      const elapsed = (a.endedAt ?? now) - a.startedAt
      const cost = costLabel(a)
      const facts = fitParts(
        [
          `${clock(elapsed)}`,
          `${a.steps} step${a.steps === 1 ? '' : 's'}`,
          `⚒ ${a.tools}`,
          ...(cost === undefined ? [] : [cost]),
          ...usageParts(a),
        ],
        room,
      )
      const { lead, effort } = headingParts(a)
      const who = a.name !== undefined && a.name !== a.type ? `${a.type} · ${a.name}` : a.type
      const navW = buttonWidth('‹', true) + 2 + `${list.length}/${list.length}`.length + 2 + buttonWidth('›', true) + 2 + buttonWidth('hide', true)
      const isStacked = lead.length + effort.length + who.length + 3 + navW + 2 > room

      const stream = isOn ? streams.get(a.id) : undefined
      const entries = a.log ?? []
      const fold = Math.max(0, entries.length + (stream === undefined ? 0 : 1) - INSPECT_ROWS)
      const recent = entries.slice(fold)
      const sideW = room < 40 ? 7 : Math.min(30, Math.floor(room / 3))
      const bodyW = room - (showTime ? 7 : 0) - 2

      const when = (ms: number) =>
        showTime ? (
          <Box width={7} flexShrink={0}>
            <Text dimColor>{`+${clock(ms - a.startedAt)}`}</Text>
          </Box>
        ) : null

      const entry = (en: SwarmLogEntry, i: number) => {
        let icon
        let body
        let side
        switch (en.kind) {
          case 'tool': {
            const g = toolGlyph(en.tool)
            icon = <Text color={g.color}>{en.status === 'run' ? '▸' : '•'}</Text>
            body = (
              <Text wrap="truncate-end">
                <Text bold color={g.color}>
                  {en.tool}
                </Text>
                {en.arg !== undefined && <Text dimColor>{`  ${en.arg}`}</Text>}
              </Text>
            )
            if (en.status === 'run') {
              side = <Text color={phaseColor('tool')}>{`◌ ${duration(now - en.at)}`}</Text>
            } else {
              const time = en.ms === undefined ? '' : duration(en.ms)
              const words = room < 40 ? '' : (en.summary ?? '')
              const rest = head([words, time].filter(Boolean).join(' · '), sideW - 2)
              side =
                en.status === 'ok' ? (
                  <Text>
                    <Text color="success">✓ </Text>
                    <Text dimColor>{rest}</Text>
                  </Text>
                ) : (
                  <Text color="error">{`✕ ${rest}`}</Text>
                )
            }
            break
          }
          case 'think':
            icon = <Text color={phaseColor('thinking')}>✻</Text>
            body = (
              <Text italic dimColor wrap="truncate-end">
                {en.text}
              </Text>
            )
            break
          case 'text':
            icon = <Text color={phaseColor('writing')}>✎</Text>
            body = <Text wrap="truncate-end">{en.text}</Text>
            break
          case 'end': {
            const label =
              en.phase === 'done' ? 'finished' : en.phase === 'stopped' ? 'stopped' : 'failed'
            icon = <Text color={phaseColor(en.phase)}>{PHASE_GLYPH[en.phase]}</Text>
            body = (
              <Text bold color={phaseColor(en.phase)}>
                {`${label} in ${clock(en.at - a.startedAt)}`}
              </Text>
            )
            break
          }
        }

        return (
          <Box key={`log-${a.id}-${fold + i}`} flexDirection="column">
            <Box>
              {when(en.at)}
              <Box width={2} flexShrink={0}>
                {icon}
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                {body}
              </Box>
              {side !== undefined && (
                <Box flexShrink={0} marginLeft={1}>
                  {side}
                </Box>
              )}
            </Box>
            {en.kind === 'end' && en.text !== undefined && (
              <Box paddingLeft={(showTime ? 7 : 0) + 2}>
                <Text wrap="wrap">{head(en.text, bodyW * 4)}</Text>
              </Box>
            )}
          </Box>
        )
      }

      const nav = (
        <Box gap={2} flexShrink={0}>
          <Button
            key="inspect-prev"
            label="‹"
            hotkey="p"
            plain
            dimColor
            onPress={() => {
              const to = list[(at - 1 + list.length) % list.length]
              if (to !== undefined) void select($, to.id, { toggle: false })
            }}
          />
          <Text dimColor>{`${at + 1}/${list.length}`}</Text>
          <Button
            key="inspect-next"
            label="›"
            hotkey="n"
            plain
            dimColor
            onPress={() => {
              const to = list[(at + 1) % list.length]
              if (to !== undefined) void select($, to.id, { toggle: false })
            }}
          />
          <Button key="inspect-hide" label="hide" hotkey="h" plain dimColor onPress={() => void select($, a.id)} />
        </Box>
      )

      return (
        <Box
          key="inspector"
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor={color}
          paddingX={1}
        >
          <Box justifyContent="space-between" gap={2} flexDirection={isStacked ? 'column' : 'row'}>
            <Box flexShrink={1}>
              <Text bold color={color} wrap="truncate-end">
                {lead}
                {effort !== '' && <Text color={effortColor(a.effortLevel)}>{effort}</Text>}
                <Text bold={false} dimColor>{`  ${who}`}</Text>
              </Text>
            </Box>
            {nav}
          </Box>
          <Text bold wrap="truncate-end">
            {a.description || '…'}
          </Text>
          {a.prompt !== undefined && a.prompt !== a.description && (
            <Text dimColor italic wrap="wrap">
              {head(a.prompt, room * 2)}
            </Text>
          )}
          <Text dimColor wrap="truncate-end">
            {facts}
          </Text>
          <Box marginTop={1} flexDirection="column">
            {fold > 0 && <Text dimColor>{`  ⋯ ${fold} earlier`}</Text>}
            {recent.length === 0 && stream === undefined && (
              <Text dimColor>{isOn ? '◌ waiting for its first move…' : 'No activity recorded.'}</Text>
            )}
            {recent.map((en, i) => entryView(en, `${a.id}|${fold + i}|${room}|${isLightTheme()}`, () => entry(en, i)))}
            {stream !== undefined && (
              <Box key={`log-${a.id}-live`}>
                {when(stream.at)}
                <Box width={2} flexShrink={0}>
                  <Text color={phaseColor(stream.kind === 'text' ? 'writing' : 'thinking')}>
                    {stream.kind === 'text' ? '✎' : '✻'}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text italic={stream.kind === 'think'} dimColor={stream.kind === 'think'} wrap="wrap">
                    {tail(stream.text, bodyW * 3)}
                    <Text color={phaseColor(stream.kind === 'text' ? 'writing' : 'thinking')}>▍</Text>
                  </Text>
                </Box>
              </Box>
            )}
          </Box>
        </Box>
      )
    }

    // ── header: counts on the left, controls on the right or, when tight, below ─

    const countsOf = (withTools: boolean) =>
      [
        isNarrow ? '◆' : '◆ SWARM',
        `  ${live} live · ${done} done`,
        failed > 0 ? ` · ${failed} failed` : '',
        withTools ? ` · ⚒ ${tools}` : '',
        cost === undefined ? '' : ` · ${usd(cost)}`,
      ].join('')
    const compactLabel = isCompact ? 'cards' : 'list'
    const clearLabel = isNarrow ? 'clear' : 'clear done'
    const controlsW =
      (list.length > 0 ? buttonWidth(compactLabel, true) + 2 : 0) +
      (list.length > live ? buttonWidth(clearLabel, true) + 2 : 0) +
      buttonWidth('close', true)
    // How to follow an agent rides the header, in the room the counts and controls leave;
    // the tool total (each agent shows its own) gives way to it.
    const hints = selected !== undefined || list.length === 0 ? [] : [' · click or 1–9 to follow', ' · click to follow', ' · click one']
    const fit = (withTools: boolean) => {
      const counts = countsOf(withTools)
      const isStacked = counts.length + 2 + controlsW > width
      const room = width - counts.length - (isStacked ? 0 : controlsW + 2)

      return { counts, isStacked, hint: hints.find(h => h.length <= room) }
    }
    const wide = fit(!isNarrow)
    const { isStacked: isHeaderStacked, hint } = wide.hint !== undefined || hints.length === 0 || isNarrow ? wide : fit(false)
    const showTools = !isNarrow && (wide.hint !== undefined || hints.length === 0)

    const controls = (
      <Box gap={2} flexShrink={0}>
        {list.length > 0 && (
          <Button
            key="compact"
            label={compactLabel}
            hotkey="v"
            plain
            dimColor
            onPress={() => void update($, compactAtom, v => !v)}
          />
        )}
        {list.length > live && (
          <Button
            key="clear"
            label={clearLabel}
            hotkey="c"
            plain
            dimColor
            onPress={() => void mutate($, l => l.filter(a => isLive(a.phase)))}
          />
        )}
        <Button key="close" label="close" hotkey="x" plain dimColor onPress={() => void closeView($, true)} />
      </Box>
    )

    const header = (
      <Box flexDirection="column" marginBottom={1}>
        <Box justifyContent="space-between" gap={2}>
          <Box flexShrink={1}>
            <Text wrap="truncate-end">
              <Text bold color={BRAND}>
                {isNarrow ? '◆' : '◆ SWARM'}
              </Text>
              <Text color="suggestion">{`  ${live} live`}</Text>
              <Text dimColor> · </Text>
              <Text color="success">{`${done} done`}</Text>
              {failed > 0 && <Text dimColor> · </Text>}
              {failed > 0 && <Text color="error">{`${failed} failed`}</Text>}
              {showTools && <Text dimColor>{` · ⚒ ${tools}`}</Text>}
              {cost !== undefined && <Text dimColor> · </Text>}
              {cost !== undefined && <Text color={COST_COLOR}>{usd(cost)}</Text>}
              {hint !== undefined && <Text dimColor>{hint}</Text>}
            </Text>
          </Box>
          {!isHeaderStacked && controls}
        </Box>
        {isHeaderStacked && controls}
      </Box>
    )

    // ── countdown: one row when it fits, the buttons below it when not ─

    let banner
    if (closesIn !== undefined) {
      const long = `✓ All agents finished · closing in ${closesIn}s`
      const short = `✓ All done · closing in ${closesIn}s`
      const buttonsW = buttonWidth('keep open', true)
      const text = long.length + 2 + buttonsW <= width ? long : short
      const isStacked = text.length + 2 + buttonsW > width
      const [what, when] = text.split(' · ')
      banner = (
        <Box
          flexDirection={isStacked ? 'column' : 'row'}
          justifyContent="space-between"
          gap={isStacked ? 0 : 2}
          marginBottom={1}
        >
          <Text wrap="truncate-end">
            <Text bold color={phaseColor('done')}>
              {what}
            </Text>
            <Text dimColor>{` · ${when}`}</Text>
          </Text>
          <Box flexShrink={0}>
            <Button key="keep-open" label="keep open" hotkey="k" plain onPress={() => keepOpen($)} />
          </Box>
        </Box>
      )
    }

    const rows: SwarmAgent[][] = []
    for (let i = 0; i < list.length; i += perRow) rows.push(list.slice(i, i + perRow))

    return (
      <Box key="swarm-view" flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        {header}
        {banner}
        {list.length === 0 ? (
          <Box flexDirection="column" alignItems="center" paddingY={1}>
            <Text color={BRAND}>⠀⣠⣴⣶⣦⣄⠀</Text>
            <Text dimColor>No agents yet.</Text>
            <Text dimColor>Spawned subagents land here as live cards.</Text>
          </Box>
        ) : isCompact ? (
          <Box flexDirection="column">
            {list.map((a, i) =>
              finishedView(a, `line|${width}|${headW}|${i}|${a.id === selected?.id}|${surfaceKey}`, () => line(a, i)),
            )}
          </Box>
        ) : (
          rows.map((row, r) => (
            <Box key={`row-${r}`} gap={GAP}>
              {row.map((a, c) => {
                const i = r * perRow + c

                return finishedView(a, `card|${cardWidth}|${i}|${a.id === selected?.id}|${surfaceKey}`, () => card(a, i))
              })}
            </Box>
          ))
        )}
        {selected !== undefined && inspector(selected)}
      </Box>
    )
  } finally {
    record('render.view', performance.now() - t0)
  }
}

export const register: Register = (on, options) => {
  autoCloseDelay = autoCloseMs(options.autoClose)

  // ── lifecycle ─────────────────────────────────────────────────────────

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'swarm',
      description:
        'Show spawned agents above the prompt (`/swarm demo` plays a scripted swarm, `/swarm list` or `/swarm cards` picks the layout, `/swarm clear` drops finished ones, `/swarm autoclose 30s|off` sets the auto-close delay)',
    })
    // The footer pill replaced the status line, and the band the pane: clear what an earlier build left.
    $.ui.status(undefined)
    void $.ui.close({ id: 'agent-swarm' }).catch(() => undefined)
    const [selected] = await Promise.all([read($, selectedAtom), restore($)])
    shownId = selected
    await syncLive($, snapshot)
    void $.config
      .list()
      .then(rows => setLightTheme(rows.find(row => row.key === 'theme')?.value) && $.ui.invalidate('ui.render'))
      .catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'swarm' }, async ($, e) => {
    const [sub, arg] = e.args.trim().split(/\s+/)
    if (sub === 'perf') {
      if (arg === 'reset') resetPerf()

      return { text: perfReport() }
    }
    if (sub === 'demo') {
      if (isDemoRunning) return { text: 'A demo is already running.' }
      await startDemo($)

      return { text: `A scripted swarm of ${DEMO.length} agents is playing above the prompt (nothing is spawned or billed).` }
    }
    if (sub === 'clear') {
      const list = await mutate($, l => l.filter(a => isLive(a.phase)))

      return { text: `Cleared finished agents; ${list.length} still running.` }
    }
    if (sub === 'list' || sub === 'cards' || sub === 'compact') {
      const isCompact = await update($, compactAtom, v => (sub === 'compact' ? !v : sub === 'list'))
      await openView($, true)

      return { text: `Agents view shows ${isCompact ? 'a list' : 'cards'}.` }
    }
    if (sub === 'autoclose') {
      const choices = AUTO_CLOSE_CHOICES.join(' | ')
      if (arg === undefined) {
        return {
          text: `Auto-close: ${autoCloseDelay > 0 ? options.autoClose : 'off'}. Set it with /swarm autoclose ${choices}.`,
        }
      }
      if (!(AUTO_CLOSE_CHOICES as readonly string[]).includes(arg)) {
        return { text: `Unknown delay "${arg}"; pick one of ${choices}.` }
      }
      const { deny } = await $.config.set({ key: 'agent-swarm.autoClose', value: arg })

      return { text: deny === undefined ? `Auto-close set to ${arg}.` : `Could not set auto-close: ${deny}` }
    }
    await openView($, true)

    return { text: 'Agents view open above the prompt.' }
  })

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const res = await next(e)
    if (res.deny === undefined && setLightTheme(res.value)) $.ui.invalidate('ui.render')

    return res
  })

  // ── what agents do ────────────────────────────────────────────────────

  on('agent.spawn', async ($, e, next) => {
    const key = `spawn:${e.tool_use_id}`
    pending.add(key)
    await addCard($, key, {
      description: e.description,
      prompt: head(e.prompt, 400),
      type: e.subagentType,
      name: e.name,
      model: e.model ?? '',
      parentId: e.parentAgentId,
      isBackground: e.background,
    })

    try {
      const res = await next(e)
      const agentId = res.deny === undefined ? res.agentId : undefined
      await mutate($, list => {
        const card = list.find(a => a.id === key)
        const rest = list.filter(a => a.id !== key)
        if (card === undefined || agentId === undefined) return rest
        const early = rest.find(a => a.id === agentId)
        if (early === undefined) {
          return [...rest, { ...card, id: agentId, model: res.deny === undefined ? res.model : card.model }]
        }

        // Its loop reported in before the spawn settled: keep what it did.
        return rest.map(a =>
          a.id === agentId
            ? {
                ...a,
                description: card.description,
                prompt: card.prompt,
                type: card.type,
                name: card.name,
                parentId: card.parentId,
                isBackground: card.isBackground,
                startedAt: Math.min(a.startedAt, card.startedAt),
                model: a.model || card.model,
                isStub: false,
              }
            : a,
        )
      })

      return res
    } catch (error) {
      await mutate($, list => list.filter(a => a.id !== key))
      throw error
    } finally {
      pending.delete(key)
    }
  })

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id === undefined || !(await ensure($, id))) return yield* next(e)

    await stepStarted($, id, e.effort, e.model)

    let phase: SwarmPhase = 'thinking'
    try {
      for await (const chunk of next(e)) {
        if (chunk.kind === 'stop') {
          if (chunk.usage !== null) await responded($, id, chunk.usage, e.model)
          else await commitStream($, id)
        } else if (chunk.kind === 'tool') {
          await commitStream($, id)
        } else if (chunk.kind === 'text' || chunk.kind === 'thinking') {
          phase = await streamed($, id, chunk, phase)
        }
        yield chunk
      }
    } finally {
      await commitStream($, id)
    }
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id === undefined || !(await ensure($, id))) return next(e)

    const tool = String(e.tool)
    const arg = toolArg(e as unknown as Record<string, unknown>)
    const startedAt = await toolStarted($, id, e.tool_use_id, tool, arg)

    let isError = true
    let summary: string | undefined
    try {
      const ran = await next(e)
      isError = ran.deny !== undefined || ran.isError === true
      summary = ran.deny !== undefined ? head(ran.deny, 60) : resultSummary(ran.text, isError)

      return ran
    } finally {
      await toolEnded($, id, e.tool_use_id, tool, startedAt, isError, summary)
    }
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) await restore($)
    if (id !== undefined && snapshot.some(a => a.id === id)) await completed($, id, e.reason, e.answer, e.usage)

    return next(e)
  })

  // A new prompt starts a new batch: the band forgets agents that finished before it.
  on('prompt.submit', async ($, e, next) => {
    batchStart = await $.clock.now()
    await refreshBand($)

    return next(e)
  })

  // A click anywhere on an agent, from its hit area.
  on('ui.message', async ($, e, next) => {
    const pick = (e.data as { pick?: unknown } | null)?.pick
    if (typeof pick !== 'string') return next(e)
    // A click on the open view toggles the inspector; on a folded square it unfolds onto that agent.
    await select($, pick, isFullShown() ? {} : { toggle: false, open: true })

    return {}
  })

  // ── the footer pill: a purple shimmer while agents work ───────────────

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const t0 = performance.now()
    try {
      const live = await read($, liveAtom)
      if (live === 0) {
        pill = undefined

        return next(e)
      }
      const { Box, Text } = $.ui.resolve(e)
      const Raster = e.surface === 'terminal' ? $.ui.resolve(e).Raster : undefined
      const text = pillText(live)
      const cells = packCells(pillFrame(text, tick))
      pill = Raster === undefined ? undefined : { requestId: e.requestId, text, cells }

      return (
        <Box gap={2}>
          {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')}</Text>}
          {Raster !== undefined ? (
            <Raster key="swarm-pill" columns={text.length + 2} rows={1} cells={cells} />
          ) : (
            <Text color={PILL_COLOR}>{`✻ ${text}`}</Text>
          )}
        </Box>
      )
    } finally {
      record('render.pill', performance.now() - t0)
    }
  })

  // ── the band: mini squares above the prompt, drawn unasked at any width ─

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const t0 = performance.now()
    try {
      const [isOpen] = await Promise.all([read($, openAtom), restore($)])
      if (e.props.hasSurvey) {
        mounted.delete(e.requestId)
        fullSite = undefined

        return next(e)
      }
      if (isOpen) return await drawFull($, e)
      if (fullSite === e.requestId) fullSite = undefined
      await read($, bandRevAtom)
      const list = ordered(snapshot.filter(a => isLive(a.phase) || (a.endedAt ?? 0) >= batchStart))
      if (list.length === 0) {
        mounted.delete(e.requestId)

        return next(e)
      }
      const { Box, Text, Button } = $.ui.resolve(e)
      const Raster = e.surface === 'terminal' ? $.ui.resolve(e).Raster : undefined
      const Client = e.surface === 'terminal' ? $.ui.resolve(e).Client : undefined
      /** A transparent region over the whole agent, last so it is on top: a click anywhere picks it. */
      const hitArea = (a: SwarmAgent, columns: number, rows: number, inset = 1) =>
        Client === undefined ? null : (
          <Box position="absolute" top={-inset} left={-inset}>
            <Client key={`hit-${coreKey(a.id)}`} module="./hit-area.tsx" props={{ id: a.id }} width={columns} height={rows} />
          </Box>
        )
      const width = Math.max(SQUARE, e.props.bodyColumns)
      const perRow = Math.max(1, Math.floor((width + GAP) / (SQUARE + GAP)))
      const fitRows = Math.max(1, Math.floor((e.props.maxRows - 1) / SQUARE_ROWS))
      const shown = list.slice(0, perRow * fitRows)
      const hidden = list.length - shown.length
      const inner = SQUARE - 2
      const live = list.filter(a => isLive(a.phase)).length
      const cost = totalCost(list)

      bandSite = e.requestId
      const prevCores = mounted.get(e.requestId)
      const cores = new Map<string, Core>()
      mounted.set(e.requestId, cores)

      const square = (a: SwarmAgent) => {
        const color = phaseColor(a.phase)
        const isOn = isLive(a.phase)
        let core
        if (Raster !== undefined) {
          core = <Raster key={coreKey(a.id)} columns={inner} rows={1} cells={coreCells(prevCores, cores, a, inner, 1)} />
        } else {
          core = <Text color={color}>{isOn ? '· • ● • ·' : a.phase}</Text>
        }

        return (
          <Box
            key={`sq-${a.id}`}
            flexDirection="column"
            width={SQUARE}
            borderStyle="round"
            borderColor={isOn ? color : hex(ramp(a.phase)[2])}
            borderDimColor={!isOn}
            hover={{ borderColor: hex(ramp(a.phase)[4]), borderDimColor: false }}
          >
            <Button
              key={`band-pick-${a.id}`}
              label={head(`${PHASE_GLYPH[a.phase]} ${a.name ?? a.type}`, inner)}
              plain
              dimColor={!isOn}
              onPress={() => void select($, a.id, { toggle: false, open: true })}
            />
            {core}
            <Box justifyContent="space-between">
              <Box>
                {effortCells(a.effortLevel).map(c =>
                  c.isOn ? (
                    <Text color={c.color} dimColor={!isOn}>
                      {c.ch}
                    </Text>
                  ) : (
                    <Text dimColor>{c.ch}</Text>
                  ),
                )}
              </Box>
              <Text dimColor>
                {a.phase === 'tool' && a.tool ? a.tool.slice(0, 8) : (costLabel(a) ?? `⚒${a.tools}`)}
              </Text>
            </Box>
            {hitArea(a, SQUARE, SQUARE_ROWS)}
          </Box>
        )
      }

      const rows: SwarmAgent[][] = []
      for (let i = 0; i < shown.length; i += perRow) rows.push(shown.slice(i, i + perRow))

      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text bold color={BRAND}>◆ </Text>
            <Text color="suggestion">{live > 0 ? `${live} working` : 'all finished'}</Text>
            {cost !== undefined && <Text color={COST_COLOR}>{` · ${usd(cost)}`}</Text>}
            <Text dimColor>{`${hidden > 0 ? ` · +${hidden} more` : ''} · click one for details · /swarm unfolds`}</Text>
          </Text>
          {rows.map((row, i) => (
            <Box key={`band-row-${i}`} gap={GAP}>
              {row.map(square)}
            </Box>
          ))}
        </Box>
      )
    } finally {
      record('render.band', performance.now() - t0)
    }
  })
}
