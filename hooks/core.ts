// Pure drawing helpers for agent-swarm: palettes, effort mapping and the
// animated "core" each card carries, packed as Raster cells.

import type { SwarmAgent, SwarmLogEntry, SwarmPhase, SwarmUsage } from '../types'

export const CORE_ROWS = 3

const DEFAULT_BG = 0x01000000

type Ramp = readonly [number, number, number, number, number]

export const RAMPS: Record<SwarmPhase, Ramp> = {
  thinking: [0x241a4d, 0x45309a, 0x7c5cff, 0xb39dff, 0xe9e1ff],
  writing: [0x0a3442, 0x0e6e85, 0x14b3d1, 0x5fe3f7, 0xd2faff],
  tool: [0x3a2405, 0x7a4a06, 0xd98a0b, 0xffb733, 0xffe6ad],
  spawning: [0x1f2933, 0x334155, 0x64748b, 0x94a3b8, 0xcbd5e1],
  done: [0x0d3b2c, 0x13684a, 0x1fa36f, 0x34d399, 0xa7f3d0],
  failed: [0x3f1212, 0x7f1d1d, 0xdc2626, 0xf87171, 0xfecaca],
  stopped: [0x1e293b, 0x334155, 0x64748b, 0x94a3b8, 0xcbd5e1],
}

let isLight = false

/** Light themes flip every ramp, so the faint steps fade into a light background and accents read dark. */
export function setLightTheme(theme: unknown): boolean {
  const was = isLight
  isLight = typeof theme === 'string' && theme.startsWith('light')

  return was !== isLight
}

const LIGHT_RAMPS = Object.fromEntries(
  Object.entries(RAMPS).map(([phase, r]) => [phase, [...r].reverse()]),
) as unknown as Record<SwarmPhase, Ramp>

export const isLightTheme = (): boolean => isLight

export const ramp = (phase: SwarmPhase): Ramp => (isLight ? LIGHT_RAMPS : RAMPS)[phase]

export const hex = (rgb: number): string => `#${rgb.toString(16).padStart(6, '0')}`

const hexes = new Map<number, string>()
const hexOf = (rgb: number): string => {
  let h = hexes.get(rgb)
  if (h === undefined) {
    h = hex(rgb)
    hexes.set(rgb, h)
  }

  return h
}

/** A phase's ramp step as a `#rrggbb` color, step 3 its accent. */
export const phaseTone = (phase: SwarmPhase, step: 0 | 1 | 2 | 3 | 4): string => hexOf(ramp(phase)[step])

export const phaseColor = (phase: SwarmPhase): string => phaseTone(phase, 3)

export const isLive = (phase: SwarmPhase): boolean =>
  phase !== 'done' && phase !== 'failed' && phase !== 'stopped'

// ── effort ──────────────────────────────────────────────────────────────

