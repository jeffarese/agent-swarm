import { describe, expect, mock, test } from 'claude-code/testing'

import {
  CORE_ROWS,
  autoCloseMs,
  cellAt,
  coreFrame,
  effortCells,
  effortLevel,
  fitParts,
  packCells,
  phaseColor,
  pillFrame,
  resample,
  resultSummary,
  rowText,
  setLightTheme,
  priceOf,
  sparkFrame,
  usageCost,
  usd,
} from '../hooks/core'

const USAGE = {
  model: 'claude-sonnet-5-5',
  input_tokens: 2_000,
  output_tokens: 3_400,
  cache_read_input_tokens: 40_000,
  cache_creation_input_tokens: 4_000,
}

/** A test hook beneath the plugin: one streamed response that stops with `usage`. */
async function* oneResponse(e: { turnId: string; index: number }) {
  yield { kind: 'text' as const, index: 0, text: 'looking…' }
  yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: USAGE }

  return { turnId: e.turnId, index: e.index, answer: 'looking…', toolUses: [], stopReason: 'end_turn' as const, usage: USAGE }
}

async function step($: any, agentId: string) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId })
  for await (const _ of stream) {
    // drain
  }
}

const swarmCommand = (args: string) =>
  ({ command: 'swarm', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

/** The band, drawing the open view: its frame takes 4 columns, so 68 draws a 64-column body. */
const PANE = {
  plugin: 'agent-swarm',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 60,
    bodyColumns: 68,
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

/** Whether the band shows the open view (else its squares, or nothing). */
const isOpenView = async (ui: { find: (q: { key: string }) => Promise<unknown> }) =>
  (await ui.find({ key: 'swarm-view' })) !== undefined

const SPAWN = {
  tool_use_id: 'toolu_1',
  prompt: 'Find the auth handlers',
  description: 'find auth handlers',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
} as const

describe('core frames', () => {
  test('light themes flip the palette to its dark end', async () => {
    const dark = phaseColor('writing')
    expect(setLightTheme('light-daltonized')).toBe(true)
    expect(phaseColor('writing')).not.toBe(dark)
    expect(setLightTheme('dark')).toBe(true)
    expect(phaseColor('writing')).toBe(dark)
  })

  test('pack columns × rows cells for every phase', async () => {
    for (const phase of ['spawning', 'thinking', 'writing', 'tool', 'done', 'failed'] as const) {
      const grid = coreFrame({ id: 'a1', phase, effortLevel: 3 }, 20, 7, 0.5)
      expect(grid.rows).toBe(CORE_ROWS)
      expect(grid.columns).toBe(20)
      // 12 bytes a cell, base64 grows 4/3
      expect(packCells(grid).length).toBe(Math.ceil((20 * CORE_ROWS * 12) / 3) * 4)
    }
  })

  test('sparkline keeps its width and a baseline when idle', async () => {
    const row = rowText(sparkFrame([0, 1, 2, 3, 4, 4, 0], 10, 'tool'), 0)
    expect(row.length).toBe(10)
    expect(row[0]).toBe('⣀')
    expect(row[9]).toBe('⡇')
    expect(rowText(sparkFrame([], 4, 'thinking'), 0)).toBe('⣀⣀⣀⣀')
  })

  test('effort meter lights its level along the gradient', async () => {
    expect(effortCells(3).filter(c => c.isOn).length).toBe(3)
    expect(effortCells(5)[0]!.color).not.toBe(effortCells(5)[4]!.color)
  })

  test('prices tokens per model family at list price', async () => {
    const million = { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }
    expect(usageCost(million, 'claude-opus-5-5')).toBe(4)
    expect(usageCost({ ...million, input: 0, output: 1e6 }, 'claude-fable-5-1')).toBe(50)
    expect(usageCost({ ...million, input: 0, cacheWrite: 1e6 }, 'claude-sonnet-4-6')).toBe(3.75)
    expect(usageCost({ ...million, input: 0, cacheRead: 1e6 }, 'claude-opus-5-5')).toBe(0.2)
    expect(priceOf('us.anthropic.claude-haiku-4-5-v1:0')?.input).toBe(1)
    expect(priceOf('claude-opus-4-1-20250805')?.input).toBe(15)
    expect(priceOf('claude-opus-4-5-20251101')?.input).toBe(5)
    expect(usageCost(million, 'arn:aws:bedrock:us-east-1:1:application-inference-profile/x')).toBeUndefined()
  })

  test('formats cost and fits metrics without cutting one', async () => {
    expect(usd(0.004)).toBe('<$0.01')
    expect(usd(0.4217)).toBe('$0.42')
    expect(usd(123.4)).toBe('$123')
    expect(fitParts(['ctx 45k', '3.4k out', '92% cached'], 18)).toBe('ctx 45k · 3.4k out')
    expect(fitParts(['ctx 45k'], 3)).toBe('')
  })

  test('auto-close delays parse, off is zero', async () => {
    expect(autoCloseMs('30s')).toBe(30_000)
    expect(autoCloseMs('5m')).toBe(300_000)
    expect(autoCloseMs('off')).toBe(0)
    expect(autoCloseMs(undefined)).toBe(0)
  })

  test('effort maps to a 0–5 level', async () => {
    expect(effortLevel(undefined)).toBe(0)
    expect(effortLevel('low')).toBe(1)
    expect(effortLevel('high')).toBe(3)
    expect(effortLevel('max')).toBe(5)
    expect(effortLevel(40_000)).toBe(4)
  })
})

test('a spawned agent becomes a card that finishes', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  on('turn.complete', () => ({ text: 'done' }))

  await $.command.run(swarmCommand(''))
  for (const surface of ['terminal', 'desktop'] as const) {
    const empty = await $.ui.mount({ ...PANE, surface })
    expect(await empty.find({ type: 'Text', text: /No agents yet/ })).toBeDefined()
    await empty.unmount()
  }

  const spawned = await $.agent.spawn(SPAWN)
  expect(spawned.deny).toBeUndefined()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /sonnet/ })).toBeDefined()
    expect(await ui.find({ text: /find auth handlers/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /est\. list price/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /1 live/ })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete({
    answer: 'Found them',
    durationMs: 1200,
    isAborted: false,
    turnId: 't1',
    agentId: 'agent-1',
    reason: 'answer',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /done in/ })).toBeDefined()
  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: /No agents yet/ })).toBeDefined()
  await ui.unmount()
})

