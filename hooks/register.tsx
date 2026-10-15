import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelForkResult, ModelUsage, Register, Timer, TurnUsage } from 'claude-code'

import type { GuardMode, GuardProfile, GuardStats, GuardTtl, GuardView, Ttl } from '../types'
import {
  bandParts,
  cacheCost,
  callCost,
  durationText,
  INITIAL_VIEW,
  kTokens,
  line,
  NO_STATS,
  pingLimitText,
  pingLine,
  ringSvg,
  savingsText,
  statsLine,
  TTL_MS,
  ttlFromBill,
  UNLIMITED_PINGS,
  usdText,
} from './view'

const view = atom({ plugin: 'cache-guard', key: 'view' } as const, INITIAL_VIEW)

const SETTINGS_PANE = 'cache-guard-settings'

/** What the settings panel changes; kept in the store over the options' defaults. */
type Settings = {
  mode: GuardMode
  ttlOption: GuardTtl
  profile: GuardProfile
  maxPings: number
  marginMs: number
  minTokens: number
  /** Keep the cache warm with pings while a long tool runs in the main loop. */
  toolPings: boolean
  /** Raise a system notification shortly before the cache lapses or is compacted. */
  notify: boolean
  /** How long before that. */
  notifyMs: number
}

/** A pause long enough to tell a 5m cache from a 1h one, waiting for the next turn's usage. */
type Probe = { context: number }

/** The mod's settings and the idle period it watches. */
type Guard = Settings & {
  /** Each profile's text in force: the panel's edit, else the options' text, else the built-in one. */
  instructions: Record<GuardProfile, string>
  /** Each profile's text as the options set it, the built-in one where left empty. */
  optionInstructions: Record<GuardProfile, string>
  learnedTtl?: Ttl
  /** How `learnedTtl` was found, for the report and the panel. */
  ttlSource?: string
  /** The TTL the last requests' bills showed, and how many in a row showed it. */
  billTtl?: { ttl: Ttl; count: number }
  stats: GuardStats
  isWorking: boolean
  lastReplyAt?: number
  /** When the cache was last touched; undefined while nothing warm is guarded. */
  warmAt?: number
  context: number
  pings: number
  /** The main loop's model, from the last reply's usage. */
  model?: string
  /** Off for this session: no countdown, no action, no band. */
  isOff: boolean
  hasActed: boolean
  note: string
  probe?: Probe
  tick?: Timer
  fire?: Timer
  /** The notification before the cache lapses or is compacted. */
  notice?: Timer
  /** Which of the system's own notifiers worked last, where the terminal cannot notify. */
  notifier?: number
  /** The desktop app's link back to this session, which a click on the notification opens. */
  link?: string
  /** This session's stats; `stats` holds all sessions'. */
  session: GuardStats
  likelyTtl?: Ttl
  /** When the main loop's latest model request started: a cache entry lives from there. */
  requestAt?: number
  /** Tool calls the main loop is running now; parallel calls share one wait. */
  toolsRunning: number
  toolSince?: number
  /** When the cache was last touched during the current tool wait. */
  waitAt?: number
  waitPings: number
  /** What the current tool wait's pings cost so far. */
  waitSpent: number
  waitFire?: Timer
  /** Re-caching spared, credited once the next request shows the cache was found, not before. */
  credit?: { amount: number; isChecked: boolean; before?: number; after?: number }
}

const MODES: readonly GuardMode[] = ['watch', 'ping', 'compact', 'ping+compact']
const TTLS: readonly GuardTtl[] = ['auto', '5m', '1h']
const PROFILES: readonly GuardProfile[] = ['code', 'debug', 'plan']

const MODE_LABELS: Record<GuardMode, string> = {
  watch: 'Watch',
  ping: 'Ping',
  compact: 'Compact',
  'ping+compact': 'Ping → Compact',
}

const TTL_LABELS: Record<GuardTtl, string> = { auto: 'Auto', '5m': '5 min', '1h': '1 hour' }

const PROFILE_LABELS: Record<GuardProfile, string> = { code: 'Code', debug: 'Debug', plan: 'Plan' }

const MODE_HINTS: Record<GuardMode, string> = {
  watch: 'Only count down; never touch the conversation.',
  ping: 'Keep the cache warm with tiny forked questions, then let it lapse.',
  compact: 'Compact the conversation just before the cache expires.',
  'ping+compact': 'Keep the cache warm with pings first, then compact.',
}

/**
 * The built-in texts behind the options' defaults: what a compaction is told on top of the engine's own
 * summary prompt. Short on purpose: every item asked for lengthens the summary the next requests re-send.
 * CLAUDE.md, the plan, skills and recent files are re-injected after compaction, so they are left out.
 */
const INSTRUCTIONS: Record<GuardProfile, string> = {
  code:
    "Keep it tight: pointers over content. Preserve: user's corrections/preferences/limits quoted verbatim; decisions + why; " +
    'approaches ruled out (1 line each); exact paths, symbols, commands, failing test names, error text; ' +
    'uncommitted/unverified changes; todo state; exact next step. Drop: tool output, code already on disk, resolved debugging detail.',
  debug:
    'Debug focus: symptom + exact repro command; current hypothesis and its evidence; hypotheses ruled out + why (1 line each); ' +
    'exact error text, failing tests, file:line; temporary instrumentation to revert. Drop raw logs and resolved branches.',
  plan:
    "Design focus: goal, constraints and user's preferences verbatim; options considered: chosen + why, rejected + why; " +
    'open questions for the user; agreed plan steps and status. No code snippets or file contents; reference paths only.',
}

/** A numeric setting the panel steps through. */
type Stepper = {
  key: string
  label: string
  hint: string
  min: number
  max: number
  step: number
  get: (v: GuardView) => number
  set: (n: number) => Partial<Settings>
  show: (n: number) => string
}