export const EFFORT_NAMES = ['—', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export const EFFORT_COLORS = [
  '#64748b',
  '#34d399',
  '#2dd4bf',
  '#facc15',
  '#fb923c',
  '#f472b6',
] as const

export function effortLevel(effort: string | number | undefined): number {
  if (effort === undefined) return 0
  if (typeof effort === 'number') {
    if (effort < 4_000) return 1
    if (effort < 16_000) return 2
    if (effort < 32_000) return 3
    if (effort < 64_000) return 4

    return 5
  }
  const at = EFFORT_NAMES.indexOf(effort as (typeof EFFORT_NAMES)[number])

  return at > 0 ? at : 0
}

export function effortLabel(effort: string | undefined, level: number): string {
  if (effort === undefined) return 'default'
  if (/^\d+$/.test(effort)) return `${Math.round(Number(effort) / 1000)}k`

  return EFFORT_NAMES[level] ?? effort
}

export function effortMeter(level: number): { on: string; off: string } {
  return { on: '▰'.repeat(level), off: '▱'.repeat(5 - level) }
}

/** btop-style: green → amber → rose across the meter, so max reads hot. */
const EFFORT_GRADIENT_DARK = [0x34d399, 0xfacc15, 0xf43f5e] as const
const EFFORT_GRADIENT_LIGHT = [0x059669, 0xca8a04, 0xe11d48] as const
const effortGradient = () => (isLight ? EFFORT_GRADIENT_LIGHT : EFFORT_GRADIENT_DARK)

const mix = (a: number, b: number, t: number): number => {
  const ch = (shift: number) =>
    Math.round(((a >> shift) & 255) + (((b >> shift) & 255) - ((a >> shift) & 255)) * t)

  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

export function gradient(stops: readonly number[], t: number): number {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(x))

  return mix(stops[i] ?? 0, stops[i + 1] ?? 0, x - i)
}

type EffortCell = { ch: string; color: string; isOn: boolean }
const effortMemo = new Map<string, readonly EffortCell[]>()

/** Five meter cells: each lit one coloured by its place on the gradient. */
export function effortCells(level: number): readonly EffortCell[] {
  const key = `${level}${isLight ? 'l' : 'd'}`
  let cells = effortMemo.get(key)
  if (cells === undefined) {
    cells = Array.from({ length: 5 }, (_, i) => ({
      ch: i < level ? '▰' : '▱',
      color: hex(gradient(effortGradient(), i / 4)),
      isOn: i < level,
    }))
    effortMemo.set(key, cells)
  }

  return cells
}

export const effortColor = (level: number): string =>
  level === 0 ? '#64748b' : hex(gradient(effortGradient(), (level - 1) / 4))

// ── small formatting ────────────────────────────────────────────────────

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const pad = (n: number) => String(n).padStart(2, '0')

  return h > 0 ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

export function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`

  return `${(n / 1_000_000).toFixed(1)}M`
}

const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'] as const

export const modelFamily = (model: string | undefined): string | undefined =>
  FAMILIES.find(f => model?.toLowerCase().includes(f))

export function shortModel(model: string): string {
  return modelFamily(model) ?? (model.length > 12 ? model.slice(0, 12) : model)
}

// ── tokens and cost ─────────────────────────────────────────────────────

/** List price in US dollars per million tokens; cache writes are 1.25× input (5-minute TTL). */
type Price = { input: number; output: number; cacheRead: number }

// First match wins, so a specific version sits above its family's fallback.
const PRICES: readonly (readonly [RegExp, Price])[] = [
  [/(fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 1 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus-(5|4-[5-9])/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/opus/, { input: 15, output: 75, cacheRead: 1.5 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/haiku-4/, { input: 1, output: 5, cacheRead: 0.1 }],
  [/3-5-haiku|haiku-3-5/, { input: 0.8, output: 4, cacheRead: 0.08 }],
  [/haiku/, { input: 0.25, output: 1.25, cacheRead: 0.03 }],
]

export function priceOf(model: string): Price | undefined {
  const m = model.toLowerCase()

  return PRICES.find(([re]) => re.test(m))?.[1]
}

type ApiUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export const toUsage = (u: ApiUsage): SwarmUsage => ({
  input: u.input_tokens,
  output: u.output_tokens,
  cacheRead: u.cache_read_input_tokens,
  cacheWrite: u.cache_creation_input_tokens,
})

/** Estimated list-price dollars for `u`, or undefined when the model has no known price. */
export function usageCost(u: SwarmUsage, model: string): number | undefined {
  const p = priceOf(model)
  if (p === undefined) return undefined

  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.input * 1.25) / 1e6
}

export const promptTokens = (u: SwarmUsage): number => u.input + u.cacheRead + u.cacheWrite

/** Folds one model response into an agent's running totals. */
export function addUsage(
  a: SwarmAgent,
  raw: ApiUsage,
  models: readonly string[],
): Pick<SwarmAgent, 'usage' | 'costUsd' | 'isCostPartial' | 'context'> {
  const u = toUsage(raw)
  const prev = a.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const cost = models.map(m => usageCost(u, m)).find(c => c !== undefined)

  return {
    usage: {
      input: prev.input + u.input,
      output: prev.output + u.output,
      cacheRead: prev.cacheRead + u.cacheRead,
      cacheWrite: prev.cacheWrite + u.cacheWrite,
    },
    costUsd: cost === undefined ? a.costUsd : (a.costUsd ?? 0) + cost,
    isCostPartial: a.isCostPartial === true || cost === undefined,
    context: promptTokens(u) + u.output,
  }
}

export function usd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01'
  if (n < 100) return `$${n.toFixed(2)}`

  return `$${Math.round(n)}`
}

/** An agent's cost as a card shows it: `+` marks a floor, undefined when nothing is priced. */
export function costLabel(a: Pick<SwarmAgent, 'costUsd' | 'isCostPartial'>): string | undefined {
  if (a.costUsd === undefined) return undefined

  return `${usd(a.costUsd)}${a.isCostPartial === true ? '+' : ''}`
}

/** Keeps the leading parts that fit in `width`, joined by `sep`; never cuts one mid-way. */
export function fitParts(parts: readonly string[], width: number, sep = ' · '): string {
  let out = ''
  for (const part of parts) {
    const next = out === '' ? part : `${out}${sep}${part}`
    if (next.length > width) break
    out = next
  }

  return out
}

/** The card's metrics after the cost: context, output, cache hit rate. */
export function usageParts(a: Pick<SwarmAgent, 'usage' | 'context' | 'costUsd'>): string[] {
  const u = a.usage
  if (u === undefined) return []
  const prompt = promptTokens(u)
  const parts: string[] = []
  if (a.costUsd === undefined) parts.push(`${compact(prompt)} in`)
  if (a.context !== undefined) parts.push(`ctx ${compact(a.context)}`)
  parts.push(`${compact(u.output)} out`)
  if (prompt > 0) parts.push(`${Math.round((u.cacheRead / prompt) * 100)}% cached`)

  return parts
}

// ── auto-close ──────────────────────────────────────────────────────────

export const AUTO_CLOSE_CHOICES = ['off', '10s', '30s', '1m', '5m'] as const

export function autoCloseMs(value: unknown): number {
  const m = typeof value === 'string' ? /^(\d+)(s|m)$/.exec(value) : null
  if (m === null) return 0

  return Number(m[1]) * (m[2] === 'm' ? 60_000 : 1000)
}

const TOOL_GLYPHS: Record<string, { glyph: string; color: string }> = {
  Read: { glyph: 'R', color: '#60a5fa' },
  Grep: { glyph: 'G', color: '#a78bfa' },
  Glob: { glyph: 'g', color: '#a78bfa' },
  Bash: { glyph: '$', color: '#fbbf24' },
  Edit: { glyph: 'E', color: '#34d399' },
  Write: { glyph: 'W', color: '#10b981' },
  NotebookEdit: { glyph: 'N', color: '#10b981' },
  WebFetch: { glyph: 'F', color: '#f472b6' },
  WebSearch: { glyph: 'S', color: '#ec4899' },
  Agent: { glyph: 'A', color: '#fb923c' },
  Skill: { glyph: 'K', color: '#2dd4bf' },
  TodoWrite: { glyph: 'T', color: '#94a3b8' },
  LSP: { glyph: 'L', color: '#38bdf8' },
}

/** The tools an agent called, newest last, one colored glyph each; an error is set on red. */
export function trailFrame(trail: readonly { tool: string; isError: boolean }[]): Canvas {
  const c = canvas(trail.length, 1)
  c.bg = new Uint32Array(trail.length).fill(DEFAULT_BG)
  trail.forEach((step, x) => {
    const g = toolGlyph(step.tool)
    c.ch[x] = g.glyph.charCodeAt(0)
    if (step.isError) {
      c.fg[x] = 0xfecaca
      c.bg![x] = 0x7f1d1d
    } else {
      c.fg[x] = Number.parseInt(g.color.slice(1), 16)
    }
  })

  return c
}

export function toolGlyph(tool: string): { glyph: string; color: string } {
  const known = TOOL_GLYPHS[tool]
  if (known) return known
  if (tool.startsWith('mcp__')) return { glyph: 'm', color: '#c084fc' }

  return { glyph: tool.charAt(0).toUpperCase() || '?', color: '#cbd5e1' }
}

const ARG_KEYS = [
  'command',
  'pattern',
  'file_path',
  'path',
  'url',
  'query',
  'skill',
  'description',
  'prompt',
] as const

/** A short, one-line hint of what a tool call is about. */
export function toolArg(input: Record<string, unknown>): string | undefined {
  for (const key of ARG_KEYS) {
    const value = input[key]
    if (typeof value !== 'string' || value.trim() === '') continue
    const line = value.replace(/\s+/g, ' ').trim()
    if (key === 'file_path' || key === 'path') {
      return line.split('/').filter(Boolean).pop() ?? line
    }

    return line.length > 60 ? `${line.slice(0, 59)}…` : line
  }

  return undefined
}

// ── the inspector's timeline ────────────────────────────────────────────

export const LOG_KEEP = 40
const LOG_TEXT_KEEP = 600

/** Whitespace folded to single spaces, the tail kept when longer than `max`. */
export function tail(text: string, max: number = LOG_TEXT_KEEP): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `…${flat.slice(-(max - 1))}` : flat
}

/** Whitespace folded, the head kept when longer than `max`. */
export function head(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** What a tool call came back with, in a few words: its line count, or its one line. */
export function resultSummary(text: string | undefined, isError: boolean): string | undefined {
  const lines = (text ?? '').split('\n').filter(l => l.trim() !== '')
  if (lines.length === 0) return undefined
  if (!isError && lines.length > 2) return `${lines.length} lines`

  return head(lines[0]!, 60)
}

export function appendLog(log: readonly SwarmLogEntry[] | undefined, entry: SwarmLogEntry): SwarmLogEntry[] {
  return [...(log ?? []), entry].slice(-LOG_KEEP)
}

/** `0.4s`, `12s`, `1:05`: a tool call's duration. */
export function duration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`

  return clock(ms)
}