test('the list is the default layout and a button switches to cards and back', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  await $.agent.spawn(SPAWN)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /sonnet/ })).toBeDefined()
  expect(await ui.find({ text: /find auth handlers/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⚒0 · 0:00/ })).toBeDefined()
  expect(await ui.find({ type: 'Raster', key: 'spark-core-agent-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: 'cards' })).toBeDefined()
  await ui.press({ key: 'compact' })
  expect(await ui.find({ type: 'Raster', key: 'spark-core-agent-1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'list' })).toBeDefined()
  await ui.press({ key: 'compact' })
  expect(await ui.find({ type: 'Raster', key: 'spark-core-agent-1' })).toBeUndefined()
  await ui.unmount()
})

test('/swarm list and /swarm cards pick the layout', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  await $.agent.spawn(SPAWN)

  await $.command.run(swarmCommand('cards'))
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Raster', key: 'spark-core-agent-1' })).toBeDefined()
  await ui.unmount()
  await $.command.run(swarmCommand('list'))
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Raster', key: 'spark-core-agent-1' })).toBeUndefined()
  await ui.unmount()
})

test('a Bedrock ARN heading shows the family a response reports', async ($, on) => {
  const ARN = 'arn:aws:bedrock:us-east-1:123:application-inference-profile/abc'
  mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ model: ARN, agentId: 'agent-1' }))
  on('turn.step', async function* (_$, e) {
    return yield* oneResponse(e)
  })
  await $.agent.spawn({ ...SPAWN, name: 'auth-scout' })

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /auth-scout/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /arn:/ })).toBeUndefined()
  await ui.unmount()

  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: ARN, messageCount: 1, agentId: 'agent-1' })) {
    // drain
  }
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /sonnet/ })).toBeDefined()
  await ui.unmount()
})

