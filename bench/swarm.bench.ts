import { expect, mock, test } from 'claude-code/testing'

import * as core from '../hooks/core'
import { coreFrame, packCells, pillFrame, sparkFrame } from '../hooks/core'

// A synthetic swarm at a real agent's pace, driven through the engine on a mocked
// clock: prints one BENCH line of what the plugin cost (wall time, state writes,
// blits, renders) for comparing builds. Run it with bench/run.sh [mod folder].

const AGENTS = 8
const STEPS = 12
const CHUNK_MS = 30
const THINK_CHUNKS = 15
const TEXT_CHUNKS = 6
const TOOL_MS = 400
const SPAWN_GAP_MS = 250

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const USAGE = {
  model: 'claude-sonnet-5-5',
  input_tokens: 1_200,
  output_tokens: 600,
  cache_read_input_tokens: 30_000,
  cache_creation_input_tokens: 2_000,
}
const WORDS = 'the auth handler reads a token then checks its scope against the route table before it '.split(' ')
const words = (i: number, n: number) => Array.from({ length: n }, (_, k) => WORDS[(i + k) % WORDS.length]).join(' ') + ' '

const PANE = {
  plugin: 'agent-swarm',
  component: 'Pane',
  requestId: 'agent-swarm',
  props: { title: 'Agents', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const
const BAND = {
  plugin: 'agent-swarm',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const MODE = { plugin: 'agent-swarm', component: 'SessionMode', props: { modes: [] as string[] } } as const

async function swarm($: any, on: any, site: 'list' | 'cards' | 'band', finished = 0) {
  const clock = mock.clock(on, { now: 50_000_000 })
  const m = { sets: 0, setBytes: 0, blits: 0, blitBytes: 0, renders: 0 }
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('state.set', (_$: unknown, e: { value: unknown }, next: (e: unknown) => unknown) => {
    m.sets += 1
    m.setBytes += JSON.stringify(e.value)?.length ?? 0

    return next(e)
  })
  on('ui.blit', (_$: unknown, e: { cells?: string }, next: (e: unknown) => unknown) => {
    m.blits += 1
    m.blitBytes += e.cells?.length ?? 0

    return next(e)
  })
  on('agent.spawn', (_$: unknown, e: { tool_use_id: string }) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.tool_use_id}` }))
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number }) {
    for (let i = 0; i < THINK_CHUNKS; i++) {
      await clock.sleep(CHUNK_MS)
      yield { kind: 'thinking' as const, index: 0, text: words(i, 3) }
    }
    for (let i = 0; i < TEXT_CHUNKS; i++) {
      await clock.sleep(CHUNK_MS)
      yield { kind: 'text' as const, index: 1, text: words(i + 7, 3) }
    }
    yield { kind: 'tool' as const, index: 2, id: `tu_${e.turnId}_${e.index}`, name: 'Grep' }
    yield { kind: 'stop' as const, stopReason: 'tool_use' as const, usage: USAGE }

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: USAGE }
  })
  on('tool.call', async (_$: unknown, e: { tool_use_id: string }) => {
    if (!e.tool_use_id.startsWith('tu_done')) await clock.sleep(TOOL_MS)

    return { result: {}, text: 'src/a.ts\nsrc/b.ts\nsrc/c.ts' }
  })
  on('turn.complete', () => ({ text: 'ok' }))

  await $.session.start(START)
  const ids = Array.from({ length: AGENTS }, (_, i) => `a${i}`)
  for (const [i, id] of ids.entries()) {
    await $.agent.spawn({
      tool_use_id: id,
      prompt: `Scout part ${i} of the auth code and report what it finds`,
      description: `scout part ${i}`,
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: false,
      fork: false,
    })
  }
  for (let i = 0; i < finished; i++) {
    const id = `done${i}`
    await $.agent.spawn({
      tool_use_id: id,
      prompt: `An earlier task ${i}`,
      description: `earlier task ${i}`,
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: false,
      fork: false,
    })
    for (let s = 0; s < 3; s++) {
      await $.tool.call({ tool: s === 1 ? 'Read' : 'Bash', tool_use_id: `tu_${id}_${s}`, command: 'ls', agentId: `agent-${id}` })
    }
    await $.turn.complete({ answer: `Earlier ${i} done.`, durationMs: 1, isAborted: false, turnId: `t-${id}`, agentId: `agent-${id}`, reason: 'answer' })
  }
  const mounts = [await $.ui.mount({ ...MODE, surface: 'terminal' })]
  // Newer builds draw the whole view in the band (key swarm-view); older ones in a Pane.
  let view = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const isBandView = (await view.find({ key: 'swarm-view' })) !== undefined
  if (site === 'band') {
    if (isBandView) await view.press({ key: 'close' })
  } else {
    if (!isBandView) {
      await view.unmount()
      view = await $.ui.mount({ ...PANE, surface: 'terminal' })
    }
    // Older builds label the toggle compact/expand, newer ones list/cards: read which layout is up.
    const label = (await view.find({ key: 'compact' }))?.props.label
    if ((label === 'expand' || label === 'cards') !== (site === 'list')) await view.press({ key: 'compact' })
    await view.press({ key: 'pick-agent-a0' })
  }
  mounts.push(view)
  await $.command.run({ command: 'swarm', args: 'perf reset' })
  Object.assign(m, { sets: 0, setBytes: 0, blits: 0, blitBytes: 0 })

  const t0 = performance.now()
  const simStart = clock.now()
  const run = async (id: string, i: number) => {
    await clock.sleep(i * SPAWN_GAP_MS)
    const agentId = `agent-${id}`
    for (let s = 0; s < STEPS; s++) {
      for await (const _ of $.turn.step({ turnId: `t-${id}`, index: s, model: 'claude-sonnet-5-5', messageCount: 1 + s * 2, agentId })) {
        // drain
      }
      await $.tool.call({ tool: 'Grep', tool_use_id: `tu_t-${id}_${s}`, pattern: 'auth', agentId })
    }
    await $.turn.complete({ answer: `Part ${i} done.`, durationMs: 1, isAborted: false, turnId: `t-${id}`, agentId, reason: 'answer' })
  }
  let isDone = false
  const all = Promise.all(ids.map(run)).finally(() => {
    isDone = true
  })
  let elements = 0
  const nodes = (n: unknown): number =>
    n !== null && typeof n === 'object' && 'type' in n
      ? 1 + ((n as { children?: unknown[] }).children ?? []).reduce((k: number, c) => k + nodes(c), 0)
      : 0
  while (!isDone && clock.now() - simStart < 120_000) {
    await clock.advance(20)
    if (elements === 0 && clock.now() - simStart >= 9000) elements = nodes(await mounts[1]!.drawn())
  }
  await all
  const wallMs = performance.now() - t0
  const simMs = clock.now() - simStart
  const perf = (await $.command.run({ command: 'swarm', args: 'perf' })) as { text: string }
  for (const ui of mounts) await ui.unmount()

  const line = `BENCH ${site}${finished > 0 ? `+${finished} finished` : ''} ${JSON.stringify({ wallMs: Math.round(wallMs), simS: simMs / 1000, sets: m.sets, setKB: Math.round(m.setBytes / 1024), blits: m.blits, blitKB: Math.round(m.blitBytes / 1024), elements })}`

  return `${line}\n${perf.text}`
}

test('bench: a swarm streaming in the list, inspector open', { timeoutMs: 600_000 }, async ($, on) => {
  // Fails on purpose: the report travels in the failure message (bench/run.sh prints it).
  expect(await swarm($, on, 'list')).toBe('')
})

test('bench: a swarm streaming in cards, inspector open', { timeoutMs: 600_000 }, async ($, on) => {
  expect(await swarm($, on, 'cards')).toBe('')
})

test('bench: a swarm streaming in the list beside 16 finished agents', { timeoutMs: 600_000 }, async ($, on) => {
  expect(await swarm($, on, 'list', 16)).toBe('')
})

test('bench: a swarm streaming in cards beside 16 finished agents', { timeoutMs: 600_000 }, async ($, on) => {
  expect(await swarm($, on, 'cards', 16)).toBe('')
})

test('bench: a swarm streaming under the band', { timeoutMs: 600_000 }, async ($, on) => {
  expect(await swarm($, on, 'band')).toBe('')
})

test('bench: frame drawing cost per call', { timeoutMs: 600_000 }, async () => {
  const lines: string[] = []
  const time = (name: string, n: number, fn: (i: number) => unknown) => {
    for (let i = 0; i < 200; i++) fn(i)
    const t0 = performance.now()
    for (let i = 0; i < n; i++) fn(i)
    lines.push(`  ${name.padEnd(26)} ${(((performance.now() - t0) / n) * 1000).toFixed(1).padStart(7)}µs`)
  }
  const spark = Array.from({ length: 300 }, (_, i) => (i * 7) % 5)
  // A canvas handed back is drawn into next time (builds that ignore it allocate).
  let into: any
  for (const phase of ['thinking', 'writing', 'tool', 'spawning'] as const) {
    const a = { id: 'agent-abc123', phase, effortLevel: 3 }
    into = undefined
    time(`core ${phase} 34×3`, 3000, i => packCells((into = (coreFrame as any)(a, 34, i, 0.5, 3, into))))
    into = undefined
    time(`core ${phase} 90×1`, 3000, i => packCells((into = (coreFrame as any)(a, 90, i, 0.5, 1, into))))
  }
  time('core done+history 34×3', 3000, () => packCells(coreFrame({ id: 'x', phase: 'done', effortLevel: 3, spark }, 34, 0, 0)))
  time('spark 34×1', 3000, () => packCells(sparkFrame(spark, 34, 'thinking')))
  time('pill', 3000, i => packCells(pillFrame('8 agents working', i)))
  if (typeof (core as any).canvas === 'function') {
    const a = { id: 'agent-abc123', phase: 'thinking' as const, effortLevel: 3 }
    const c = (coreFrame as any)(a, 34, 5, 0.5, 3)
    time('draw only thinking 34×3', 3000, i => (coreFrame as any)(a, 34, i, 0.5, 3, c))
    time('pack only 34×3', 3000, () => packCells(c))
  }

  expect(`MICRO\n${lines.join('\n')}`).toBe('')
})