// ── canvases: what every animated frame is drawn into ────────────────────

/** A grid of cells as parallel arrays, reusable frame to frame: code point, color, and a background where one is set. */
export type Canvas = { columns: number; rows: number; ch: Uint32Array; fg: Uint32Array; bg?: Uint32Array }

const SPACE = 0x20

export function canvas(columns: number, rows: number): Canvas {
  const n = Math.max(0, columns * rows)
  const c = { columns, rows, ch: new Uint32Array(n), fg: new Uint32Array(n) }
  clear(c)

  return c
}

function clear(c: Canvas): void {
  c.ch.fill(SPACE)
  c.fg.fill(DEFAULT_BG)
}

/** `into` when it has the size, else a new canvas; either way blank. */
function blankCanvas(columns: number, rows: number, into?: Canvas): Canvas {
  if (into === undefined || into.columns !== columns || into.rows !== rows) return canvas(columns, rows)
  clear(into)

  return into
}

/** One row's text, for tests and the plain-text fallbacks. */
export function rowText(c: Canvas, y: number): string {
  let out = ''
  for (let x = 0; x < c.columns; x++) out += String.fromCharCode(c.ch[y * c.columns + x]!)

  return out
}

export const cellAt = (c: Canvas, x: number, y: number): { ch: string; fg: number } => ({
  ch: String.fromCharCode(c.ch[y * c.columns + x]!),
  fg: c.fg[y * c.columns + x]!,
})