test('a wide view names both ways to follow an agent in its header', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  await $.agent.spawn(SPAWN)

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 124 }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: ' · click or 1–9 to follow' })).toBeDefined()
  await ui.press({ key: 'pick-agent-1' })
  expect(await ui.find({ type: 'Text', text: /to follow/ })).toBeUndefined()
  await ui.unmount()
})

test('a narrow view drops the SWARM label and tool count from the header', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  await $.agent.spawn(SPAWN)

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 52 }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 live/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /SWARM/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /⚒ 0/ })).toBeUndefined()
  await ui.unmount()
})

const BAND = {
  plugin: 'agent-swarm',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('a spawn unfolds the whole view above the prompt; close folds it to squares', async ($, on) => {
  mock.clock(on, { now: 2_000_000 })
  on('agent.spawn', (_$, e) => ({ model: 'claude-haiku-4-5', agentId: `agent-${e.tool_use_id}` }))

  await $.agent.spawn({ ...SPAWN, tool_use_id: 'a' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'b', subagentType: 'Plan' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await isOpenView(ui)).toBe(true)
    expect(await ui.find({ type: 'Text', text: /2 live/ })).toBeDefined()
    await ui.press({ key: 'close' })
    expect(await isOpenView(ui)).toBe(false)
    expect(await ui.find({ type: 'Text', text: /2 working/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /Plan/ })).toBeDefined()
    await ui.unmount()
    await $.command.run(swarmCommand(''))
  }

  // Folded by the person, a later spawn leaves it folded.
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'close' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'c' })
  expect(await isOpenView(ui)).toBe(false)
  await ui.unmount()
})

test('a streamed response puts cost, context and cache rate on the card', async ($, on) => {
  mock.clock(on, { now: 3_000_000 })
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  on('turn.step', async function* (_$, e) {
    return yield* oneResponse(e)
  })

  await $.agent.spawn(SPAWN)
  await step($, 'agent-1')
  await $.command.run(swarmCommand('cards'))

  // 2k×$2 + 3.4k×$10 + 40k×$0.20 + 4k×$2×1.25 per MTok = $0.056
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '$0.06' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ctx 49k · 3\.4k out · 87% cached/ })).toBeDefined()
    // Folded, the squares' header carries the total.
    await ui.press({ key: 'close' })
    expect(await ui.find({ type: 'Text', text: / · \$0\.06/ })).toBeDefined()
    await ui.unmount()
    await $.command.run(swarmCommand(''))
  }
})

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

