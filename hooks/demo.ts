// `/swarm demo`: a scripted swarm shipping a multi-currency checkout, played through
// the same reporting paths as real agents, so every phase, cost and timeline shows.

import type { SwarmAgent, SwarmPhase } from '../types'

type Beat =
  | { think: string; ms: number }
  | { say: string; ms: number }
  | { tool: string; arg: string; ms: number; out: string; isError?: boolean }
  /** An Agent tool call that plays the script named `spawn` as its child and waits for it. */
  | { spawn: string }

type Script = {
  /** When it spawns, from the start of the demo; undefined for a child, which its parent spawns. */
  at?: number
  name: string
  type: string
  description: string
  prompt: string
  model: string
  effort: string
  beats: Beat[]
  answer: string
  answerMs: number
}

export type DemoUsage = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** What the demo reports through: the mod's own handlers for real agents. */
export type DemoReport = {
  spawn: (id: string, card: Pick<SwarmAgent, 'description' | 'prompt' | 'type' | 'name' | 'model' | 'parentId' | 'isBackground'>) => Promise<void>
  step: (id: string, effort: string, model: string) => Promise<void>
  stream: (id: string, chunk: { kind: 'text' | 'thinking'; index: number; text: string }, phase: SwarmPhase) => Promise<SwarmPhase>
  respond: (id: string, usage: DemoUsage, model: string) => Promise<void>
  toolStart: (id: string, toolUseId: string, tool: string, arg: string) => Promise<number>
  toolEnd: (id: string, toolUseId: string, tool: string, startedAt: number, isError: boolean, summary: string) => Promise<void>
  complete: (id: string, reason: string, answer: string) => Promise<void>
}

/** Stretches every beat; 1 plays the script as written. */
const PACE = 1.6
const CHUNK_MS = 100

const T = (ms: number, think: string): Beat => ({ think, ms })
const S = (ms: number, say: string): Beat => ({ say, ms })
const X = (tool: string, arg: string, ms: number, out: string, isError = false): Beat => ({ tool, arg, ms, out, isError })

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const FABLE = 'claude-fable-5-1'