function text(c: Canvas, x: number, y: number, s: string, fg: number): void {
  for (let i = 0; i < s.length && x + i < c.columns; i++) {
    const k = y * c.columns + x + i
    c.ch[k] = s.charCodeAt(i)
    c.fg[k] = fg
  }
}

// ── packing: RasterProps' cells are [codePoint, fg, bg] u32 LE, base64 ──

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const CELL_CACHE_MAX = 16_384
/** A cell is 12 bytes, so 16 base64 characters of its own: each distinct cell is encoded once. */
const encoded = new Map<number, string>()
const word = new Uint32Array(3)
const wordBytes = new Uint8Array(word.buffer)

function encodeCell(cp: number, fg: number, bg: number = DEFAULT_BG): string {
  word[0] = cp
  word[1] = fg
  word[2] = bg
  let out = ''
  for (let i = 0; i < 12; i += 3) {
    const n = (wordBytes[i]! << 16) | (wordBytes[i + 1]! << 8) | wordBytes[i + 2]!
    out += B64[n >>> 18]! + B64[(n >>> 12) & 63]! + B64[(n >>> 6) & 63]! + B64[n & 63]!
  }

  return out
}

/** Packs a canvas as RasterProps' `cells`. */
export function packCells(c: Canvas): string {
  if (encoded.size > CELL_CACHE_MAX) encoded.clear()
  let out = ''
  for (let k = 0; k < c.ch.length; k++) {
    const cp = c.ch[k]!
    const fg = c.fg[k]!
    if (c.bg !== undefined && c.bg[k] !== DEFAULT_BG) {
      out += encodeCell(cp, fg, c.bg[k])
      continue
    }
    // fg holds 25 bits (the default-color flag included), so the pair fits a double exactly.
    const key = cp * 0x2000000 + fg
    let cell = encoded.get(key)
    if (cell === undefined) {
      cell = encodeCell(cp, fg)
      encoded.set(key, cell)
    }
    out += cell
  }

  return out
}