async function finishedWithPaneOpen($: any, on: any) {
  const clock = mock.clock(on, { now: 4_000_000 })
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  on('turn.complete', () => ({ text: 'ok' }))
  await $.session.start(START)
  await $.agent.spawn(SPAWN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete({
    answer: 'ok',
    durationMs: 10,
    isAborted: false,
    turnId: 't1',
    agentId: 'agent-1',
    reason: 'answer',
  })

  return { clock, ui }
}

test('once every agent finishes the view counts down and folds itself', { options: { autoClose: '10s' } }, async ($, on) => {
  const { clock, ui } = await finishedWithPaneOpen($, on)
  expect(await ui.find({ type: 'Text', text: /closing in 10s/ })).toBeDefined()

  await clock.advance(4_000)
  expect(await ui.find({ type: 'Text', text: /closing in 6s/ })).toBeDefined()
  expect(await isOpenView(ui)).toBe(true)

  await clock.advance(6_000)
  expect(await isOpenView(ui)).toBe(false)
  expect(await ui.find({ type: 'Text', text: /all finished/ })).toBeDefined()
})

test('keep open stops the countdown', { options: { autoClose: '10s' } }, async ($, on) => {
  const { clock, ui } = await finishedWithPaneOpen($, on)
  await ui.press({ key: 'keep-open' })
  await clock.advance(20_000)
  expect(await isOpenView(ui)).toBe(true)
  expect(await ui.find({ type: 'Text', text: /closing in/ })).toBeUndefined()
})

test('close folds at once', { options: { autoClose: '1m' } }, async ($, on) => {
  const { ui } = await finishedWithPaneOpen($, on)
  await ui.press({ key: 'close' })
  expect(await isOpenView(ui)).toBe(false)
})

test('auto-close off shows no countdown', { options: { autoClose: 'off' } }, async ($, on) => {
  const { clock, ui } = await finishedWithPaneOpen($, on)
  expect(await ui.find({ type: 'Text', text: /closing in/ })).toBeUndefined()
  await clock.advance(400_000)
  expect(await isOpenView(ui)).toBe(true)
})

describe('inspector helpers', () => {
  test('a finished run with history draws a filled chart under its label', async () => {
    const grid = coreFrame({ id: 'a1', phase: 'done', effortLevel: 3, spark: [0, 1, 4, 2, 0, 3, 4, 1] }, 24, 7, 0)
    expect(grid.rows).toBe(CORE_ROWS)
    expect(rowText(grid, 0).slice(1, 11)).toBe('✓ complete')
    // The peak reaches the top row; the bottom row is filled where there was activity.
    expect(rowText(grid, CORE_ROWS - 1)).toContain('⣿')
    // No history: the old still line.
    const still = coreFrame({ id: 'a1', phase: 'done', effortLevel: 3, spark: [0, 0] }, 24, 7, 0)
    expect(rowText(still, 1)).toContain('━')
  })

  test('resample keeps bursts and the requested length', async () => {
    expect(resample([0, 0, 4, 0], 2)).toEqual([0, 3])
    expect(resample([], 3)).toEqual([0, 0, 0])
    expect(resample([2], 4)).toEqual([2, 2, 2, 2])
  })

  test('tool results summarise to a line count or their one line', async () => {
    expect(resultSummary('a\nb\nc\n', false)).toBe('3 lines')
    expect(resultSummary('  only line  ', false)).toBe('only line')
    expect(resultSummary('boom\nstack\nmore', true)).toBe('boom')
    expect(resultSummary('', false)).toBeUndefined()
  })

  test('the pill spins and keeps its width', async () => {
    const pill = pillFrame('2 agents working', 5)
    expect(pill.columns).toBe('2 agents working'.length + 2)
    expect(rowText(pill, 0).slice(2)).toBe('2 agents working')
    expect(cellAt(pill, 0, 0).ch).not.toBe(' ')
  })
})

/** A test hook beneath the plugin: thinking, then text, then a Grep call. */
async function* thinkThenGrep(e: { turnId: string; index: number }) {
  yield { kind: 'thinking' as const, index: 0, text: 'Where do the auth ' }
  yield { kind: 'thinking' as const, index: 0, text: 'handlers live?' }
  yield { kind: 'text' as const, index: 1, text: 'Searching for handlers.' }
  yield { kind: 'tool' as const, index: 2, id: 'tu_grep', name: 'Grep' }
  yield { kind: 'stop' as const, stopReason: 'tool_use' as const, usage: USAGE }

  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: USAGE }
}

async function agentWithActivity($: any, on: any) {
  mock.clock(on, { now: 5_000_000 })
  on('agent.spawn', (_$: unknown, e: { tool_use_id: string }) => ({
    model: 'claude-sonnet-5-5',
    agentId: e.tool_use_id === 'toolu_1' ? 'agent-1' : 'agent-2',
  }))
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number }) {
    return yield* thinkThenGrep(e)
  })
  on('tool.call', () => ({ result: { matches: 3 }, text: 'src/a.ts\nsrc/b.ts\nsrc/c.ts' }))
  await $.agent.spawn(SPAWN)
  await step($, 'agent-1')
  await $.tool.call({ tool: 'Grep', tool_use_id: 'tu_grep', pattern: 'auth', agentId: 'agent-1' })
}