const STEPPERS: readonly Stepper[] = [
  {
    key: 'maxPings',
    label: 'Pings before compact',
    hint: 'Keep-alive pings in one pause. Ping → Compact compacts after the last one; Ping just stops. Past 10 is ∞.',
    min: 0,
    max: UNLIMITED_PINGS,
    step: 1,
    get: (v: GuardView) => v.maxPings,
    set: (n: number): Partial<Settings> => ({ maxPings: n }),
    show: pingLimitText,
  },
  {
    key: 'margin',
    label: 'Act before expiry',
    hint: 'How long before the cache expires the ping or compact runs.',
    min: 10_000,
    max: 180_000,
    step: 10_000,
    get: (v: GuardView) => v.marginMs,
    set: (n: number): Partial<Settings> => ({ marginMs: n }),
    show: (n: number) => `${n / 1000}s`,
  },
  {
    key: 'minTokens',
    label: 'Minimum context',
    hint: 'Below this the mod only watches: compacting a small context saves little.',
    min: 10_000,
    max: 500_000,
    step: 10_000,
    get: (v: GuardView) => v.minTokens,
    set: (n: number): Partial<Settings> => ({ minTokens: n }),
    show: kTokens,
  },
]

const NOTIFY_STEPPER: Stepper = {
  key: 'notifyLead',
  label: 'Notify how early',
  hint: 'How long before the cache expires, or before the compaction, the notification comes.',
  min: 30_000,
  max: 600_000,
  step: 30_000,
  get: v => v.notifyMs,
  set: n => ({ notifyMs: n }),
  show: durationText,
}

const PING_PROMPT = 'Automated cache keep-alive, not a message from the user. Reply with exactly: ok'

/**
 * A Windows toast from PowerShell's own app id, so nothing has to be installed or registered. With a link, a click
 * on it opens the link: the desktop app, at this session.
 */
const WINDOWS_TOAST =
  '$m=[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];' +
  '$x=$m::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);' +
  "if($env:CACHE_GUARD_LINK){$x.DocumentElement.SetAttribute('activationType','protocol');" +
  "$x.DocumentElement.SetAttribute('launch',$env:CACHE_GUARD_LINK)};" +
  "$t=$x.GetElementsByTagName('text');" +
  '$null=$t.Item(0).AppendChild($x.CreateTextNode($env:CACHE_GUARD_TITLE));' +
  '$null=$t.Item(1).AppendChild($x.CreateTextNode($env:CACHE_GUARD_BODY));' +
  "$m::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe')" +
  '.Show([Windows.UI.Notifications.ToastNotification]::new($x))'

/**
 * The system's own notifiers, tried in turn where no terminal can notify (the desktop app): Windows, macOS, Linux.
 * The text travels in the environment or as plain arguments, never through a shell.
 */
const NATIVE_NOTIFIERS: readonly ((title: string, body: string) => string[])[] = [
  () => ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_TOAST],
  () => [
    'osascript',
    '-e',
    'display notification (system attribute "CACHE_GUARD_BODY") with title (system attribute "CACHE_GUARD_TITLE")',
  ],
  (title, body) => ['notify-send', '--app-name=cache-guard', title, body],
]

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n))

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback

const asTtl = (value: unknown): Ttl | undefined => (value === '5m' || value === '1h' ? value : undefined)

/** An environment flag as Claude Code reads one. */
const isOn = (value: string | undefined): boolean =>
  value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())

/**
 * The TTL Claude Code's own configuration fixes for the main conversation, checked in the engine's order;
 * undefined where its automatic choice applies (1 hour on a subscription within its limits, else 5 minutes).
 */