// ── the footer pill: a purple shimmer over "N agents working" ────────────

const SPINNER = '·✢✳✶✻✽✻✶✳✢'
const PILL_DARK = [0x45309a, 0x7c5cff, 0xb39dff, 0xe9e1ff] as const
const PILL_LIGHT = [0xc4b5fd, 0x7c5cff, 0x5b21b6, 0x2e1065] as const

export const pillText = (live: number): string => `${live} agent${live === 1 ? '' : 's'} working`

/** One row: a spinning star, then the text with a light sweeping across it. */
export function pillFrame(label: string, t: number, into?: Canvas): Canvas {
  const tones = isLight ? PILL_LIGHT : PILL_DARK
  const c = blankCanvas(label.length + 2, 1, into)
  c.ch[0] = SPINNER.charCodeAt(Math.floor(t / 2) % SPINNER.length)
  c.fg[0] = tones[3]
  const span = label.length + 12
  const at = ((t * 0.6) % span) - 6
  const sweep = tones.slice(1)
  for (let i = 0; i < label.length; i++) {
    const glow = Math.max(0, 1 - Math.abs(i - at) / 4)
    c.ch[i + 2] = label.charCodeAt(i)
    // Quantised, so a still stretch of the sweep packs from the cell cache.
    c.fg[i + 2] = gradient(sweep, Math.round(glow * 16) / 16)
  }

  return c
}

// ── the animated core ───────────────────────────────────────────────────

const BARS = '▁▂▃▄▅▆▇█'
const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const
const ch = (s: string): number => s.charCodeAt(0)
const SCAN = [ch('█'), ch('▓'), ch('▒'), ch('░'), ch('─')] as const

const hash = (a: number, b: number, c: number): number => {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)

  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

const rampAt = (ramp: Ramp, v: number): number =>
  ramp[Math.max(0, Math.min(4, Math.round(v * 4)))] ?? ramp[0]

const seeds = new Map<string, number>()