test('clicking an agent opens its live timeline below the cards', async ($, on) => {
  await agentWithActivity($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'inspector' })).toBeUndefined()
    expect(await ui.find({ text: / · click one/ })).toBeDefined()

    await ui.press({ key: 'pick-agent-1' })
    expect(await ui.find({ key: 'inspector' })).toBeDefined()
    expect(await ui.find({ text: /Find the auth handlers/ })).toBeDefined()
    expect(await ui.find({ text: /Where do the auth handlers live\?/ })).toBeDefined()
    expect(await ui.find({ text: /Searching for handlers\./ })).toBeDefined()
    expect(await ui.find({ text: /^Grep$/ })).toBeDefined()
    expect(await ui.find({ text: /3 lines/ })).toBeDefined()
    expect(await ui.find({ text: '1/1' })).toBeDefined()

    await ui.press({ key: 'inspect-hide' })
    expect(await ui.find({ key: 'inspector' })).toBeUndefined()
    await ui.press({ key: 'pick-agent-1' })
    await ui.press({ key: 'pick-agent-1' })
    expect(await ui.find({ key: 'inspector' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the inspector shows the final answer, and prev/next walk the agents', async ($, on) => {
  on('turn.complete', () => ({ text: 'ok' }))
  await agentWithActivity($, on)
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_2', description: 'second scout' })
  await $.turn.complete({
    answer: 'The handlers are in src/auth.',
    durationMs: 10,
    isAborted: false,
    turnId: 't1',
    agentId: 'agent-1',
    reason: 'answer',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'pick-agent-1' })
  expect(await ui.find({ text: /finished in/ })).toBeDefined()
  expect(await ui.find({ text: /The handlers are in src\/auth\./ })).toBeDefined()
  expect(await ui.find({ text: '2/2' })).toBeDefined()
  await ui.press({ key: 'inspect-next' })
  expect(await ui.find({ text: '1/2' })).toBeDefined()
  expect(await ui.find({ text: /waiting for its first move/ })).toBeDefined()
  await ui.unmount()
})

test('a selected agent holds the view open when all finish', { options: { autoClose: '10s' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 6_000_000 })
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  on('turn.complete', () => ({ text: 'ok' }))
  await $.agent.spawn(SPAWN)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'pick-agent-1' })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', agentId: 'agent-1', reason: 'answer' })
  expect(await ui.find({ text: /closing in/ })).toBeUndefined()
  await clock.advance(20_000)
  expect(await isOpenView(ui)).toBe(true)
})

const MODE = { plugin: 'agent-swarm', component: 'SessionMode', props: { modes: [] as string[] } } as const

test('a purple pill in the footer replaces the status line while agents work', async ($, on) => {
  mock.clock(on, { now: 7_000_000 })
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine modes'] }))
  await $.agent.spawn(SPAWN)

  let ui = await $.ui.mount({ ...MODE, surface: 'terminal' })
  expect(await ui.find({ type: 'Raster', key: 'swarm-pill' })).toBeDefined()
  await ui.unmount()
  const desk = await $.ui.mount({ ...MODE, props: { modes: ['focus'] }, surface: 'desktop' })
  expect(await desk.find({ text: '✻ 1 agent working' })).toBeDefined()
  expect(await desk.find({ text: 'focus' })).toBeDefined()
  await desk.unmount()

  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', agentId: 'agent-1', reason: 'answer' })
  ui = await $.ui.mount({ ...MODE, surface: 'terminal' })
  expect(await ui.find({ type: 'Raster', key: 'swarm-pill' })).toBeUndefined()
  expect(await ui.find({ text: 'engine modes' })).toBeDefined()
  await ui.unmount()
})

test('every width from a phone-narrow dock to a wide terminal draws', { options: { autoClose: '30s' } }, async ($, on) => {
  const { ui } = await finishedWithPaneOpen($, on)
  await ui.unmount()
  for (const bodyColumns of [24, 32, 40, 48, 64, 90, 120, 200]) {
    for (const isCompact of [false, true]) {
      const pane = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns }, surface: 'terminal' })
      if (isCompact) await pane.press({ key: 'compact' })
      await pane.press({ key: 'pick-agent-1' })
      expect(await pane.find({ key: 'inspector' })).toBeDefined()
      expect(await pane.find({ key: 'clear' })).toBeDefined()
      expect(await pane.find({ text: /done/ })).toBeDefined()
      await pane.press({ key: 'pick-agent-1' })
      if (isCompact) await pane.press({ key: 'compact' })
      await pane.unmount()
    }
  }
})