export const DEMO: readonly Script[] = [
  {
    at: 0,
    name: 'mapper',
    type: 'Explore',
    description: 'map the checkout flow',
    prompt: 'Map how a cart total is computed, end to end, and list every place money gets rounded.',
    model: SONNET,
    effort: 'medium',
    beats: [
      T(3000, 'The bug reports say totals drift by a cent. Start by finding where checkout lives and how a total is built.'),
      X('Glob', 'src/checkout/**/*.ts', 900, '23 files'),
      T(2600, 'cart.ts, pricing.ts, tax.ts and invoice.ts look like the pipeline. Find who calls calculateTotal to confirm the order.'),
      X('Grep', 'calculateTotal', 1200, '9 matches in 5 files'),
      T(2200, 'The route handler calls cart → pricing → tax → invoice in sequence. Read the cart first.'),
      X('Read', 'src/checkout/cart.ts', 700, '174 lines'),
      T(3200, 'Line items are floats, and each subtotal goes through toFixed(2) and back through Number(). That is one rounding already. Pricing next.'),
      X('Read', 'src/checkout/pricing.ts', 700, '212 lines'),
      T(2800, 'Discounts apply a percentage to the already-rounded subtotal, then round again. Two hops so far. Check tax.'),
      X('Read', 'src/checkout/tax.ts', 700, '148 lines'),
      T(2400, 'Tax rounds per line and again on the sum. Count every rounding site to size the fix.'),
      X('Grep', 'toFixed\\(2\\)|Math\\.round', 1300, '14 matches in 6 files'),
      T(2000, 'Fourteen sites in six files. Enough to report.'),
    ],
    answer:
      'Checkout runs cart → pricing → tax → invoice. Amounts are floats rounded at 14 call sites in 6 files, so a total can drift a cent per hop. pricing.ts and tax.ts are the hot spots.',
    answerMs: 2400,
  },
  {
    at: 600,
    name: 'architect',
    type: 'Plan',
    description: 'design the multi-currency money model',
    prompt: 'Design how amounts, currencies and FX rates are stored so checkout works in any ISO 4217 currency. Write the plan to docs/.',
    model: OPUS,
    effort: 'max',
    beats: [
      T(5000, 'Floats are the root problem. Two options: integer minor units per currency, or a decimal library end to end. Minor units keep the database and the Stripe payloads simple, so lean that way, but check what the money helpers already do.'),
      X('Read', 'src/lib/money.ts', 800, '64 lines'),
      T(4200, 'money.ts multiplies by 100 everywhere. That breaks for JPY, which has no minor unit, and KWD, which has three. The exponent has to come from ISO 4217, per currency.'),
      X('WebFetch', 'iso.org/iso-4217-currency-codes', 2400, '180 currencies with minor units'),
      T(3600, 'Now the schema: what has to migrate, and how big are the tables?'),
      X('Read', 'prisma/schema.prisma', 900, '318 lines'),
      T(4400, 'Order, LineItem and Refund keep amount as Float with no currency. Plan: BigInt minor units plus a currency column, written to a shadow column first and backfilled, so the switch is reversible.'),
      X('Bash', 'psql $STAGING_URL -c "select count(*) from orders"', 1600, '4,812,330'),
      T(3800, 'Nearly five million orders: the backfill runs in batches, off-peak. FX rates need a home too: snapshot the rate on each order so a refund uses the rate the customer paid.'),
      X('Read', 'src/checkout/refunds.ts', 800, '121 lines'),
      T(4000, 'Refunds recompute from today’s rate, which is wrong for any order older than a day. That goes in the plan as step 2, before multi-currency ships.'),
      S(1500, 'Writing the plan with the migration order.'),
      X('Write', 'docs/multi-currency-plan.md', 1200, '96 lines'),
      T(2600, 'The plan is written. Summarize the decisions.'),
    ],
    answer:
      'Plan: store every amount as BigInt minor units with an ISO 4217 currency column; read each exponent from a table (JPY 0, USD 2, KWD 3); backfill 4.8M orders in batches through a shadow column; snapshot the FX rate on the order so refunds use it. Details in docs/multi-currency-plan.md.',
    answerMs: 3200,
  },
  {
    at: 1200,
    name: 'tester',
    type: 'general-purpose',
    description: 'write failing tests for rounding drift',
    prompt: 'Write tests that reproduce the one-cent rounding drift in USD, JPY and KWD, then get them passing.',
    model: OPUS,
    effort: 'xhigh',
    beats: [
      T(3400, 'Pin the drift with tests before anything changes: three items at 0.10 each, 8.875 percent tax, in USD, JPY and KWD.'),
      X('Read', 'src/checkout/tax.ts', 700, '148 lines'),
      T(2600, 'Tax takes a rate per line. Build the fixtures around one cart and assert on the invoice total.'),
      X('Write', 'tests/rounding.test.ts', 1100, '84 lines'),
      T(1600, 'Run them; expect failures.'),
      X('Bash', 'bun test tests/rounding.test.ts', 2600, '3 fail · 5 pass'),
      T(3200, 'Three fail, all in invoice.ts, where line totals are rounded and then summed. That fix is self-contained: hand it to a subagent, then cover refunds.'),
      { spawn: 'fixer' },
      T(2800, 'The fixer has all 8 passing. Refunds next: a partial refund of a JPY order must never produce fractional yen.'),
      X('Write', 'tests/refund-rounding.test.ts', 1000, '52 lines'),
      X('Bash', 'bun test', 3000, '61 pass'),
      T(1800, 'The whole suite is green.'),
    ],
    answer:
      'Added 8 rounding tests (USD, JPY, KWD) and 4 refund tests. The 3 failures were invoice.ts summing pre-rounded line totals; the fixer subagent moved rounding to the invoice total and the whole suite passes (61 tests).',
    answerMs: 2200,
  },
  {
    at: 1800,
    name: 'payments',
    type: 'general-purpose',
    description: 'audit Stripe idempotency keys',
    prompt: 'Make sure a retried payment can never double-charge, including after the customer switches currency.',
    model: SONNET,
    effort: 'high',
    beats: [
      T(3000, 'A retry after a currency switch must never double-charge. First: what exactly does Stripe replay for a repeated idempotency key?'),
      X('WebSearch', 'stripe idempotency key retry different amount', 1800, '10 results'),
      T(2000, 'The API reference has the precise rules.'),
      X('WebFetch', 'docs.stripe.com/api/idempotent_requests', 1900, 'keys kept 24h, replayed verbatim'),
      T(3000, 'Stripe replays the first response for 24 hours, whatever the new body says, so the key must change when the amount or currency does. Find how keys are built.'),
      X('Grep', 'idempotencyKey', 900, '4 matches in 2 files'),
      X('Read', 'src/payments/stripe.ts', 800, '276 lines'),
      T(3400, 'The key is the cart id alone: a customer who switches currency and retries gets the old charge replayed. Prove it in the sandbox.'),
      X('Bash', 'bun run scripts/replay-check.ts', 2200, 'error: STRIPE_API_KEY is not set', true),
      T(1800, 'The sandbox key lives in .env.test.'),
      X('Bash', 'dotenv -e .env.test -- bun run scripts/replay-check.ts', 2600, 'replayed 12.99 USD (sent 1950 JPY)'),
      T(2600, 'Reproduced. Build the key from the cart id, the currency and the amount in minor units.'),
      X('Edit', 'src/payments/stripe.ts', 800, '+6 −2'),
      X('Bash', 'dotenv -e .env.test -- bun run scripts/replay-check.ts', 2400, 'new charge: 1950 JPY'),
      T(1400, 'Fixed and verified.'),
    ],
    answer:
      'Found a replay bug: idempotency keys were built from the cart id alone, so a retry after a currency switch replayed the old charge (reproduced in the sandbox). Keys now include the currency and the amount in minor units (src/payments/stripe.ts).',
    answerMs: 2200,
  },
  {
    at: 2400,
    name: 'reviewer',
    type: 'general-purpose',
    description: 'review PR #482 for race conditions',
    prompt: 'Review PR #482 (async FX rate refresh) for race conditions and post a review.',
    model: FABLE,
    effort: 'high',
    beats: [
      T(3200, 'PR 482 adds an async exchange-rate refresh. Pull the diff and look for unguarded writes to shared state.'),
      X('Bash', 'gh pr diff 482', 1600, '+418 −97 · 12 files'),
      T(3000, 'Most of the diff is the new FX client. The cache in src/fx/rates.ts is the shared state; read it whole.'),
      X('Read', 'src/fx/rates.ts', 700, '133 lines'),
      T(4200, 'refreshRates() awaits the provider, then writes rateCache. Nothing orders two refreshes in flight: if the slower one started first, it lands last and overwrites the fresher rate.'),
      X('LSP', 'references refreshRates', 1000, '7 references'),
      T(2600, 'Two callers matter: the scheduler and the admin "refresh now" button. Can they overlap?'),
      X('Read', 'src/fx/scheduler.ts', 700, '88 lines'),
      T(3400, 'Yes: the scheduler fires every 60 s regardless of a manual refresh. A version stamp per write fixes it without a lock. Is there a test?'),
      X('Grep', 'refreshRates tests/', 900, '2 matches, none concurrent'),
      T(2400, 'Nothing covers concurrency. Suggest a test in the review.'),
      S(1800, 'Posting the review with the race, a fix and a test sketch.'),
      X('Bash', 'gh pr review 482 --comment -F review.md', 1500, 'review posted'),
      T(1200, 'Done.'),
    ],
    answer:
      'PR #482 has a race: two refreshRates() calls can interleave and an older FX response overwrite a newer one (src/fx/rates.ts:58). Suggested a monotonic version stamp per cache write plus a concurrency test; review posted.',
    answerMs: 2400,
  },
  {
    name: 'fixer',
    type: 'general-purpose',
    description: 'fix rounding in invoice.ts',
    prompt: 'Make the 3 failing tests in tests/rounding.test.ts pass by fixing invoice.ts.',
    model: SONNET,
    effort: 'high',
    beats: [
      T(2800, 'invoice.ts rounds each line with toFixed(2), then sums the strings back into numbers. Read it to be sure.'),
      X('Read', 'src/checkout/invoice.ts', 700, '190 lines'),
      T(3000, 'Confirmed. Sum in minor units first and round once, at the total.'),
      X('Edit', 'src/checkout/invoice.ts', 900, '+12 −9'),
      T(1400, 'Run the rounding tests.'),
      X('Bash', 'bun test tests/rounding.test.ts', 2400, '1 fail · 7 pass'),
      T(3200, 'KWD is still off by a factor of ten: the exponent is hardcoded as 2. Read it from the currency table instead.'),
      X('Edit', 'src/checkout/invoice.ts', 800, '+4 −2'),
      X('Bash', 'bun test tests/rounding.test.ts', 2200, '8 pass'),
      T(1200, 'All green.'),
    ],
    answer:
      'Fixed invoice.ts: line totals are summed in minor units and rounded once, with the exponent from the currency table (KWD was hardcoded to 2). All 8 rounding tests pass.',
    answerMs: 1800,
  },
]