/** A small per-agent offset, so cards side by side do not animate in lockstep. */
function seedOf(id: string): number {
  let seed = seeds.get(id)
  if (seed === undefined) {
    let n = 0
    for (let i = 0; i < id.length; i++) n += id.charCodeAt(i)
    seed = n % 97
    if (seeds.size > 4096) seeds.clear()
    seeds.set(id, seed)
  }

  return seed
}

/** Scratch rows for the plasma's separable terms, grown as needed. */
let scratch = new Float64Array(0)
const scratchOf = (n: number): Float64Array => {
  if (scratch.length < n) scratch = new Float64Array(n * 2)

  return scratch
}

/**
 * The thinking plasma: three sines summed per braille dot. Each depends on one
 * axis or one diagonal, so a frame takes a row of each instead of a sine a dot.
 */
function plasma(c: Canvas, seed: number, effort: number, t: number, energy: number, tones: Ramp): void {
  const { columns: w, rows } = c
  const speed = 0.08 + 0.06 * effort
  const threshold = 0.74 - 0.045 * effort - 0.12 * energy
  const cut = threshold * 6 - 3
  const dotsX = w * 2
  const dotsY = rows * 4
  const buf = scratchOf(dotsX * 3 + dotsY * 2 + dotsX + dotsY)
  // a(px) = sin(px·0.21 + t·s); the middle sine is sin(A(py) + B(px)), split by the sum rule.
  const a = 0
  const sinB = dotsX
  const cosB = dotsX * 2
  const sinA = dotsX * 3
  const cosA = sinA + dotsY
  const diag = cosA + dotsY
  for (let i = 0; i < dotsX; i++) {
    const px = i + seed
    buf[a + i] = Math.sin(px * 0.21 + t * speed)
    buf[sinB + i] = Math.sin(px * 0.05)
    buf[cosB + i] = Math.cos(px * 0.05)
  }
  for (let py = 0; py < dotsY; py++) {
    const angle = py * 0.85 - t * speed * 0.7
    buf[sinA + py] = Math.sin(angle)
    buf[cosA + py] = Math.cos(angle)
  }
  for (let k = 0; k < dotsX + dotsY; k++) buf[diag + k] = Math.sin((k + seed) * 0.13 + t * speed * 1.3)

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < w; x++) {
      let bits = 0
      let lit = 0
      for (let dy = 0; dy < 4; dy++) {
        const py = y * 4 + dy
        const sA = buf[sinA + py]!
        const cA = buf[cosA + py]!
        for (let dx = 0; dx < 2; dx++) {
          const i = x * 2 + dx
          const v = buf[a + i]! + sA * buf[cosB + i]! + cA * buf[sinB + i]! + buf[diag + i + py]!
          if (v > cut) {
            bits |= BRAILLE_BITS[dy]![dx]!
            lit++
          }
        }
      }
      if (bits !== 0) {
        const k = y * w + x
        c.ch[k] = 0x2800 + bits
        c.fg[k] = rampAt(tones, 0.25 + lit / 10)
      }
    }
  }
}

/**
 * One frame of an agent's core: `columns` × `rows` cells, drawn into `into` when
 * it has that size. `t` is the animation clock in ticks, `energy` 0..1 the recent stream rate.
 */