async function configuredTtl($: EngineInterface): Promise<{ ttl: Ttl; source: string } | undefined> {
  if (isOn(await $.env.get('FORCE_PROMPT_CACHING_5M'))) return { ttl: '5m', source: 'set by FORCE_PROMPT_CACHING_5M' }
  const env = asTtl(await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'))
  if (env) return { ttl: env, source: 'set by CLAUDE_CODE_PROMPT_CACHE_TTL' }
  const settings = (await $.settings.read().catch(() => ({}))) as { promptCacheTtl?: unknown }
  const setting = asTtl(settings.promptCacheTtl)
  if (setting) return { ttl: setting, source: 'set by the promptCacheTtl setting' }
  if (isOn(await $.env.get('ENABLE_PROMPT_CACHING_1H'))) return { ttl: '1h', source: 'set by ENABLE_PROMPT_CACHING_1H' }
  const isBedrock = isOn(await $.env.get('CLAUDE_CODE_USE_BEDROCK'))
  if (isBedrock && isOn(await $.env.get('ENABLE_PROMPT_CACHING_1H_BEDROCK'))) {
    return { ttl: '1h', source: 'set by ENABLE_PROMPT_CACHING_1H_BEDROCK' }
  }
  if (isBedrock || isOn(await $.env.get('CLAUDE_CODE_USE_VERTEX')) || isOn(await $.env.get('CLAUDE_CODE_USE_FOUNDRY'))) {
    return { ttl: '5m', source: 'Bedrock, Vertex and Foundry cache for 5 min' }
  }

  return undefined
}

const ttlOf = (g: Guard): Ttl | undefined => (g.ttlOption === 'auto' ? g.learnedTtl : g.ttlOption)

const settingsOf = (g: Guard): Settings => ({
  mode: g.mode,
  ttlOption: g.ttlOption,
  profile: g.profile,
  maxPings: g.maxPings,
  marginMs: g.marginMs,
  minTokens: g.minTokens,
  toolPings: g.toolPings,
  notify: g.notify,
  notifyMs: g.notifyMs,
})

/** Settings read from the options or the store, each checked and falling back to `base`. */
const settingsFrom = (raw: Partial<Record<keyof Settings, unknown>>, base: Settings): Settings => ({
  mode: pick(raw.mode, MODES, base.mode),
  ttlOption: pick(raw.ttlOption, TTLS, base.ttlOption),
  profile: pick(raw.profile, PROFILES, base.profile),
  maxPings: Math.floor(clamp(num(raw.maxPings, base.maxPings), 0, UNLIMITED_PINGS)),
  marginMs: clamp(num(raw.marginMs, base.marginMs), 0, 600_000),
  minTokens: num(raw.minTokens, base.minTokens),
  toolPings: typeof raw.toolPings === 'boolean' ? raw.toolPings : base.toolPings,
  notify: typeof raw.notify === 'boolean' ? raw.notify : base.notify,
  notifyMs: clamp(num(raw.notifyMs, base.notifyMs), 0, 3_600_000),
})

const nextAction = (g: Guard): 'ping' | 'compact' | null => {
  const canPing = (g.mode === 'ping' || g.mode === 'ping+compact') && (g.maxPings >= UNLIMITED_PINGS || g.pings < g.maxPings)
  if (canPing) return 'ping'
  if (g.mode === 'compact' || g.mode === 'ping+compact') return 'compact'

  return null
}

/** Reads what the first turn after a pause paid: a rewrite of the context means the cache had lapsed. */
const ttlFromProbe = (probe: Probe, usage: ModelUsage): Ttl | undefined => {
  if (usage.cache_creation_input_tokens >= 0.3 * probe.context) return '5m'
  const isRead = usage.cache_read_input_tokens >= 0.7 * probe.context
  if (usage.cache_creation_input_tokens < 0.1 * probe.context && isRead) return '1h'

  return undefined
}

function stopTick(g: Guard) {
  g.tick?.cancel()
  g.tick = undefined
}

function unschedule(g: Guard) {
  g.fire?.cancel()
  g.fire = undefined
  g.notice?.cancel()
  g.notice = undefined
}

async function publish($: EngineInterface, g: Guard) {
  const now = await $.clock.now()
  await update($, view, () => ({
    lastReplyAt: g.lastReplyAt ?? null,
    warmAt: g.warmAt ?? null,
    now,
    isWorking: g.isWorking,
    context: g.context,
    ttl: ttlOf(g) ?? null,
    mode: g.mode,
    ttlOption: g.ttlOption,
    profile: g.profile,
    minTokens: g.minTokens,
    marginMs: g.marginMs,
    maxPings: g.maxPings,
    pings: g.pings,
    stats: g.stats,
    session: g.session,
    toolSince: g.toolSince ?? null,
    toolPings: g.toolPings,
    notify: g.notify,
    notifyMs: g.notifyMs,
    learnedTtl: g.learnedTtl ?? null,
    ttlSource: g.ttlSource ?? null,
    likelyTtl: g.likelyTtl ?? null,
    model: g.model ?? null,
    isOff: g.isOff,
    nextAction: nextAction(g),
    note: g.note,
  }))
}

/** Keeps the band's clock running while the session waits. */
function startTick($: EngineInterface, g: Guard) {
  if (!g.tick && !g.isOff) g.tick = $.clock.every(1000, () => void publish($, g))
}

/** Takes the TTL the latest evidence shows; the session can change it (a subscription past its limits caches for 5 min). */
async function learn($: EngineInterface, g: Guard, value: Ttl | undefined, source: string) {
  if (value === undefined || g.learnedTtl === value) return
  g.learnedTtl = value
  g.ttlSource = source
  if (g.ttlOption === 'auto') $.ui.toast(`cache-guard: this session's cache TTL is ${value} (${source})`)
  await schedule($, g)
}

/** Learns the TTL once two requests in a row were billed at the same cache-write rate. */
async function measured($: EngineInterface, g: Guard, ttl: Ttl | null) {
  if (ttl === null) return
  g.billTtl = g.billTtl?.ttl === ttl ? { ttl, count: g.billTtl.count + 1 } : { ttl, count: 1 }
  if (g.billTtl.count >= 2) await learn($, g, ttl, 'measured from the cache-write price')
}

const added = (s: GuardStats, change: Partial<GuardStats>): GuardStats => {
  const next: GuardStats = { ...s }
  for (const key of Object.keys(change) as (keyof GuardStats)[]) next[key] += change[key] ?? 0

  return next
}

/** Adds to the stats of all sessions, kept in the store, and to this session's. */
async function count($: EngineInterface, g: Guard, change: Partial<GuardStats>) {
  g.stats = added(g.stats, change)
  g.session = added(g.session, change)
  await $.store.set('stats', g.stats)
}

const costOf = (g: Guard) => cacheCost(g.model ?? null, g.context, ttlOf(g) ?? null)

/** A ping's price, counted as spent whether or not it pays off. */
async function pingSpent($: EngineInterface, g: Guard, reply: ModelForkResult) {
  const spent = 'usage' in reply && reply.usage ? callCost(reply.usage, costOf(g), ttlOf(g) ?? null) : 0
  await count($, g, { pings: 1, spentUsd: spent })

  return spent
}

type Ping = { reply: ModelForkResult; at: number; cached: number; isWarm: boolean; spent: number }

/**
 * Sends one ping and writes what came back to the transcript: the answer, what the API read from the cache
 * and wrote, the price, and how far the session's cost ledger moved, so a ping can be checked, not taken on trust.
 */
async function sendPing($: EngineInterface, g: Guard, label: string): Promise<Ping> {
  const before = (await $.session.usage()).cost?.usd
  const at = await $.clock.now()
  const reply = await $.model.fork({ prompt: PING_PROMPT })
  const after = (await $.session.usage()).cost?.usd
  const spent = await pingSpent($, g, reply)
  const cached = 'usage' in reply ? reply.usage.cache_read_input_tokens : 0
  const isWarm = reply.isAnswered && cached >= 0.7 * g.context
  $.ui.log(
    pingLine({
      label,
      isWarm,
      reason: reply.isAnswered ? undefined : reply.reason,
      cached,
      context: g.context,
      written: 'usage' in reply ? reply.usage.cache_creation_input_tokens : 0,
      spent,
      billed: before === undefined || after === undefined ? null : Math.max(0, after - before),
    }),
  )

  return { reply, at, cached, isWarm, spent }
}

/** Credits what the request just made spared, once its usage shows the cache was found. */
async function settle($: EngineInterface, g: Guard, usage: ModelUsage) {
  const credit = g.credit
  g.credit = undefined
  if (!credit) return
  const isFound = !credit.isChecked || usage.cache_read_input_tokens >= 0.7 * g.context
  const spared = `spared ${usdText(credit.amount)} of re-caching`
  if (isFound && credit.before !== undefined && credit.after !== undefined) {
    $.ui.log(`✓ Reply wrote ${kTokens(credit.after)} instead of ${kTokens(credit.before)} · ${spared}`)
  } else if (isFound) {
    $.ui.log(`✓ Reply read ${kTokens(usage.cache_read_input_tokens)} from the cache the ping kept · ${spared}`)
  }
  if (isFound) return count($, g, { avoidedUsd: credit.amount, saves: 1 })
  // The ping said the cache was warm, yet the request that followed paid to write it again.
  g.note = `the ping did not keep the cache: the reply re-wrote ${kTokens(usage.cache_creation_input_tokens)}`
  $.ui.log(
    `✗ Reply re-wrote ${kTokens(usage.cache_creation_input_tokens)} · the ping did not keep the cache warm ` +
      `(read ${kTokens(usage.cache_read_input_tokens)})`,
  )
  await count($, g, { pingMisses: 1 })
}

/** Sets the action for the margin before the warm cache lapses, and the notification ahead of it. */
async function schedule($: EngineInterface, g: Guard) {
  unschedule(g)
  const known = ttlOf(g)
  if (g.isOff || g.warmAt === undefined || g.isWorking || known === undefined) return
  const left = g.warmAt + TTL_MS[known] - (await $.clock.now())
  if (left <= 0) return
  const action = nextAction(g)
  if (action !== null) g.fire = $.clock.after(Math.max(0, left - g.marginMs), () => void act($, g))
  // A ping keeps the cache, so only the lapse or the compaction after the last one is worth a notification.
  if (!g.notify || action === 'ping' || g.context < g.minTokens) return
  const until = action === 'compact' ? left - g.marginMs : left
  if (until > 0) g.notice = $.clock.after(Math.max(0, until - g.notifyMs), () => void notify($, g))
}

/** Tells the person, through their notification channel, that the cache is about to lapse or be compacted. */
async function notify($: EngineInterface, g: Guard) {
  g.notice = undefined
  const known = ttlOf(g)
  if (g.isOff || g.isWorking || g.warmAt === undefined || known === undefined) return
  const left = g.warmAt + TTL_MS[known] - (await $.clock.now())
  const isCompact = nextAction(g) === 'compact'
  const until = isCompact ? left - g.marginMs : left
  if (until <= 0) return
  const cost = costOf(g)
  const title = isCompact ? `Compacting in ${durationText(until)}` : `Prompt cache expires in ${durationText(until)}`
  const body = isCompact
    ? `cache-guard compacts ${kTokens(g.context)} before the cache expires. Reply before then to keep the full context.`
    : `The next reply then re-writes ${kTokens(g.context)}: ≈ ${usdText(cost.cold)} instead of ${usdText(cost.warm)}.`
  await raise($, g, title, body)
}

/** Raises a notification; says whether it went out, or why not. */
async function raise($: EngineInterface, g: Guard, title: string, body: string): Promise<string | null> {
  const sent = await $.ui.notify(body, { title }).catch(() => ({ isSent: false as const, reason: 'refused' as const }))
  if (sent.isSent) return null
  if (sent.reason === 'disabled') return "notifications are turned off in Claude Code's settings"
  if (sent.reason === 'refused') return 'a Notification hook refused it'
  // No terminal to notify through (the desktop app), or none that notifies: the system's own notification
  // reaches the person in another session or another window too.
  return (await nativeNotify($, g, title, body)) ? null : 'the system has no notifier cache-guard can run'
}

/** The Notification section's button: one notification now, to see that it arrives and where a click leads. */
async function testNotify($: EngineInterface, g: Guard) {
  const body = g.link ? 'Notifications work. Click this one to come back to the session.' : 'Notifications work.'
  const failure = await raise($, g, 'cache-guard test', body)
  $.ui.toast(failure ? `cache-guard: no notification: ${failure}` : 'cache-guard: test notification sent')
}

/** Raises the notification with the first of the system's notifiers that works, starting with the last one that did. */
async function nativeNotify($: EngineInterface, g: Guard, title: string, body: string): Promise<boolean> {
  const env = { CACHE_GUARD_TITLE: title, CACHE_GUARD_BODY: body, CACHE_GUARD_LINK: g.link ?? '' }
  const order = NATIVE_NOTIFIERS.map((make, i) => ({ make, i }))
  order.sort((a, b) => Number(b.i === g.notifier) - Number(a.i === g.notifier))
  for (const { make, i } of order) {
    const isShown = await $.process
      .run(make(title, body), { env, timeoutMs: 15_000 })
      .then(done => done.exitCode === 0)
      .catch(() => false)
    if (isShown) {
      g.notifier = i
      return true
    }
  }

  return false
}

/** Starts guarding a cache touched at `at`. */
async function arm($: EngineInterface, g: Guard, at: number) {
  g.warmAt = at
  startTick($, g)
  await schedule($, g)
  await publish($, g)
}

async function compact($: EngineInterface, g: Guard) {
  g.hasActed = true
  unschedule(g)
  g.note = `compacting ${kTokens(g.context)}…`
  await publish($, g)
  try {
    const done = await $.session.compact({ instructions: g.instructions[g.profile] })
    if (done.skip !== undefined) {
      g.note = `compact skipped: ${done.skip}`
      $.ui.log(`✗ Compact skipped · ${done.skip}`)
      return
    }
    const before = done.tokensBefore ?? g.context
    const after = done.tokensAfter ?? 0
    const spent = done.usage ? callCost(done.usage, costOf(g), ttlOf(g) ?? null) : 0
    // The cache was about to lapse: the next reply writes the summary instead of the whole context.
    const rates = costOf(g).rates
    const write = ttlOf(g) === '1h' ? rates.write1h : rates.write5m
    g.credit = { amount: ((before - after) * write) / 1e6, isChecked: false, before, after }
    $.ui.log(`✓ Compacted ${kTokens(before)} → ${kTokens(after)} before the cache expired · ≈ ${usdText(spent)}`)
    g.warmAt = undefined
    g.context = after
    await count($, g, { compactions: 1, tokensBefore: before, tokensAfter: after, spentUsd: spent })
    g.note = `compacted ${kTokens(before)} → ${kTokens(after)}`
  } catch {
    // A turn started meanwhile: its end re-arms the countdown.
    g.note = 'compact did not start (a turn was running)'
  } finally {
    await publish($, g)
  }
}

async function ping($: EngineInterface, g: Guard) {
  g.hasActed = true
  g.pings += 1
  const { at, cached, isWarm } = await sendPing($, g, `Ping ${g.pings}/${pingLimitText(g.maxPings)}`)
  if (isWarm) {
    g.credit = { amount: costOf(g).lapse, isChecked: true }
    g.note = `ping ${g.pings}/${pingLimitText(g.maxPings)} kept ${kTokens(cached)} warm`
    // The entry lives from the ping request's start, not from its end.
    await arm($, g, at)
    return
  }
  g.credit = undefined
  await count($, g, { pingMisses: 1 })
  g.note = `ping missed the cache (${kTokens(cached)} of ${kTokens(g.context)})`
  $.ui.toast(`cache-guard: ${g.note}`)
  if (g.mode === 'ping+compact') return compact($, g)
  await publish($, g)
}

async function act($: EngineInterface, g: Guard) {
  const known = ttlOf(g)
  if (g.isOff || g.isWorking || g.warmAt === undefined || known === undefined) return
  if ((await $.clock.now()) >= g.warmAt + TTL_MS[known]) return
  g.context = (await $.session.usage()).context.tokens ?? g.context
  if (g.context < g.minTokens) {
    g.note = `${kTokens(g.context)} is below the minimum, no action`
    await publish($, g)
    return
  }
  const action = nextAction(g)
  if (action === 'ping') return ping($, g)
  if (action === 'compact') return compact($, g)
}

/** Sets the next ping of a tool wait for the margin before the cache it started on lapses. */
async function scheduleWait($: EngineInterface, g: Guard) {
  g.waitFire?.cancel()
  g.waitFire = undefined
  const known = ttlOf(g)
  if (g.isOff || g.mode === 'watch' || !g.toolPings || g.toolsRunning === 0 || g.waitAt === undefined || !known) return
  const left = g.waitAt + TTL_MS[known] - (await $.clock.now())
  if (left <= 0) return
  g.waitFire = $.clock.after(Math.max(0, left - g.marginMs), () => void waitPing($, g))
}

/** Keeps the cache warm while a tool runs, as long as pinging stays cheaper than re-caching. */
async function waitPing($: EngineInterface, g: Guard) {
  if (g.toolsRunning === 0 || g.isOff) return
  const cost = costOf(g)
  if (g.context < g.minTokens) {
    g.note = `${kTokens(g.context)} is below the minimum, no ping`
    return publish($, g)
  }
  if (g.waitSpent + cost.warm >= cost.lapse) {
    g.note = 'long tool: re-caching is now cheaper than more pings'
    return publish($, g)
  }
  const { at, cached, isWarm, spent } = await sendPing($, g, `Ping ${g.waitPings + 1} during a tool`)
  g.waitSpent += spent
  if (!isWarm) {
    await count($, g, { pingMisses: 1 })
    g.note = `ping missed the cache (${kTokens(cached)} of ${kTokens(g.context)})`
    g.waitPings = 0
    return publish($, g)
  }
  g.waitPings += 1
  g.waitAt = at
  g.note = `ping ${g.waitPings} kept ${kTokens(cached)} warm`
  await scheduleWait($, g)
  await publish($, g)
}

async function toolStarts($: EngineInterface, g: Guard) {
  g.toolsRunning += 1
  if (g.toolsRunning > 1) return
  const now = await $.clock.now()
  g.toolSince = now
  g.waitAt = g.requestAt ?? now
  g.waitPings = 0
  g.waitSpent = 0
  await scheduleWait($, g)
  await publish($, g)
}

async function toolEnds($: EngineInterface, g: Guard) {
  g.toolsRunning = Math.max(0, g.toolsRunning - 1)
  if (g.toolsRunning > 0) return
  g.waitFire?.cancel()
  g.waitFire = undefined
  const now = await $.clock.now()
  if (g.waitPings > 0) {
    g.credit = { amount: costOf(g).lapse, isChecked: true }
  } else if (g.waitAt !== undefined && g.context >= 5000) {
    // A tool that outlasted 5 minutes unpinged tells the TTL by what the next request pays.
    const gapMs = now - g.waitAt
    if (gapMs > TTL_MS['5m'] + 30_000 && gapMs < TTL_MS['1h'] - 30_000) g.probe = { context: g.context }
  }
  g.toolSince = undefined
  g.waitAt = undefined
  await publish($, g)
}

/**
 * A main-loop model request: its usage names the model and the context, its bill the TTL its cache writes had,
 * and it settles what the mod spared.
 */
async function stepped($: EngineInterface, g: Guard, usage: TurnUsage | null, billed: number | null) {
  if (!usage) return
  g.model = usage.model
  if (billed !== null) await measured($, g, ttlFromBill(usage.model, usage, billed))
  if (g.probe) await learn($, g, ttlFromProbe(g.probe, usage), 'learned from a pause')
  g.probe = undefined
  await settle($, g, usage)
  g.context = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
}

async function changeSettings($: EngineInterface, g: Guard, change: Partial<Settings>) {
  Object.assign(g, settingsFrom(change, settingsOf(g)))
  await $.store.set('settings', settingsOf(g))
  await schedule($, g)
  await publish($, g)
}

async function resetSettings($: EngineInterface, g: Guard, defaults: Settings) {
  Object.assign(g, defaults)
  await $.store.delete('settings')
  await schedule($, g)
  await publish($, g)
}

/** Turns the mod off or on for this session alone; the session's state keeps it across reloads. */
async function setOff($: EngineInterface, g: Guard, isOff: boolean) {
  g.isOff = isOff
  if (isOff) {
    stopTick(g)
    unschedule(g)
    $.ui.toast('cache-guard is off for this session; /cache-guard turns it back on')
  } else {
    if (g.lastReplyAt !== undefined && !g.isWorking) startTick($, g)
    await schedule($, g)
  }
  await publish($, g)
}

async function nextProfile($: EngineInterface, g: Guard) {
  const profile = PROFILES[(PROFILES.indexOf(g.profile) + 1) % PROFILES.length]
  await changeSettings($, g, { profile })
}

async function openSettings($: EngineInterface) {
  await $.ui.open({ id: SETTINGS_PANE, title: 'Cache guard', focus: true, closeOnEscape: true })
}

/** The view as drawn, over the defaults: one written by an older version lacks the newer fields. */
async function current($: EngineInterface): Promise<GuardView> {
  const v = await read($, view)

  return {
    ...INITIAL_VIEW,
    ...v,
    stats: { ...NO_STATS, ...v.stats },
    session: { ...NO_STATS, ...v.session },
  }
}

async function report($: EngineInterface, g: Guard): Promise<string> {
  const v = await current($)
  const ttlText =
    g.ttlOption === 'auto' ? `auto (${g.learnedTtl ? `${g.learnedTtl}, ${g.ttlSource}` : 'not known yet'})` : g.ttlOption
  const cost = cacheCost(g.model ?? null, g.context, ttlOf(g) ?? null)
  const lines = [
    `session: ${g.isOff ? 'off (this session only)' : 'on'}`,
    `mode: ${MODE_LABELS[g.mode]} · TTL: ${ttlText} · pings before compact: ${pingLimitText(g.maxPings)} · ` +
      `act ${g.marginMs / 1000}s before expiry · minimum ${kTokens(g.minTokens)}`,
    `notification: ${g.notify ? `${durationText(g.notifyMs)} before the cache expires or is compacted` : 'off'}`,
    `now: ${line({ ...v, now: await $.clock.now() })}`,
    `cost at ${cost.name ?? 'an assumed'} API price: next reply ≈ ${usdText(cost.warm)} while warm, ≈ ${usdText(cost.cold)} after expiry`,
    `compact profile: ${g.profile} — ${g.instructions[g.profile]}`,
    `this session: ${statsLine(g.session)}`,
    `total: ${statsLine(g.stats)}`,
  ]

  return lines.join('\n')
}

/** The panel's edits of the profiles' texts, kept in the store over the options'. */
async function loadInstructions($: EngineInterface, g: Guard) {
  const edits = ((await $.store.get('instructions')) ?? {}) as Partial<Record<GuardProfile, unknown>>
  g.instructions = { ...g.optionInstructions }
  for (const profile of PROFILES) g.instructions[profile] = text(edits[profile], g.optionInstructions[profile])
}

/** Saves a profile's text from the panel; an empty one, or the options' own, drops the edit. */
async function setInstruction($: EngineInterface, g: Guard, profile: GuardProfile, value: string) {
  const edits = { ...(((await $.store.get('instructions')) ?? {}) as Partial<Record<GuardProfile, string>>) }
  const trimmed = value.trim()
  if (!trimmed || trimmed === g.optionInstructions[profile]) delete edits[profile]
  else edits[profile] = trimmed
  await $.store.set('instructions', edits)
  await loadInstructions($, g)
  await publish($, g)
}

async function restore($: EngineInterface, g: Guard) {
  // The desktop app names its session; its claude:// link opens the app at it.
  const host = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
  g.link = host && /^local_[A-Za-z0-9-]{1,64}$/.test(host) ? `claude://code/continue?session=${host}&source=cache-guard` : undefined
  Object.assign(g, settingsFrom((await $.store.get('settings')) ?? {}, settingsOf(g)))
  await loadInstructions($, g)
  g.stats = { ...NO_STATS, ...((await $.store.get('stats')) as Partial<GuardStats> | undefined) }

  // A reload keeps the session's state but not this module's: pick the countdown up where it was.
  const v = await current($)
  g.isOff = v.isOff
  g.model = v.model ?? undefined
  g.session = { ...NO_STATS, ...v.session }
  g.likelyTtl = v.likelyTtl ?? undefined
  // The TTL is the session's own: what this session learned, else what Claude Code's configuration fixes.
  g.learnedTtl = v.learnedTtl ?? undefined
  g.ttlSource = v.ttlSource ?? undefined
  const configured = g.learnedTtl ? undefined : await configuredTtl($)
  if (configured) {
    g.learnedTtl = configured.ttl
    g.ttlSource = configured.source
  }
  if (v.lastReplyAt === null) return publish($, g)
  g.context = v.context
  g.note = v.note
  g.pings = v.pings
  if (v.isWorking) {
    // The engine reloads a mod as a turn ends, so that turn's reply is the last one.
    const now = await $.clock.now()
    g.lastReplyAt = now
    return arm($, g, now)
  }
  g.lastReplyAt = v.lastReplyAt
  if (v.warmAt !== null) return arm($, g, v.warmAt)
  startTick($, g)
  await publish($, g)
}

async function turnStarts($: EngineInterface, g: Guard) {
  g.probe = undefined
  if (g.warmAt !== undefined && !g.hasActed) {
    const gapMs = (await $.clock.now()) - g.warmAt
    const isTelling = gapMs > TTL_MS['5m'] + 30_000 && gapMs < TTL_MS['1h'] - 30_000
    if (isTelling && g.context >= 5000) g.probe = { context: g.context }
  }
  stopTick(g)
  unschedule(g)
  g.isWorking = true
  g.warmAt = undefined
  g.requestAt = undefined
  g.note = ''
  await publish($, g)
}

async function turnEnds($: EngineInterface, g: Guard, usage: TurnUsage | undefined) {
  if (g.probe && usage) await learn($, g, ttlFromProbe(g.probe, usage), 'learned from a pause')
  if (usage?.model) g.model = usage.model
  if (usage) await settle($, g, usage)
  g.probe = undefined
  g.isWorking = false
  g.toolsRunning = 0
  g.toolSince = undefined
  const measured = await $.session.usage()
  g.context = measured.context.tokens ?? 0
  // Usage limits are reported on a subscription alone, which caches for an hour until it runs past them.
  const isWithinLimits = measured.rateLimits.length > 0 && measured.rateLimits.every(limit => limit.percentUsed < 100)
  g.likelyTtl = isWithinLimits ? '1h' : '5m'
  g.pings = 0
  g.hasActed = false
  g.note = ''
  const now = await $.clock.now()
  g.lastReplyAt = now
  await arm($, g, Math.min(now, g.requestAt ?? now))
}

async function compacted($: EngineInterface, g: Guard) {
  unschedule(g)
  g.warmAt = undefined
  await publish($, g)
}

export const register: Register = (on, options) => {
  const defaults = settingsFrom(
    {
      mode: options.mode,
      ttlOption: options.ttl,
      profile: options.profile,
      maxPings: options.maxPings,
      marginMs: num(options.marginSeconds, 30) * 1000,
      minTokens: options.minTokens,
      toolPings: options.toolPings,
      notify: options.notify,
      notifyMs: num(options.notifySeconds, 60) * 1000,
    },
    {
      mode: 'compact',
      ttlOption: 'auto',
      profile: 'code',
      maxPings: 2,
      marginMs: 30_000,
      minTokens: 50_000,
      toolPings: true,
      notify: true,
      notifyMs: 60_000,
    },
  )
  const optionInstructions: Record<GuardProfile, string> = {
    code: text(options.instructionsCode, INSTRUCTIONS.code),
    debug: text(options.instructionsDebug, INSTRUCTIONS.debug),
    plan: text(options.instructionsPlan, INSTRUCTIONS.plan),
  }
  const g: Guard = {
    ...defaults,
    instructions: { ...optionInstructions },
    optionInstructions,
    stats: { ...NO_STATS },
    isWorking: false,
    context: 0,
    pings: 0,
    isOff: false,
    hasActed: false,
    note: '',
    session: { ...NO_STATS },
    toolsRunning: 0,
    waitPings: 0,
    waitSpent: 0,
  }

  on('session.start', async ($, e, next) => {
    // The status line entry of earlier versions, should one still show.
    $.ui.status(undefined)
    await restore($, g)
    await $.command.register({
      name: 'cache-guard',
      description: 'Cache guard: open its settings and show the countdown and stats',
    })

    return next(e)
  })

  on('command.run', { command: 'cache-guard' }, async $ => {
    await openSettings($)

    return { text: await report($, g) }
  })

  on('turn.start', async ($, e, next) => {
    await turnStarts($, g)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) await turnEnds($, g, e.usage)

    return done
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    g.requestAt = await $.clock.now()
    const before = (await $.session.usage()).cost?.usd
    const response = yield* next(e)
    const after = (await $.session.usage()).cost?.usd
    await stepped($, g, response.usage, before === undefined || after === undefined ? null : after - before)

    return response
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await toolStarts($, g)
    try {
      return await next(e)
    } finally {
      await toolEnds($, g)
    }
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.trigger !== 'precompute' && done.skip === undefined) await compacted($, g)

    return done
  }).catch(($, e, next) => next(e))

  on('classic.PreCompact', async ($, e, next) => {
    // Newer engines pass the session's cache TTL here; older ones leave it out.
    await learn($, g, asTtl((e as { cache_ttl?: unknown }).cache_ttl), 'reported by Claude Code')

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PreModelSwitch', async ($, e, next) => {
    await learn($, g, e.cache_ttl, 'reported by Claude Code')

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await current($)
    if (e.props.hasSurvey || v.isOff) return next(e)
    const p = bandParts(v)
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // The terminal's table answers `Svg` with an empty stand-in, so ask the surface rather than the table.
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    const session = savingsText(v.session)
    const total = savingsText(v.stats)
    const saved = total ? `${session ?? 'saved $0'} this session · ${total} in all` : null

    return (
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2} rowGap={1} paddingX={1}>
        <Box flexDirection="row" alignItems="center" columnGap={1} flexGrow={1} flexShrink={1}>
          {Svg ? (
            <Svg source={ringSvg(p)} alt={p.title} width={18} height={18} isInteractive={p.isSpinning ? true : undefined} />
          ) : (
            <Text color={p.tone}>{p.isSpinning ? '◌' : '●'}</Text>
          )}
          <Box flexDirection="column" flexShrink={1}>
            <Box flexDirection="row" columnGap={2}>
              <Text bold color={p.tone}>
                {p.title}
              </Text>
              {saved ? <Text color={saved.startsWith('net') ? 'warning' : 'success'}>{saved}</Text> : null}
            </Box>
            <Text dimColor wrap="truncate-end">
              {p.details.join('  ·  ')}
            </Text>
          </Box>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1} rowGap={1}>
          {v.ttl === null
            ? (['5m', '1h'] as const).map(ttlOption => (
                <Button
                  key={`ttl-${ttlOption}`}
                  label={`TTL ${TTL_LABELS[ttlOption]}`}
                  variant={ttlOption === (v.likelyTtl ?? '5m') ? 'primary' : 'secondary'}
                  onPress={() => changeSettings($, g, { ttlOption })}
                />
              ))
            : null}
          {MODES.map(mode => (
            <Button
              key={`mode-${mode}`}
              label={MODE_LABELS[mode]}
              variant={mode === v.mode ? 'primary' : 'secondary'}
              onPress={() => changeSettings($, g, { mode })}
            />
          ))}
          <Button key="profile" label={`Profile: ${PROFILE_LABELS[v.profile]}`} onPress={() => nextProfile($, g)} />
          <Button key="settings" label="⚙ Settings" onPress={() => openSettings($)} />
          <Button key="off" label="Off" dimColor onPress={() => setOff($, g, true)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, async ($, e) => {
    const v = await current($)
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // Every surface but mobile draws a field.
    const Input = 'Input' in elements ? elements.Input : undefined
    const isEdited = g.instructions[v.profile] !== g.optionInstructions[v.profile]
    const learned = v.ttlOption === 'auto' ? (v.ttl ? `${v.ttl}, ${v.ttlSource ?? 'learned'}` : 'not learned yet') : undefined
    const cost = cacheCost(v.model, v.context, v.ttl)
    const rates = cost.rates
    // Unlimited pings keep an idle session warm for good: say what an hour of that costs against one re-cache.
    const pingsPerHour = 3_600_000 / Math.max(60_000, TTL_MS[v.ttl ?? '5m'] - v.marginMs)
    const perHour = pingsPerHour * cost.warm
    const unlimitedHint =
      v.context > 0
        ? `∞ while idle: ≈ ${usdText(perHour)} an hour at ${kTokens(v.context)}; past ` +
          `${(cost.lapse / perHour).toFixed(1)} h that is more than one re-cache (${usdText(cost.cold)}). ` +
          'Ping → Compact never compacts.'
        : '∞ while idle: the hourly cost shows after the first reply. Ping → Compact never compacts.'
    // Each row wraps its controls under its label when the panel is narrow.
    const row = { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', columnGap: 2, rowGap: 1 } as const
    const stepRow = (s: Stepper) => (
      <Box {...row}>
        <Box flexDirection="column" flexShrink={1}>
          <Text>{s.label}</Text>
          <Text dimColor>{s.hint}</Text>
          {s.key === 'maxPings' && v.maxPings >= UNLIMITED_PINGS ? <Text color="warning">{unlimitedHint}</Text> : null}
        </Box>
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          <Button
            key={`dec-${s.key}`}
            label="−"
            onPress={() => changeSettings($, g, s.set(Math.max(s.min, s.get(v) - s.step)))}
          />
          <Text bold>{s.show(s.get(v))}</Text>
          <Button
            key={`inc-${s.key}`}
            label="+"
            onPress={() => changeSettings($, g, s.set(Math.min(s.max, s.get(v) + s.step)))}
          />
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column" paddingX={1} rowGap={1}>
        <Text bold>Session</Text>
        <Box {...row}>
          <Box flexDirection="column" flexShrink={1}>
            <Text>{v.isOff ? 'Off in this session' : 'On in this session'}</Text>
            <Text dimColor>Turning it off hides the band and stops every ping and compact until this session ends.</Text>
          </Box>
          <Button
            key="toggle-off"
            label={v.isOff ? 'Turn on' : 'Turn off for this session'}
            variant={v.isOff ? 'primary' : 'secondary'}
            onPress={() => setOff($, g, !v.isOff)}
          />
        </Box>

        <Text bold>Behaviour</Text>
        <Box {...row}>
          <Box flexDirection="column" flexShrink={1}>
            <Text>Mode</Text>
            <Text dimColor>{MODE_HINTS[v.mode]}</Text>
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {MODES.map(mode => (
              <Button
                key={`set-mode-${mode}`}
                label={MODE_LABELS[mode]}
                variant={mode === v.mode ? 'primary' : 'secondary'}
                onPress={() => changeSettings($, g, { mode })}
              />
            ))}
          </Box>
        </Box>

        <Box {...row}>
          <Box flexDirection="column" flexShrink={1}>
            <Text>Cache TTL</Text>
            <Text dimColor>
              {learned ? `Auto: ${learned}. The mod acts only once the TTL is known.` : 'Set by hand.'}
            </Text>
          </Box>
          <Box flexDirection="row" columnGap={1}>
            {TTLS.map(ttlOption => (
              <Button
                key={`set-ttl-${ttlOption}`}
                label={TTL_LABELS[ttlOption]}
                variant={ttlOption === v.ttlOption ? 'primary' : 'secondary'}
                onPress={() => changeSettings($, g, { ttlOption })}
              />
            ))}
          </Box>
        </Box>

        <Box {...row}>
          <Box flexDirection="column" flexShrink={1}>
            <Text>Keep warm during long tools</Text>
            <Text dimColor>
              Pings while a tool (tests, a build) outlasts the cache, as long as that stays cheaper than re-caching. Off in Watch.
            </Text>
          </Box>
          <Box flexDirection="row" columnGap={1}>
            <Button
              key="set-toolPings-on"
              label="On"
              variant={v.toolPings ? 'primary' : 'secondary'}
              onPress={() => changeSettings($, g, { toolPings: true })}
            />
            <Button
              key="set-toolPings-off"
              label="Off"
              variant={v.toolPings ? 'secondary' : 'primary'}
              onPress={() => changeSettings($, g, { toolPings: false })}
            />
          </Box>
        </Box>

        {STEPPERS.map(stepRow)}

        <Text bold>Notification</Text>
        <Box {...row}>
          <Box flexDirection="column" flexShrink={1}>
            <Text>Notify before expiry</Text>
            <Text dimColor>
              A system notification before the cache lapses, or before the compaction, so you can reply in time. None while
              pings keep the cache warm. Without a terminal that notifies (the desktop app) it is the system's own notification.
            </Text>
          </Box>
          <Box flexDirection="row" columnGap={1}>
            <Button
              key="set-notify-on"
              label="On"
              variant={v.notify ? 'primary' : 'secondary'}
              onPress={() => changeSettings($, g, { notify: true })}
            />
            <Button
              key="set-notify-off"
              label="Off"
              variant={v.notify ? 'secondary' : 'primary'}
              onPress={() => changeSettings($, g, { notify: false })}
            />
          </Box>
        </Box>
        {v.notify ? stepRow(NOTIFY_STEPPER) : null}
        <Box {...row}>
          <Text dimColor>
            {g.link
              ? 'On Windows a click on the notification brings you back to this session.'
              : 'Check that notifications reach you.'}
          </Text>
          <Button key="notify-test" label="Send a test" onPress={() => testNotify($, g)} />
        </Box>

        <Text bold>Compaction</Text>
        <Box {...row}>
          <Box flexDirection="column" flexShrink={1}>
            <Text>Instruction profile</Text>
            <Text dimColor>What a compaction is told to keep. The band's Profile button switches it too.</Text>
          </Box>
          <Box flexDirection="row" columnGap={1}>
            {PROFILES.map(profile => (
              <Button
                key={`set-profile-${profile}`}
                label={PROFILE_LABELS[profile]}
                variant={profile === v.profile ? 'primary' : 'secondary'}
                onPress={() => changeSettings($, g, { profile })}
              />
            ))}
          </Box>
        </Box>
        <Box flexDirection="column" rowGap={1}>
          {Input ? (
            <Input
              key={`edit-${v.profile}`}
              label={`${PROFILE_LABELS[v.profile]} prompt`}
              value={g.instructions[v.profile]}
              placeholder="What the summary must keep"
              submitLabel="save"
              onSubmit={value => setInstruction($, g, v.profile, value)}
            />
          ) : (
            <Text>{g.instructions[v.profile]}</Text>
          )}
          <Box {...row}>
            <Text dimColor>
              {isEdited
                ? 'Edited here: Enter saves, an empty field goes back to the default.'
                : 'Default text: edit it above and press Enter to save.'}
            </Text>
            {isEdited ? (
              <Button
                key="reset-instruction"
                label="Restore default"
                onPress={() => setInstruction($, g, v.profile, '')}
              />
            ) : null}
          </Box>
        </Box>

        <Text bold>Cost</Text>
        <Box flexDirection="column">
          <Text>
            {v.context > 0
              ? `Next reply ≈ ${usdText(cost.warm)} while the cache is warm, ≈ ${usdText(cost.cold)} once it has expired.`
              : 'Shown after the first reply.'}
          </Text>
          <Text dimColor>
            {`${cost.name ?? 'Model not known yet, assumed'} list price per million tokens: cache write ` +
              `$${rates.write5m} (5 min) / $${rates.write1h} (1 hour), cache read $${rates.read}. ` +
              'Only the context is counted, not the reply.'}
          </Text>
        </Box>

        <Text bold>Savings</Text>
        {(
          [
            ['This session', v.session],
            ['All sessions', v.stats],
          ] as const
        ).map(([label, stats]) => (
          <Box flexDirection="column">
            <Text>
              {`${label}: ${savingsText(stats) ?? 'nothing yet'}` +
                (stats.saves > 0 ? ` · ${stats.saves} lapses avoided` : '')}
            </Text>
            <Text dimColor>{statsLine(stats)}</Text>
          </Box>
        ))}
        <Text dimColor>
          Spared re-caching is counted only once a reply found the cache the mod kept warm, or the smaller context it left;
          every ping and compaction is counted as spent.
        </Text>

        <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
          <Button key="reset" label="Reset to the options' defaults" onPress={() => resetSettings($, g, defaults)} />
          <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: SETTINGS_PANE })} />
        </Box>
      </Box>
    )
  })
}