/** A response's token counts: the context grows a few thousand tokens a step. */
const usageOf = (model: string, step: number, outChars: number): DemoUsage => ({
  model,
  input_tokens: 300 + 40 * step,
  output_tokens: Math.round(outChars * 1.6) + 120,
  cache_read_input_tokens: 9_000 + 5_200 * step,
  cache_creation_input_tokens: 2_400 + 300 * step,
})

/** Plays the whole demo; `sleep` waits on the mod's own timer, `nonce` keeps ids unique per run. */
export async function playDemo(report: DemoReport, sleep: (ms: number) => Promise<void>, nonce: string): Promise<void> {
  const wait = (ms: number) => sleep(ms * PACE)
  let uses = 0

  const play = async (s: Script, parentId?: string): Promise<void> => {
    const id = `demo-${nonce}-${s.name}`
    await report.spawn(id, {
      description: s.description,
      prompt: s.prompt,
      type: s.type,
      name: s.name,
      model: s.model,
      parentId,
      isBackground: false,
    })
    await wait(700)

    let step = 0
    let block = 0
    let isStepOpen = false
    let phase: SwarmPhase = 'thinking'
    let outChars = 0
    const open = async () => {
      if (isStepOpen) return
      isStepOpen = true
      step += 1
      outChars = 0
      phase = 'thinking'
      await report.step(id, s.effort, s.model)
    }
    const close = async () => {
      if (!isStepOpen) return
      isStepOpen = false
      await report.respond(id, usageOf(s.model, step, outChars), s.model)
    }
    const stream = async (kind: 'text' | 'thinking', text: string, ms: number) => {
      await open()
      block += 1
      const words = text.split(' ')
      const chunks = Math.min(words.length, Math.max(1, Math.round((ms * PACE) / CHUNK_MS)))
      const per = Math.ceil(words.length / chunks)
      const gap = (ms * PACE) / Math.ceil(words.length / per)
      for (let i = 0; i < words.length; i += per) {
        await sleep(gap)
        const piece = words.slice(i, i + per).join(' ') + (i + per < words.length ? ' ' : '')
        outChars += piece.length
        phase = await report.stream(id, { kind, index: block, text: piece }, phase)
      }
    }
    const tool = async (name: string, arg: string, run: () => Promise<{ isError: boolean; out: string }>) => {
      await open()
      await close()
      uses += 1
      const useId = `demo-${nonce}-tu${uses}`
      const startedAt = await report.toolStart(id, useId, name, arg)
      const { isError, out } = await run()
      await report.toolEnd(id, useId, name, startedAt, isError, out)
    }

    for (const beat of s.beats) {
      if ('think' in beat) await stream('thinking', beat.think, beat.ms)
      else if ('say' in beat) await stream('text', beat.say, beat.ms)
      else if ('tool' in beat) {
        await tool(beat.tool, beat.arg, async () => {
          await wait(beat.ms)

          return { isError: beat.isError === true, out: beat.out }
        })
      } else {
        const child = DEMO.find(c => c.name === beat.spawn)!
        await tool('Agent', child.description, async () => {
          await play(child, id)

          return { isError: false, out: 'done' }
        })
      }
    }
    await stream('text', s.answer, s.answerMs)
    await close()
    await report.complete(id, 'answer', s.answer)
  }

  await Promise.all(
    DEMO.map(async s => {
      if (s.at === undefined) return
      await wait(s.at)

      return play(s)
    }),
  )
}