export function coreFrame(
  agent: Pick<SwarmAgent, 'phase' | 'effortLevel' | 'id'> & Partial<Pick<SwarmAgent, 'spark'>>,
  columns: number,
  t: number,
  energy: number,
  rows: number = CORE_ROWS,
  into?: Canvas,
): Canvas {
  const w = Math.max(1, columns)
  const effort = agent.effortLevel || 2
  const tones = ramp(agent.phase)
  const seed = seedOf(agent.id)

  if (!isLive(agent.phase) && rows > 1 && (agent.spark ?? []).some(v => v > 0)) {
    const label = agent.phase === 'done' ? '✓ complete' : agent.phase === 'failed' ? '✕ failed' : 'stopped'

    return historyFrame(agent.spark ?? [], w, rows, agent.phase, label, into)
  }
  const c = blankCanvas(w, rows, into)
  const put = (x: number, y: number, glyph: number, fg: number) => {
    c.ch[y * w + x] = glyph
    c.fg[y * w + x] = fg
  }

  switch (agent.phase) {
    case 'thinking':
      // A braille plasma: denser and quicker the harder the agent thinks.
      plasma(c, seed, effort, t, energy, tones)
      break
    case 'writing': {
      // An equalizer: bars bounce with how fast text is streaming.
      const speed = 0.12 + 0.05 * effort
      const gain = 0.35 + 0.65 * Math.max(energy, 0.3)
      for (let x = 0; x < w; x++) {
        const wave =
          0.5 +
          0.5 * (0.6 * Math.sin((x + seed) * 0.55 + t * speed) + 0.4 * Math.sin(x * 0.17 - t * speed * 1.7))
        const eighths = Math.round(wave * gain * rows * 8)
        for (let fromBottom = 0; fromBottom < rows; fromBottom++) {
          const fill = Math.max(0, Math.min(8, eighths - fromBottom * 8))
          if (fill === 0) continue
          put(x, rows - 1 - fromBottom, BARS.charCodeAt(fill - 1), rampAt(tones, 0.3 + (fromBottom + fill / 8) / (rows + 1)))
        }
      }
      break
    }
    case 'tool': {
      // A scanner sweeping back and forth, sparks flying off its head.
      const speed = 0.07 + 0.045 * effort
      const scanAt = ((Math.sin(t * speed + seed) + 1) / 2) * (w - 1)
      const trailLen = 2 + effort
      const mid = Math.floor(rows / 2)
      const sparkT = Math.floor(t / 2)
      for (let x = 0; x < w; x++) {
        const b = Math.max(0, 1 - Math.abs(x - scanAt) / trailLen)
        const glyph = SCAN[b > 0.8 ? 0 : b > 0.55 ? 1 : b > 0.3 ? 2 : b > 0.08 ? 3 : 4]
        put(x, mid, glyph, b > 0.08 ? rampAt(tones, 0.3 + b * 0.7) : tones[1])
        if (b === 0) continue
        for (let y = 0; y < rows; y++) {
          if (y === mid) continue
          if (hash(x, sparkT, y + seed) < b * 0.45) put(x, y, b > 0.6 ? 0x2022 : 0xb7, rampAt(tones, 0.5 + b * 0.5))
        }
      }
      break
    }
    case 'spawning': {
      // A slow breath from the middle out.
      const breath = (Math.sin(t * 0.18) + 1) / 2
      const radius = 1 + breath * (w / 3)
      const mid = Math.floor(rows / 2)
      for (let x = 0; x < w; x++) {
        const d = Math.abs(x - (w - 1) / 2)
        if (d > radius) continue
        const v = 1 - d / radius
        put(x, mid, v > 0.7 ? 0x25cf : v > 0.35 ? 0x2022 : 0xb7, rampAt(tones, 0.3 + v * 0.7))
      }
      break
    }
    default: {
      // Finished with no history: a still line with the outcome in the middle.
      const label =
        agent.phase === 'done' ? ' ✓ complete ' : agent.phase === 'failed' ? ' ✕ failed ' : ' stopped '
      const mid = Math.floor(rows / 2)
      const start = Math.max(0, Math.floor((w - label.length) / 2))
      for (let x = 0; x < w; x++) {
        const at = x - start
        if (at >= 0 && at < label.length) put(x, mid, label.charCodeAt(at), tones[4])
        else put(x, mid, 0x2501, rampAt(tones, 0.25 + 0.5 * (1 - Math.abs(x - w / 2) / (w / 2))))
      }
    }
  }

  return c
}

// ── a finished agent's whole run ────────────────────────────────────────

const AREA_LEFT = [0x40, 0x04, 0x02, 0x01] as const
const AREA_RIGHT = [0x80, 0x20, 0x10, 0x08] as const