test('a click anywhere on a card or a compact line toggles the inspector', async ($, on) => {
  await agentWithActivity($, on)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Client', key: 'hit-core-agent-1' })).toBeDefined()
  await ui.pointer({ type: 'down', x: 12, y: 3, button: 'left', in: 'hit-core-agent-1' })
  expect(await ui.find({ key: 'inspector' })).toBeDefined()
  await ui.pointer({ type: 'down', x: 2, y: 8, button: 'left', in: 'hit-core-agent-1' })
  expect(await ui.find({ key: 'inspector' })).toBeUndefined()

  await ui.press({ key: 'compact' })
  await ui.pointer({ type: 'down', x: 30, y: 2, button: 'left', in: 'hit-core-agent-1' })
  expect(await ui.find({ key: 'inspector' })).toBeDefined()
  await ui.press({ key: 'compact' })
  await ui.unmount()
})

test('prev walks backwards and wraps from the first agent to the last', async ($, on) => {
  await agentWithActivity($, on)
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'toolu_2', description: 'second scout' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'pick-agent-1' })
  expect(await ui.find({ text: '1/2' })).toBeDefined()
  await ui.press({ key: 'inspect-prev' })
  expect(await ui.find({ text: '2/2' })).toBeDefined()
  expect(await ui.find({ text: /waiting for its first move/ })).toBeDefined()
  await ui.press({ key: 'inspect-prev' })
  expect(await ui.find({ text: '1/2' })).toBeDefined()
  await ui.unmount()
})

test('picking a folded square unfolds the view on that agent', async ($, on) => {
  await agentWithActivity($, on)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  for (let i = 0; i < 2; i++) {
    await ui.press({ key: 'close' })
    await ui.press({ key: 'band-pick-agent-1' })
    // A square never toggles the inspector off: picked twice, the agent is still shown.
    expect(await isOpenView(ui)).toBe(true)
    expect(await ui.find({ key: 'inspector' })).toBeDefined()
    expect(await ui.find({ text: /Find the auth handlers/ })).toBeDefined()
  }
  await ui.unmount()
})

for (const [reason, phase, label] of [
  ['error', 'FAILED', 'failed in'],
  ['aborted', 'STOPPED', 'stopped in'],
] as const) {
  test(`an agent ending with ${reason} reads ${phase.toLowerCase()} on its card and in the inspector`, { options: { autoClose: '10s' } }, async ($, on) => {
    on('turn.complete', () => ({ text: 'ok' }))
    await agentWithActivity($, on)

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await $.turn.complete({ answer: '', durationMs: 5, isAborted: reason === 'aborted', turnId: 't1', agentId: 'agent-1', reason })
    expect(await ui.find({ text: phase })).toBeDefined()
    expect(await ui.find({ text: /1 failed/ })).toBeDefined()
    // Finished either way, so the pane still counts down.
    expect(await ui.find({ text: /closing in 10s/ })).toBeDefined()

    await ui.press({ key: 'pick-agent-1' })
    expect(await ui.find({ text: new RegExp(label) })).toBeDefined()
    expect(await ui.find({ text: /closing in/ })).toBeUndefined()

    await ui.press({ key: 'compact' })
    expect(await ui.find({ text: phase })).toBeDefined()
    await ui.unmount()
  })
}

test('/swarm demo plays a scripted swarm to the end, priced, with a child agent', { timeoutMs: 120_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 5_000_000 })
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  await $.session.start(START)

  const started = (await $.command.run(swarmCommand('demo'))) as { text: string }
  expect(started.text).toMatch(/6 agents/)
  expect(((await $.command.run(swarmCommand('demo'))) as { text: string }).text).toMatch(/already running/)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await isOpenView(ui)).toBe(true)

  const run = async (ms: number) => {
    for (let t = 0; t < ms; t += 50) await clock.advance(50)
  }
  await run(10_000)
  expect(await ui.find({ type: 'Text', text: /\b5 live · 0 done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$\d+\.\d\d/ })).toBeDefined()
  await run(30_000)
  expect(await ui.find({ type: 'Text', text: /\b6 live/ })).toBeDefined()

  await run(55_000)
  expect(await ui.find({ type: 'Text', text: /\b0 live · 6 done/ })).toBeDefined()
  await ui.press({ key: 'pick-demo-' + (5_000_000).toString(36) + '-fixer' })
  expect(await ui.find({ text: /Fixed invoice\.ts/ })).toBeDefined()
  await ui.unmount()
})
