import type { ModelUsage, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

type World = {
  toasts: string[]
  logs: string[]
  /** The session's cost ledger, in US dollars. */
  cost: number
  compacts: string[]
  opened: string[]
  forks: number
  /** What the next forks answer, in place of a warm `ok`. */
  forkReply?: unknown
  /** Whether a fork shows in the session's cost ledger. */
  isBilled: boolean
  tokens: number
  forkRead: number
  /** System notifications raised, as `title: text`. */
  notices: string[]
  /** Why the notification channel does not send, if it does not. */
  notifyReason?: 'disabled' | 'no-channel' | 'no-surface' | 'refused'
  /** Commands run on the host, each as its executable and the title it was given. */
  runs: string[]
  /** Executables the host has; the others fail to start. */
  executables: string[]
  /** The links the system notifications open on a click. */
  links: string[]
  /** The desktop app's session id, when the session runs there. */
  hostSession?: string
}

const MIN = 60_000

const usage = (read: number, created: number): ModelUsage => ({
  input_tokens: 50,
  output_tokens: 200,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: created,
})

/** The engine beneath the mod: a mocked clock and store, and a record of what the mod asked for. */
function world(on: On, tokens = 100_000) {
  const w: World = { toasts: [], logs: [], cost: 0, compacts: [], opened: [], forks: 0, isBilled: true, tokens, forkRead: 95_000, notices: [], runs: [], executables: ['powershell.exe'], links: [] }
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('env.get', (_$, e) => ({ value: e.name === 'CLAUDE_CODE_HOST_SESSION_ID' ? w.hostSession : undefined }))
  on('process.run', (_$, e) => {
    w.runs.push(`${e.argv[0]}: ${e.init?.env?.CACHE_GUARD_TITLE}`)
    w.links.push(e.init?.env?.CACHE_GUARD_LINK ?? '')
    if (!w.executables.includes(e.argv[0] ?? '')) throw new Error(`${e.argv[0]}: not found`)
    return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
  })
  on('ui.notify', (_$, e) => {
    if (w.notifyReason) return { value: { isSent: false as const, reason: w.notifyReason } }
    w.notices.push(`${e.title}: ${e.text}`)
    return { value: { isSent: true as const, channel: 'kitty' as const } }
  })
  on('ui.log', (_$, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: w.tokens, window: 200_000 }, rateLimits: [], cost: { usd: w.cost } },
  }))
  on('session.compact', (_$, e) => {
    w.compacts.push(e.instructions ?? '')
    const summary = { role: 'user' as const, text: 'summary', toolUses: [] }
    return { messages: [summary], tokensBefore: w.tokens, tokensAfter: 15_000, usage: usage(w.tokens, 0) }
  })
  on('model.fork', () => {
    w.forks += 1
    if (w.isBilled) w.cost += 0.0232
    return { value: (w.forkReply ?? { isAnswered: true, text: 'ok', usage: usage(w.forkRead, 0) }) as never }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  return { w, clock }
}

/** `/cache-guard`'s report, which also opens the settings panel. */
async function report($: Engine): Promise<string> {
  const out = await $.command.run({ command: 'cache-guard', args: '' } as never)
  return out.text ?? ''
}

/** What the band says now, as the report's `now:` line has it. */
async function band($: Engine): Promise<string> {
  const row = (await report($)).split('\n').find(one => one.startsWith('now: '))
  return row?.slice('now: '.length) ?? ''
}

const turnEnd = (turnId: string, read = 0, created = 0, model = 'claude-opus-5-5') => ({
  answer: 'done',
  durationMs: 1000,
  isAborted: false,
  turnId,
  reason: 'answer' as const,
  usage: { ...usage(read, created), model },
})

const ABOVE_PROMPT = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as never
const PANE = { title: 'Cache guard' } as never

describe('cache-guard', () => {
  test('watch counts down to expiry and never compacts', { options: { mode: 'watch', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    expect(await band($)).toBe('5:00 left · 5m cache · 0:00 since reply · 100k context')

    await clock.advance(4 * MIN)
    expect(await band($)).toBe('1:00 left · 5m cache · 4:00 since reply · 100k context')

    await clock.advance(MIN + 1000)
    expect(await band($)).toBe('Cache expired · resume ≈ $0.50 at API price · 5:01 since reply · 100k context')
    expect(w.compacts).toEqual([])
    expect(w.forks).toBe(0)
  })

  test('compact runs 30 s before expiry with the profile instructions', { options: { mode: 'compact', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    expect(await band($)).toContain('compact in 4:30')

    await clock.advance(4 * MIN + 29_000)
    expect(w.compacts).toEqual([])

    await clock.advance(1000)
    expect(w.compacts).toHaveLength(1)
    expect(w.compacts[0]).toContain('decisions + why')
    expect(await band($)).toContain('Cache cold · compacted 100k → 15k')

    await clock.advance(10 * MIN)
    expect(w.compacts).toHaveLength(1)
    expect(await band($)).toContain('14:30 since reply')
  })

  test('a profile text from the options reaches the compaction', { options: { mode: 'compact', ttl: '5m', instructionsCode: 'Only the plan.' } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(4 * MIN + 30_000)
    expect(w.compacts).toEqual(['Only the plan.'])
  })

  test('the debug profile chosen in the options', { options: { mode: 'compact', ttl: '5m', profile: 'debug' } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(4 * MIN + 30_000)
    expect(w.compacts[0]).toContain('Debug focus')
  })

  test('a small context is not compacted', { options: { mode: 'compact', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on, 20_000)
    await $.turn.complete(turnEnd('t1'))
    expect(await band($)).toContain('below 50k, no action')
    await clock.advance(6 * MIN)
    expect(w.compacts).toEqual([])
  })

  test('a new turn cancels the countdown', { options: { mode: 'compact', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(3 * MIN)
    await $.turn.start({ text: 'go on', turnId: 't2' })
    expect(await band($)).toBe('Claude is working · 100k context · timer resumes after the reply')

    await clock.advance(3 * MIN)
    expect(w.compacts).toEqual([])
  })

  test('a subagent turn starts no countdown', { options: { mode: 'compact', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete({ ...turnEnd('t1'), agentId: 'a1' })
    await clock.advance(6 * MIN)
    expect(await band($)).toBe('Cache guard · starts after the next reply')
    expect(w.compacts).toEqual([])
  })

  test('ping keeps the cache warm up to the limit, then lets it lapse', { options: { mode: 'ping', ttl: '5m', maxPings: 2 } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    // Two pings to come: 4:30 to the first, 4:30 to the second, then the 5 minutes it buys.
    expect(await band($)).toBe('14 min left · 5m cache · ping 1/2 in 4:30 · 0:00 since reply · 100k context')

    await clock.advance(4 * MIN + 30_000)
    expect(w.forks).toBe(1)
    expect(await band($)).toBe('9:30 left · 5m cache · ping 2/2 in 4:30 · ping 1/2 kept 95k warm · 4:30 since reply · 100k context')

    await clock.advance(4 * MIN + 30_000)
    expect(await band($)).toContain('5:00 left · 5m cache · ping 2/2 kept 95k warm')

    expect(w.forks).toBe(2)

    await clock.advance(10 * MIN)
    expect(w.forks).toBe(2)
    expect(w.compacts).toEqual([])
    expect(await band($)).toContain('Cache expired')
  })

  test('unlimited pings keep the cache warm for as long as the pause lasts', { options: { mode: 'ping+compact', ttl: '5m', maxPings: 99 } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    expect(await band($)).toBe('Kept warm · 5m cache · ping 1/∞ in 4:30 · 0:00 since reply · 100k context')
    for (let i = 0; i < 15; i++) await clock.advance(4 * MIN + 30_000)
    expect(w.forks).toBe(15)
    expect(w.compacts).toEqual([])
    expect(w.logs.at(-1)).toBe('✓ Ping 15/∞ · cache kept warm · read 95k of 100k · $0.02 billed')
    expect(await report($)).toContain('pings before compact: ∞')
  })

  test('five pings count the band down to the end of the last one', { options: { mode: 'ping', ttl: '5m', maxPings: 5 } }, async ($, on) => {
    const { clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    // 5 × 4:30 + 5:00 = 27:30.
    expect(await band($)).toContain('28 min left · 5m cache · ping 1/5 in 4:30')
    await clock.advance(MIN)
    expect(await band($)).toContain('27 min left · 5m cache · ping 1/5 in 3:30')
  })

  test('the panel steps the ping limit up to ∞ and back', { options: { mode: 'ping', ttl: '5m', maxPings: 10 } }, async ($, on) => {
    world(on)
    await $.turn.complete(turnEnd('t1'))
    const at = { plugin: 'cache-guard', surface: 'desktop' as const, requestId: 'cache-guard-settings' }
    const pane = await $.ui.mount({ plugin: 'cache-guard', surface: 'desktop', component: 'Pane', requestId: 'cache-guard-settings', props: PANE })
    await $.ui.press({ ...at, key: 'inc-maxPings' })
    expect(await report($)).toContain('pings before compact: ∞')
    // 100k read at $0.20/M about 13 times an hour, against one $0.50 re-cache.
    expect(JSON.stringify(await pane.drawn())).toContain('∞ while idle: ≈ $0.27 an hour at 100k; past 1.8 h that is more than one re-cache ($0.50).')
    await $.ui.press({ ...at, key: 'inc-maxPings' })
    expect(await report($)).toContain('pings before compact: ∞')
    await $.ui.press({ ...at, key: 'dec-maxPings' })
    expect(await report($)).toContain('pings before compact: 10')
  })

  test('ping+compact compacts after the last ping', { options: { mode: 'ping+compact', ttl: '5m', maxPings: 1 } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(4 * MIN + 30_000)
    expect(w.forks).toBe(1)
    expect(await band($)).toContain('compact in 4:30')
    await clock.advance(4 * MIN + 30_000)
    expect(w.compacts).toHaveLength(1)
  })

  test('a ping that misses the cache falls through to compact', { options: { mode: 'ping+compact', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    w.forkRead = 3000
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(4 * MIN + 30_000)
    expect(w.forks).toBe(1)
    expect(w.compacts).toHaveLength(1)
    expect(w.toasts.some(t => t.includes('missed the cache'))).toBe(true)
  })

  test('an unknown TTL asks to be picked on the band', { options: { mode: 'compact', ttl: 'auto' } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    expect(await band($)).toContain("Pick the cache TTL · cache-guard can't time anything until it knows · an API key has 5 min")
    const mounted = await $.ui.mount({ plugin: 'cache-guard', surface: 'desktop', component: 'AbovePrompt', props: ABOVE_PROMPT })
    expect(JSON.stringify(await mounted.drawn())).toContain('TTL 1 hour')
    await clock.advance(10 * MIN)
    expect(w.compacts).toEqual([])

    await $.turn.start({ text: 'again', turnId: 't2' })
    await $.turn.complete(turnEnd('t2'))
    await $.ui.press({ plugin: 'cache-guard', key: 'ttl-5m', surface: 'desktop' })
    expect(await band($)).toContain('compact in 4:30')
    expect(JSON.stringify(await mounted.drawn())).not.toContain('TTL 1 hour')
    await clock.advance(4 * MIN + 30_000)
    expect(w.compacts).toHaveLength(1)
  })

  test('auto learns 5m from a pause after which the context was re-written', { options: { mode: 'compact', ttl: 'auto' } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(10 * MIN)
    await $.turn.start({ text: 'back', turnId: 't2' })
    await $.turn.complete(turnEnd('t2', 10_000, 98_000))
    expect(w.toasts).toContain("cache-guard: this session's cache TTL is 5m")

    await clock.advance(4 * MIN + 30_000)
    expect(w.compacts).toHaveLength(1)
  })

  test('auto learns 1h from a pause after which the context came from the cache', { options: { mode: 'compact', ttl: 'auto' } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(10 * MIN)
    await $.turn.start({ text: 'back', turnId: 't2' })
    await $.turn.complete(turnEnd('t2', 99_000, 2000))
    expect(w.toasts).toContain("cache-guard: this session's cache TTL is 1h")

    await clock.advance(30 * MIN)
    expect(w.compacts).toEqual([])
    await clock.advance(29 * MIN + 30_000)
    expect(w.compacts).toHaveLength(1)
  })

  test('auto learns the TTL from PreCompact', { options: { mode: 'compact', ttl: 'auto' } }, async ($, on) => {
    const { w } = world(on)
    on('classic.PreCompact', () => ({}))
    await $.classic.PreCompact({
      trigger: 'manual',
      custom_instructions: null,
      prompt_cache_warm: true,
      cache_ttl: '1h',
      context_tokens: 100_000,
      estimated_cache_write_usd: 0,
    } as never)
    expect(w.toasts).toContain("cache-guard: this session's cache TTL is 1h")
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the band on ${surface} switches the mode and opens the settings`, { options: { mode: 'watch', ttl: '5m' } }, async ($, on) => {
      const { w, clock } = world(on)
      await $.turn.complete(turnEnd('t1'))
      const mounted = await $.ui.mount({ plugin: 'cache-guard', surface, component: 'AbovePrompt', props: ABOVE_PROMPT })
      const drawn = JSON.stringify(await mounted.drawn())
      expect(drawn).toContain('5:00 left')
      expect(drawn).toContain(surface === 'desktop' ? '"Svg"' : '●')

      await $.ui.press({ plugin: 'cache-guard', key: 'mode-compact', surface })
      expect(await band($)).toContain('compact in 4:30')
      await clock.advance(4 * MIN + 30_000)
      expect(w.compacts).toHaveLength(1)

      await $.ui.press({ plugin: 'cache-guard', key: 'settings', surface })
      expect(w.opened).toContain('cache-guard-settings')
    })

    test(`the settings panel on ${surface} sets pings before compact`, { options: { mode: 'ping+compact', ttl: '5m', maxPings: 2 } }, async ($, on) => {
      const { w, clock } = world(on)
      await $.turn.complete(turnEnd('t1'))
      await $.ui.mount({ plugin: 'cache-guard', surface, component: 'Pane', requestId: 'cache-guard-settings', props: PANE })
      await $.ui.press({ plugin: 'cache-guard', key: 'dec-maxPings', surface, requestId: 'cache-guard-settings' })
      await $.ui.press({ plugin: 'cache-guard', key: 'dec-maxPings', surface, requestId: 'cache-guard-settings' })
      expect(await report($)).toContain('pings before compact: 0')
      expect(await band($)).toContain('compact in 4:30')

      await clock.advance(4 * MIN + 30_000)
      expect(w.forks).toBe(0)
      expect(w.compacts).toHaveLength(1)
    })
  }

  test('the settings panel switches TTL and profile and resets them', { options: { mode: 'compact', ttl: 'auto' } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    const at = { surface: 'desktop' as const, requestId: 'cache-guard-settings' }
    await $.ui.mount({ plugin: 'cache-guard', surface: 'desktop', component: 'Pane', requestId: 'cache-guard-settings', props: PANE })
    await $.ui.press({ plugin: 'cache-guard', key: 'set-ttl-1h', ...at })
    await $.ui.press({ plugin: 'cache-guard', key: 'set-profile-plan', ...at })
    await $.ui.press({ plugin: 'cache-guard', key: 'inc-margin', ...at })
    expect(await report($)).toContain('act 40s before expiry')
    expect(await band($)).toContain('60 min left · 1h cache · compact in 60 min')

    // An hour of one-second ticks outlasts the test's budget: check the timing on 5 minutes.
    await $.ui.press({ plugin: 'cache-guard', key: 'set-ttl-5m', ...at })
    await clock.advance(5 * MIN - 41_000)
    expect(w.compacts).toEqual([])
    await clock.advance(1000)
    expect(w.compacts).toHaveLength(1)
    expect(w.compacts[0]).toContain('Design focus')

    await $.ui.press({ plugin: 'cache-guard', key: 'reset', ...at })
    expect(await report($)).toContain('TTL: auto')
    expect(await report($)).toContain('compact profile: code')
  })

  test('the resume cost follows the model and the TTL', { options: { mode: 'watch', ttl: '1h' } }, async ($, on) => {
    const { clock } = world(on)
    await $.turn.complete(turnEnd('t1', 0, 0, 'claude-sonnet-5-5'))
    await clock.advance(61 * MIN)
    // Sonnet 5.5 writes an hour's cache at $4 per million tokens.
    expect(await band($)).toContain('resume ≈ $0.40 at API price')
    expect(await report($)).toContain('cost at Sonnet 5.5 API price: next reply ≈ $0.02 while warm, ≈ $0.40 after expiry')
  })

  test('an unknown model is priced at the default tier', { options: { mode: 'watch', ttl: '5m' } }, async ($, on) => {
    const { clock } = world(on)
    await $.turn.complete(turnEnd('t1', 0, 0, 'some-proxy-model'))
    await clock.advance(6 * MIN)
    expect(await report($)).toContain('cost at an assumed API price')
  })

  test('the band switches the compact profile', { options: { mode: 'compact', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    await $.ui.mount({ plugin: 'cache-guard', surface: 'desktop', component: 'AbovePrompt', props: ABOVE_PROMPT })
    await $.ui.press({ plugin: 'cache-guard', key: 'profile', surface: 'desktop' })
    expect(await report($)).toContain('compact profile: debug')
    await $.ui.press({ plugin: 'cache-guard', key: 'profile', surface: 'desktop' })
    await clock.advance(4 * MIN + 30_000)
    expect(w.compacts[0]).toContain('Design focus')
  })

  test('off for the session stops everything until turned back on', { options: { mode: 'compact', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    // What the engine draws in the band's place once the mod steps aside.
    on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
    await $.turn.complete(turnEnd('t1'))
    const band1 = await $.ui.mount({ plugin: 'cache-guard', surface: 'desktop', component: 'AbovePrompt', props: ABOVE_PROMPT })
    await $.ui.press({ plugin: 'cache-guard', key: 'off', surface: 'desktop' })
    expect(w.toasts.some(t => t.includes('off for this session'))).toBe(true)
    expect(JSON.stringify(await band1.drawn())).not.toContain('left')
    expect(await report($)).toContain('session: off (this session only)')

    await clock.advance(6 * MIN)
    await $.turn.start({ text: 'more', turnId: 't2' })
    await $.turn.complete(turnEnd('t2'))
    await clock.advance(6 * MIN)
    expect(w.compacts).toEqual([])

    // A reload keeps it off: the session's state holds the switch.
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as never)
    await $.turn.start({ text: 'again', turnId: 't3' })
    await $.turn.complete(turnEnd('t3'))
    await clock.advance(6 * MIN)
    expect(w.compacts).toEqual([])

    await $.ui.mount({ plugin: 'cache-guard', surface: 'desktop', component: 'Pane', requestId: 'cache-guard-settings', props: PANE })
    await $.ui.press({ plugin: 'cache-guard', key: 'toggle-off', surface: 'desktop', requestId: 'cache-guard-settings' })
    await $.turn.start({ text: 'last', turnId: 't4' })
    await $.turn.complete(turnEnd('t4'))
    await clock.advance(4 * MIN + 30_000)
    expect(w.compacts).toHaveLength(1)
  })

  test('a compaction counts as saved once the next reply writes the summary', { options: { mode: 'compact', ttl: '5m' } }, async ($, on) => {
    const { clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(4 * MIN + 30_000)
    expect(await report($)).toContain('this session: 1 compactions (−85k context) · 0 pings (0 missed the cache) · 0 lapses avoided')

    await clock.advance(20 * MIN)
    await $.turn.start({ text: 'back', turnId: 't2' })
    await $.turn.complete(turnEnd('t2', 0, 15_000))
    // 85k fewer tokens re-written at $5/M, less the compaction's own $0.02.
    expect(await report($)).toContain('1 lapses avoided · $0.42 spared − $0.02 spent = saved $0.40')
    expect(await band($)).not.toContain('saved')
    const mounted = await $.ui.mount({ plugin: 'cache-guard', surface: 'desktop', component: 'AbovePrompt', props: ABOVE_PROMPT })
    expect(JSON.stringify(await mounted.drawn())).toContain('saved $0.40 this session · saved $0.40 in all')
  })

  test('a ping counts as saved only when the reply finds the cache', { options: { mode: 'ping', ttl: '5m', maxPings: 1 } }, async ($, on) => {
    const { clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(4 * MIN + 30_000)
    expect(await report($)).toContain('$0 spared − $0.02 spent = net −$0.02')

    await clock.advance(MIN)
    await $.turn.start({ text: 'back', turnId: 't2' })
    await $.turn.complete(turnEnd('t2', 99_000, 1000))
    // 100k not re-written at $5/M but read at $0.20/M, less the ping.
    expect(await report($)).toContain('1 lapses avoided · $0.48 spared − $0.02 spent = saved $0.46')
  })

  test('a ping is not credited when the user comes back too late', { options: { mode: 'ping', ttl: '5m', maxPings: 1 } }, async ($, on) => {
    const { clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(30 * MIN)
    await $.turn.start({ text: 'late', turnId: 't2' })
    await $.turn.complete(turnEnd('t2', 0, 100_000))
    expect(await report($)).toContain('0 lapses avoided · $0 spared − $0.02 spent = net −$0.02')
  })

  test('a long tool keeps the cache warm with pings and credits them', { options: { mode: 'compact', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    let finish = () => {}
    const toolDone = new Promise<void>(resolve => (finish = resolve))
    on('tool.call', async () => {
      await toolDone
      return { result: 'tests passed' } as never
    })
    let read = 100_000
    on('turn.step', async function* (_$, e) {
      return {
        turnId: e.turnId,
        index: e.index,
        answer: '',
        toolUses: [],
        stopReason: 'tool_use',
        usage: { ...usage(read, 0), model: 'claude-opus-5-5' },
      } as never
    })
    const step = async (index: number) => {
      const stream = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', messageCount: 3 } as never)
      for await (const _ of stream);
      return stream.result
    }

    await $.turn.start({ text: 'run the tests', turnId: 't1' })
    await step(0)
    const call = $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test' } as never)
    await clock.advance(MIN)
    expect(await band($)).toContain('Claude is working · 100k context · tool running 1:00')

    await clock.advance(3 * MIN + 30_000)
    expect(w.forks).toBe(1)
    expect(await band($)).toContain('ping 1 kept 95k warm')
    await clock.advance(4 * MIN + 30_000)
    expect(w.forks).toBe(2)

    finish()
    await call
    await step(1)
    expect(await report($)).toContain('2 pings (0 missed the cache) · 1 lapses avoided')
    expect(w.compacts).toEqual([])

    // Back to the idle countdown after the turn.
    await $.turn.complete(turnEnd('t1', read))
    read = 0
    expect(await band($)).toContain('compact in 4:30')
  })

  test('tool pings stop when re-caching gets cheaper, and stay off in Watch', { options: { mode: 'watch', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    let finish = () => {}
    const toolDone = new Promise<void>(resolve => (finish = resolve))
    on('tool.call', async () => {
      await toolDone
      return { result: 'done' } as never
    })
    await $.turn.complete(turnEnd('t1'))
    await $.turn.start({ text: 'go', turnId: 't2' })
    const call = $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'make' } as never)
    await clock.advance(20 * MIN)
    expect(w.forks).toBe(0)
    finish()
    await call
  })

  test('the panel turns tool pings off', { options: { mode: 'compact', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    let finish = () => {}
    const toolDone = new Promise<void>(resolve => (finish = resolve))
    on('tool.call', async () => {
      await toolDone
      return { result: 'done' } as never
    })
    await $.turn.complete(turnEnd('t1'))
    await $.ui.mount({ plugin: 'cache-guard', surface: 'terminal', component: 'Pane', requestId: 'cache-guard-settings', props: PANE })
    await $.ui.press({ plugin: 'cache-guard', key: 'set-toolPings-off', surface: 'terminal', requestId: 'cache-guard-settings' })
    await $.turn.start({ text: 'go', turnId: 't2' })
    const call = $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'make' } as never)
    await clock.advance(10 * MIN)
    expect(w.forks).toBe(0)
    finish()
    await call
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the panel on ${surface} edits the compact prompt`, { options: { mode: 'compact', ttl: '5m' } }, async ($, on) => {
      const { w, clock } = world(on)
      await $.turn.complete(turnEnd('t1'))
      const at = { plugin: 'cache-guard', surface, requestId: 'cache-guard-settings' }
      const pane = await $.ui.mount({ plugin: 'cache-guard', surface, component: 'Pane', requestId: 'cache-guard-settings', props: PANE })
      await $.ui.input({ ...at, key: 'edit-code', text: '  Keep only the plan and the failing test.  ' })
      expect(await report($)).toContain('compact profile: code — Keep only the plan and the failing test.')
      expect(JSON.stringify(await pane.drawn())).toContain('Restore default')

      await clock.advance(4 * MIN + 30_000)
      expect(w.compacts).toEqual(['Keep only the plan and the failing test.'])

      await $.ui.press({ ...at, key: 'reset-instruction' })
      expect(await report($)).toContain('compact profile: code — Keep it tight')
    })
  }

  test('an edited prompt outlives a reload', { options: { mode: 'compact', ttl: '5m', profile: 'debug' } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as never)
    await $.ui.mount({ plugin: 'cache-guard', surface: 'desktop', component: 'Pane', requestId: 'cache-guard-settings', props: PANE })
    await $.ui.input({ plugin: 'cache-guard', surface: 'desktop', requestId: 'cache-guard-settings', key: 'edit-debug', text: 'Repro + hypothesis.' })
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as never)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(4 * MIN + 30_000)
    expect(w.compacts).toEqual(['Repro + hypothesis.'])
  })

  test('every ping leaves its evidence in the transcript', { options: { mode: 'ping', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(4 * MIN + 30_000)
    expect(w.logs).toEqual(['✓ Ping 1/2 · cache kept warm · read 95k of 100k · $0.02 billed'])

    w.forkRead = 2000
    await clock.advance(4 * MIN + 30_000)
    expect(w.logs[1]).toBe('✗ Ping 2/2 · missed the cache · read 2k of 100k, wrote 0k · $0.02 billed')
  })

  test('a ping the session cost does not show is flagged', { options: { mode: 'ping', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    w.isBilled = false
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(4 * MIN + 30_000)
    expect(w.logs).toEqual(['✓ Ping 1/2 · cache kept warm · read 95k of 100k · ≈ $0.02, not in the session cost'])
  })

  test('a ping with no reply says why', { options: { mode: 'ping', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    w.isBilled = false
    w.forkReply = { isAnswered: false, reason: 'nothing-to-fork' }
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(4 * MIN + 30_000)
    expect(w.logs).toEqual(['✗ Ping 1/2 · no reply (nothing-to-fork)'])
  })

  test('the transcript tells a compaction and the reply it spared', { options: { mode: 'compact', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(4 * MIN + 30_000)
    expect(w.logs).toEqual(['✓ Compacted 100k → 15k before the cache expired · ≈ $0.02'])
    await clock.advance(20 * MIN)
    await $.turn.start({ text: 'back', turnId: 't2' })
    await $.turn.complete(turnEnd('t2', 0, 15_000))
    expect(w.logs[1]).toBe('✓ Reply wrote 15k instead of 100k · spared $0.42 of re-caching')
  })

  test('the transcript tells a reply that found the cache a ping kept', { options: { mode: 'ping', ttl: '5m', maxPings: 1 } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(4 * MIN + 30_000)
    await $.turn.start({ text: 'back', turnId: 't2' })
    await $.turn.complete(turnEnd('t2', 99_000, 1000))
    expect(w.logs[1]).toBe('✓ Reply read 99k from the cache the ping kept · spared $0.48 of re-caching')
  })

  test('a reply that re-writes the cache after a ping is reported, not credited', { options: { mode: 'ping', ttl: '5m', maxPings: 1 } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(4 * MIN + 30_000)
    await clock.advance(MIN)
    await $.turn.start({ text: 'back', turnId: 't2' })
    await $.turn.complete(turnEnd('t2', 0, 100_000))
    expect(w.logs.at(-1)).toBe('✗ Reply re-wrote 100k · the ping did not keep the cache warm (read 0k)')
    expect(await report($)).toContain('1 pings (1 missed the cache) · 0 lapses avoided')
  })

  test('the countdown starts with the last request, not the end of the reply', { options: { mode: 'compact', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    on('turn.step', async function* (_$, e) {
      return { turnId: e.turnId, index: e.index, answer: 'long answer', toolUses: [], stopReason: 'end_turn', usage: null } as never
    })
    await $.turn.start({ text: 'explain', turnId: 't1' })
    const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)
    for await (const _ of stream);
    // The answer streams for two minutes: the cache entry is that old when the turn ends.
    await clock.advance(2 * MIN)
    await $.turn.complete(turnEnd('t1'))
    expect(await band($)).toContain('3:00 left')
    expect(await band($)).toContain('0:00 since reply')
    await clock.advance(2 * MIN + 30_000)
    expect(w.compacts).toHaveLength(1)
  })

  test('a reload picks the countdown up where it was', { options: { mode: 'compact', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(2 * MIN)
    // A hot reload runs session.start again in a fresh module over the session's state.
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as never)
    expect(await band($)).toContain('3:00 left')
    await clock.advance(2 * MIN + 30_000)
    expect(w.compacts).toHaveLength(1)
  })

  test('a notification comes a minute before the cache expires', { options: { mode: 'watch', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(4 * MIN - 1000)
    expect(w.notices).toEqual([])
    await clock.advance(1000)
    expect(w.notices).toEqual(['Prompt cache expires in 1 min: The next reply then re-writes 100k: ≈ $0.50 instead of $0.02.'])
    await clock.advance(5 * MIN)
    expect(w.notices).toHaveLength(1)
  })

  test('in Compact the notification comes before the compaction', { options: { mode: 'compact', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(3 * MIN + 30_000)
    expect(w.notices).toEqual([
      'Compacting in 1 min: cache-guard compacts 100k before the cache expires. Reply before then to keep the full context.',
    ])
    expect(w.compacts).toEqual([])
  })

  test('no notification while pings keep the cache, one after the last ping', { options: { mode: 'ping', ttl: '5m', maxPings: 1 } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(4 * MIN + 30_000)
    expect(w.forks).toBe(1)
    expect(w.notices).toEqual([])
    await clock.advance(4 * MIN)
    expect(w.notices).toHaveLength(1)
    expect(w.notices[0]).toContain('Prompt cache expires in 1 min:')
  })

  test('a new message cancels the notification', { options: { mode: 'watch', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(2 * MIN)
    await $.turn.start({ text: 'next', turnId: 't2' })
    await clock.advance(5 * MIN)
    expect(w.notices).toEqual([])
  })

  test('no notification below the minimum context', { options: { mode: 'watch', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on, 20_000)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(5 * MIN)
    expect(w.notices).toEqual([])
  })

  test('the panel turns the notification off and sets how early it comes', { options: { mode: 'watch', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.turn.complete(turnEnd('t1'))
    const at = { plugin: 'cache-guard', surface: 'desktop' as const, requestId: 'cache-guard-settings' }
    await $.ui.mount({ plugin: 'cache-guard', surface: 'desktop', component: 'Pane', requestId: 'cache-guard-settings', props: PANE })
    await $.ui.press({ ...at, key: 'inc-notifyLead' })
    expect(await report($)).toContain('notification: 1 min 30 s before the cache expires or is compacted')
    await clock.advance(3 * MIN + 30_000)
    expect(w.notices).toHaveLength(1)
    expect(w.notices[0]).toContain('Prompt cache expires in 1 min 30 s:')

    await $.turn.start({ text: 'next', turnId: 't2' })
    await $.turn.complete(turnEnd('t2'))
    await $.ui.press({ ...at, key: 'set-notify-off' })
    expect(await report($)).toContain('notification: off')
    await clock.advance(5 * MIN)
    expect(w.notices).toHaveLength(1)
  })

  test('with no terminal to notify through the system notifies', { options: { mode: 'watch', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    w.notifyReason = 'no-surface'
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(4 * MIN)
    expect(w.runs).toEqual(['powershell.exe: Prompt cache expires in 1 min'])
    expect(w.toasts).toEqual([])
  })

  test('the first system notifier that works is kept', { options: { mode: 'watch', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    w.notifyReason = 'no-surface'
    w.executables = ['osascript']
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(4 * MIN)
    expect(w.runs).toEqual(['powershell.exe: Prompt cache expires in 1 min', 'osascript: Prompt cache expires in 1 min'])
    await $.turn.start({ text: 'next', turnId: 't2' })
    await $.turn.complete(turnEnd('t2'))
    await clock.advance(4 * MIN)
    expect(w.runs.slice(2)).toEqual(['osascript: Prompt cache expires in 1 min'])
  })

  test('in the desktop app a click on the notification opens the session', { options: { mode: 'watch', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    w.notifyReason = 'no-surface'
    w.hostSession = 'local_a4059325-49cd-499c-83bc-dd04b1220ce5'
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as never)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(4 * MIN)
    expect(w.links).toEqual(['claude://code/continue?session=local_a4059325-49cd-499c-83bc-dd04b1220ce5&source=cache-guard'])
  })

  test('the panel sends a test notification and says how it went', { options: { mode: 'watch', ttl: '5m' } }, async ($, on) => {
    const { w } = world(on)
    w.notifyReason = 'no-surface'
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as never)
    const at = { plugin: 'cache-guard', surface: 'desktop' as const, requestId: 'cache-guard-settings' }
    await $.ui.mount({ plugin: 'cache-guard', surface: 'desktop', component: 'Pane', requestId: 'cache-guard-settings', props: PANE })
    await $.ui.press({ ...at, key: 'notify-test' })
    expect(w.runs).toEqual(['powershell.exe: cache-guard test'])
    expect(w.links).toEqual([''])
    expect(w.toasts).toEqual(['cache-guard: test notification sent'])
    w.notifyReason = 'disabled'
    await $.ui.press({ ...at, key: 'notify-test' })
    expect(w.toasts.at(-1)).toBe("cache-guard: no notification: notifications are turned off in Claude Code's settings")
  })

  test('notifications turned off in the person\'s settings stay off', { options: { mode: 'watch', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    w.notifyReason = 'disabled'
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(5 * MIN)
    expect(w.runs).toEqual([])
  })

  test('/cache-guard opens the settings and reports the stats', { options: { mode: 'compact', ttl: '5m' } }, async ($, on) => {
    const { w, clock } = world(on)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
    await $.turn.complete(turnEnd('t1'))
    await clock.advance(4 * MIN + 30_000)
    const out = await report($)
    expect(w.opened).toContain('cache-guard-settings')
    expect(out).toContain('mode: Compact')
    expect(out).toContain('compacted 100k → 15k')
    expect(out).toContain('compact profile: code')
    expect(out).toContain('total: 1 compactions (−85k context)')
  })
})