/** `samples` squeezed into `n` points: each bucket's mean leaning to its peak, so bursts survive. */
export function resample(samples: readonly number[], n: number): number[] {
  const out = Array<number>(n).fill(0)
  if (samples.length === 0) return out
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * samples.length) / n)
    const to = Math.max(from + 1, Math.floor(((i + 1) * samples.length) / n))
    let sum = 0
    let peak = -Infinity
    for (let k = from; k < to; k++) {
      const v = samples[k]!
      sum += v
      if (v > peak) peak = v
    }
    out[i] = 0.5 * (sum / (to - from)) + 0.5 * peak
  }

  return out
}

/**
 * A filled braille area chart of the run, `rows` tall (4 dots a row), scaled to
 * its own peak and shaded brighter towards the top; `label` sits top left.
 */
export function historyFrame(
  samples: readonly number[],
  columns: number,
  rows: number,
  phase: SwarmPhase,
  label: string,
  into?: Canvas,
): Canvas {
  const tones = ramp(phase)
  const dots = rows * 4
  const points = resample(samples, columns * 2)
  let peak = 0.001
  for (const v of points) if (v > peak) peak = v
  const c = blankCanvas(columns, rows, into)
  for (let x = 0; x < columns; x++) {
    const hl = points[x * 2]! <= 0 ? 0 : Math.max(1, Math.round((points[x * 2]! / peak) * dots))
    const hr = (points[x * 2 + 1] ?? 0) <= 0 ? 0 : Math.max(1, Math.round((points[x * 2 + 1]! / peak) * dots))
    for (let y = 0; y < rows; y++) {
      const floor = (rows - 1 - y) * 4
      const l = Math.max(0, Math.min(4, hl - floor))
      const r = Math.max(0, Math.min(4, hr - floor))
      let bits = 0
      for (let d = 0; d < l; d++) bits |= AREA_LEFT[d]!
      for (let d = 0; d < r; d++) bits |= AREA_RIGHT[d]!
      const k = y * columns + x
      if (bits !== 0) {
        c.ch[k] = 0x2800 + bits
        c.fg[k] = rampAt(tones, 0.4 + (0.6 * (rows - y)) / rows)
      } else if (y === rows - 1) {
        c.ch[k] = 0x28c0
        c.fg[k] = tones[1]
      }
    }
  }
  text(c, 0, 0, ` ${label} `, tones[4])

  return c
}

// ── activity sparkline ──────────────────────────────────────────────────

const SPARK_LEFT = [0x00, 0x40, 0x44, 0x46, 0x47] as const
const SPARK_RIGHT = [0x00, 0x80, 0xa0, 0xb0, 0xb8] as const

/**
 * One row of braille, two samples (0..4) a cell, newest at the right;
 * an empty stretch keeps a dim baseline so the track stays visible.
 */
export function sparkFrame(samples: readonly number[], columns: number, phase: SwarmPhase, into?: Canvas): Canvas {
  const tones = ramp(phase)
  const c = blankCanvas(columns, 1, into)
  const want = columns * 2
  const offset = samples.length - want
  const at = (i: number) => {
    const v = samples[offset + i]

    return v === undefined ? 0 : Math.max(0, Math.min(4, Math.round(v)))
  }
  for (let x = 0; x < columns; x++) {
    const l = at(x * 2)
    const r = at(x * 2 + 1)
    const peak = Math.max(l, r)
    if (peak === 0) {
      c.ch[x] = 0x28c0
      c.fg[x] = tones[0]
    } else {
      c.ch[x] = 0x2800 + SPARK_LEFT[l]! + SPARK_RIGHT[r]!
      c.fg[x] = rampAt(tones, 0.25 + peak / 5)
    }
  }

  return c
}

export const sparkText = (samples: readonly number[], columns: number): string =>
  rowText(sparkFrame(samples, columns, 'thinking'), 0)
