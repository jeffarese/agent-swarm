// Cheap always-on counters for agent-swarm's own cost: `/swarm perf` reports them.

type Timing = { n: number; total: number; max: number }

const counts = new Map<string, number>()
const timings = new Map<string, Timing>()
let since = performance.now()

export function count(name: string, by = 1): void {
  counts.set(name, (counts.get(name) ?? 0) + by)
}

export function record(name: string, ms: number): void {
  const t = timings.get(name)
  if (t === undefined) {
    timings.set(name, { n: 1, total: ms, max: ms })
  } else {
    t.n += 1
    t.total += ms
    if (ms > t.max) t.max = ms
  }
}

export function resetPerf(): void {
  counts.clear()
  timings.clear()
  since = performance.now()
}

export type PerfSnapshot = {
  seconds: number
  counts: Record<string, number>
  timings: Record<string, Timing>
}

export function perfSnapshot(): PerfSnapshot {
  return {
    seconds: (performance.now() - since) / 1000,
    counts: Object.fromEntries(counts),
    timings: Object.fromEntries([...timings].map(([k, t]) => [k, { ...t }])),
  }
}

export function perfReport(): string {
  const s = perfSnapshot()
  const secs = Math.max(0.001, s.seconds)
  const lines = [`agent-swarm perf over ${s.seconds.toFixed(1)}s`]
  for (const [name, t] of Object.entries(s.timings).sort()) {
    lines.push(
      `  ${name.padEnd(16)} ${String(t.n).padStart(6)}× ${(t.n / secs).toFixed(1).padStart(6)}/s  avg ${(t.total / t.n).toFixed(3)}ms  max ${t.max.toFixed(2)}ms  total ${t.total.toFixed(1)}ms`,
    )
  }
  for (const [name, n] of Object.entries(s.counts).sort()) {
    lines.push(`  ${name.padEnd(16)} ${String(n).padStart(6)}  ${(n / secs).toFixed(1).padStart(6)}/s`)
  }

  return lines.join('\n')
}
