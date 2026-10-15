import type { GuardStats, GuardView, Ttl } from '../types'

export const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

export const NO_STATS: GuardStats = {
  compactions: 0,
  tokensBefore: 0,
  tokensAfter: 0,
  pings: 0,
  pingMisses: 0,
  avoidedUsd: 0,
  spentUsd: 0,
  saves: 0,
}

/** Where the band starts before the session's first refresh. */
export const INITIAL_VIEW: GuardView = {
  lastReplyAt: null,
  warmAt: null,
  now: 0,
  isWorking: false,
  context: 0,
  ttl: null,
  mode: 'compact',
  ttlOption: 'auto',
  profile: 'code',
  minTokens: 50_000,
  marginMs: 30_000,
  maxPings: 2,
  pings: 0,
  stats: NO_STATS,
  session: NO_STATS,
  toolSince: null,
  toolPings: true,
  notify: true,
  notifyMs: 60_000,
  likelyTtl: null,
  model: null,
  isOff: false,
  nextAction: null,
  note: '',
}

const MINUTE = 60_000

/** A ping limit at or past this pings without end; the store and the options keep it as a plain number. */
export const UNLIMITED_PINGS = 11

export const pingLimitText = (n: number): string => (n >= UNLIMITED_PINGS ? '∞' : String(n))

export const kTokens = (n: number): string => `${Math.round(n / 1000)}k`

/** A countdown: minutes while far, m:ss in the last ten minutes. */
export const clockText = (ms: number): string => {
  if (ms > 10 * MINUTE) return `${Math.ceil(ms / MINUTE)} min`
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A span in words: `45 s`, `1 min`, `2 min 30 s`. */
export const durationText = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  if (m === 0) return `${s} s`
  return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`
}

/** Time gone by: m:ss under an hour, then hours and minutes. */
export const elapsedText = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

/** Rates in US dollars per million tokens. */
export type Rates = { input: number; output: number; write5m: number; write1h: number; read: number }

type Tier = Rates & { long?: Rates & { above: number } }

/** The engine's baked-in model catalog's list prices (Claude Code 2.1.295), per pricing tier. */
const TIERS = {
  t2: { input: 2, output: 10, write5m: 2.5, write1h: 4, read: 0.2 },
  t3: { input: 3, output: 15, write5m: 3.75, write1h: 6, read: 0.3 },
  t4: { input: 4, output: 20, write5m: 5, write1h: 8, read: 0.2 },
  t5: { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5 },
  t10: { input: 10, output: 50, write5m: 12.5, write1h: 20, read: 1 },
  t10r: { input: 10, output: 50, write5m: 12.5, write1h: 20, read: 0.25 },
  t15: { input: 15, output: 75, write5m: 18.75, write1h: 30, read: 1.5 },
  haiku35: { input: 0.8, output: 4, write5m: 1, write1h: 1.6, read: 0.08 },
  haiku45: { input: 1, output: 5, write5m: 1.25, write1h: 2, read: 0.1 },
  haiku55: {
    input: 0.1,
    output: 0.5,
    write5m: 0.125,
    write1h: 0.2,
    read: 0.01,
    long: { above: 100_000, input: 0.5, output: 2.5, write5m: 0.625, write1h: 1, read: 0.05 },
  },
} satisfies Record<string, Tier>

/** Model ids, matched as the longest one the model's id contains, with their name and tier. */
const MODELS: [string, string, keyof typeof TIERS][] = [
  ['claude-3-5-haiku', 'Haiku 3.5', 'haiku35'],
  ['claude-haiku-4-5', 'Haiku 4.5', 'haiku45'],
  ['claude-haiku-5-5', 'Haiku 5.5', 'haiku55'],
  ['claude-3-5-sonnet', 'Sonnet 3.5', 't3'],
  ['claude-3-7-sonnet', 'Sonnet 3.7', 't3'],
  ['claude-sonnet-4', 'Sonnet 4', 't3'],
  ['claude-sonnet-4-5', 'Sonnet 4.5', 't3'],
  ['claude-sonnet-4-6', 'Sonnet 4.6', 't3'],
  ['claude-sonnet-5', 'Sonnet 5', 't2'],
  ['claude-sonnet-5-5', 'Sonnet 5.5', 't2'],
  ['claude-opus-4', 'Opus 4', 't15'],
  ['claude-opus-4-1', 'Opus 4.1', 't15'],
  ['claude-opus-4-5', 'Opus 4.5', 't5'],
  ['claude-opus-4-6', 'Opus 4.6', 't5'],
  ['claude-opus-4-7', 'Opus 4.7', 't5'],
  ['claude-opus-4-8', 'Opus 4.8', 't5'],
  ['claude-opus-5', 'Opus 5', 't5'],
  ['claude-opus-5-5', 'Opus 5.5', 't4'],
  ['claude-fable-5', 'Fable 5', 't10'],
  ['claude-fable-5-1', 'Fable 5.1', 't10r'],
  ['claude-mythos-5', 'Mythos 5', 't10'],
  ['claude-mythos-5-1', 'Mythos 5.1', 't10r'],
]

/** What re-caching or reading the context costs, at the model's list price. */
export type CacheCost = {
  /** The model's name, or null when the price is the default tier's guess. */
  name: string | null
  rates: Rates
  /** The next reply on a warm cache: the context read. */
  warm: number
  /** The next reply after expiry: the context written again at the TTL's rate. */
  cold: number
  /** What a reply on a warm cache saves over one after expiry. */
  lapse: number
}

export const cacheCost = (model: string | null, context: number, ttl: Ttl | null): CacheCost => {
  const id = (model ?? '').toLowerCase()
  const found = MODELS.filter(([key]) => id.includes(key)).sort((a, b) => b[0].length - a[0].length)[0]
  const tier: Tier = found ? TIERS[found[2]] : TIERS.t5
  const rates: Rates = tier.long && context > tier.long.above ? tier.long : tier
  const write = ttl === '1h' ? rates.write1h : rates.write5m

  const warm = (context * rates.read) / 1e6
  const cold = (context * write) / 1e6

  return { name: found?.[1] ?? null, rates, warm, cold, lapse: cold - warm }
}

/** What one model call cost, from its usage, at the rates `cacheCost` found. */
export const callCost = (
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number },
  cost: CacheCost,
  ttl: Ttl | null,
): number => {
  const r = cost.rates
  const write = ttl === '1h' ? r.write1h : r.write5m

  return (
    (usage.input_tokens * r.input +
      usage.output_tokens * r.output +
      usage.cache_read_input_tokens * r.read +
      usage.cache_creation_input_tokens * write) /
    1e6
  )
}

/** What a ping's transcript line reports. */
export type PingReport = {
  label: string
  isWarm: boolean
  /** Why no reply came, when none did. */
  reason?: string
  cached: number
  context: number
  written: number
  /** The price the usage comes to at list rates. */
  spent: number
  /** How far the session's cost ledger moved; null where the host keeps none. */
  billed: number | null
}

/** The cost part of a line: what the ledger billed, else the estimate, flagged when the ledger did not move. */
const priceText = (spent: number, billed: number | null): string => {
  if (billed === null) return `≈ ${usdText(spent)}`
  if (billed > 0) return `${usdText(billed)} billed`

  return `≈ ${usdText(spent)}, not in the session cost`
}

/** A ping's line in the transcript: ✓ or ✗, what it read and wrote, and what it cost. */
export const pingLine = (p: PingReport): string => {
  const price = priceText(p.spent, p.billed)
  if (p.reason !== undefined) {
    return `✗ ${p.label} · no reply (${p.reason})` + (p.spent > 0 || (p.billed ?? 0) > 0 ? ` · ${price}` : '')
  }
  if (p.isWarm) return `✓ ${p.label} · cache kept warm · read ${kTokens(p.cached)} of ${kTokens(p.context)} · ${price}`

  return `✗ ${p.label} · missed the cache · read ${kTokens(p.cached)} of ${kTokens(p.context)}, wrote ${kTokens(p.written)} · ${price}`
}

/** The mod's net effect: what it spared minus what it spent; null while it has done nothing. */
export const savingsText = (s: GuardStats): string | null => {
  if (s.avoidedUsd === 0 && s.spentUsd === 0) return null
  const net = s.avoidedUsd - s.spentUsd

  return net >= 0 ? `saved ${usdText(net)}` : `net −${usdText(-net)}`
}

export const usdText = (n: number): string => (n === 0 ? '$0' : n < 0.01 ? '<$0.01' : `$${n.toFixed(n < 10 ? 2 : 1)}`)

/** A theme color the band paints its state in. */
export type Tone = 'success' | 'warning' | 'error' | 'subtle' | 'claude'

/** What the band shows: a ring, a title in the state's color, and a quiet line of details. */
export type BandParts = {
  tone: Tone
  title: string
  details: string[]
  /** How much of the TTL is left, 0 to 1; null draws an empty ring. */
  share: number | null
  isSpinning: boolean
}

const present = (...parts: (string | undefined)[]): string[] => parts.filter((part): part is string => Boolean(part))

export const bandParts = (v: GuardView): BandParts => {
  const context = v.context > 0 ? `${kTokens(v.context)} context` : undefined
  const note = v.note || undefined

  if (v.isOff) {
    return { tone: 'subtle', title: 'Cache guard off', details: ['this session only'], share: null, isSpinning: false }
  }
  if (v.isWorking) {
    const tool = v.toolSince !== null ? `tool running ${elapsedText(v.now - v.toolSince)}` : undefined
    return {
      tone: 'claude',
      title: 'Claude is working',
      details: present(context, tool, note ?? 'timer resumes after the reply'),
      share: null,
      isSpinning: true,
    }
  }
  if (v.lastReplyAt === null) {
    return { tone: 'subtle', title: 'Cache guard', details: ['starts after the next reply'], share: null, isSpinning: false }
  }

  const since = `${elapsedText(v.now - v.lastReplyAt)} since reply`
  const resume = v.context > 0 ? `resume ≈ ${usdText(cacheCost(v.model, v.context, v.ttl).cold)} at API price` : undefined
  if (v.warmAt === null) {
    return { tone: 'subtle', title: 'Cache cold', details: present(note, resume, since, context), share: null, isSpinning: false }
  }

  if (v.ttl === null) {
    const hint = v.likelyTtl === '1h' ? 'a subscription usually has 1 hour' : v.likelyTtl === '5m' ? 'an API key has 5 min' : undefined
    return {
      tone: 'warning',
      title: 'Pick the cache TTL',
      details: present("cache-guard can't time anything until it knows", hint, since, context),
      share: null,
      isSpinning: false,
    }
  }

  const ttlMs = TTL_MS[v.ttl]
  const left = v.warmAt + ttlMs - v.now
  if (left <= 0) {
    return { tone: 'error', title: 'Cache expired', details: present(resume, note, since, context), share: 0, isSpinning: false }
  }

  const isBelow = v.mode !== 'watch' && v.context < v.minTokens
  let plan: string | undefined
  if (isBelow) plan = `below ${kTokens(v.minTokens)}, no action`
  else if (v.nextAction === 'ping') plan = `ping ${v.pings + 1}/${pingLimitText(v.maxPings)} in ${clockText(left - v.marginMs)}`
  else if (v.nextAction === 'compact') plan = `compact in ${clockText(left - v.marginMs)}`
  const details = present(`${v.ttl} cache`, plan, note, since, context)

  if (v.nextAction === 'ping' && !isBelow) {
    if (v.maxPings >= UNLIMITED_PINGS) {
      return { tone: 'success', title: 'Kept warm', details, share: left / ttlMs, isSpinning: false }
    }
    // The pings still to come each renew the cache: it lapses a TTL after the last one, sent a margin early.
    const pingsLeft = v.maxPings - v.pings
    const untilLast = left - v.marginMs + (pingsLeft - 1) * (ttlMs - v.marginMs)
    const total = untilLast + ttlMs
    const share = total / (total + v.now - v.lastReplyAt)
    const tone: Tone = share < 0.25 ? 'warning' : 'success'

    return { tone, title: `${clockText(total)} left`, details, share, isSpinning: false }
  }

  const share = left / ttlMs
  const tone: Tone = left < MINUTE ? 'error' : share < 0.25 ? 'warning' : 'success'

  return { tone, title: `${clockText(left)} left`, details, share, isSpinning: false }
}

/** The band as one line of text, for `/cache-guard` and a reader without color. */
export const line = (v: GuardView): string => {
  const p = bandParts(v)
  return [p.title, ...p.details].join(' · ')
}

/** The stats as one line. */
export const statsLine = (s: GuardStats): string =>
  `${s.compactions} compactions (−${kTokens(s.tokensBefore - s.tokensAfter)} context) · ` +
  `${s.pings} pings (${s.pingMisses} missed the cache) · ${s.saves} lapses avoided · ` +
  `${usdText(s.avoidedUsd)} spared − ${usdText(s.spentUsd)} spent = ${savingsText(s) ?? 'nothing yet'}`

const TONE_HEX: Record<Tone, string> = {
  success: '#3fb950',
  warning: '#d29922',
  error: '#f85149',
  subtle: '#8b949e',
  claude: '#d97757',
}

const RING_STEPS = 40

/** A small progress ring: the share of the TTL left, or a spinner while Claude works. */
export const ringSvg = (p: BandParts): string => {
  const color = TONE_HEX[p.tone]
  const length = 2 * Math.PI * 7
  const track = `<circle cx="9" cy="9" r="7" fill="none" stroke="${color}" stroke-opacity="0.22" stroke-width="2.5"/>`
  let arc = ''
  if (p.isSpinning) {
    arc =
      `<circle cx="9" cy="9" r="7" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" ` +
      `stroke-dasharray="${(length * 0.28).toFixed(2)} ${length.toFixed(2)}">` +
      '<animateTransform attributeName="transform" type="rotate" from="0 9 9" to="360 9 9" dur="0.9s" repeatCount="indefinite"/>' +
      '</circle>'
  } else if (p.share !== null && p.share > 0) {
    // Stepped, so the image changes now and then rather than every second.
    const shown = Math.max(1, Math.round(p.share * RING_STEPS)) / RING_STEPS
    arc =
      `<circle cx="9" cy="9" r="7" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" ` +
      `stroke-dasharray="${(length * shown).toFixed(2)} ${length.toFixed(2)}" transform="rotate(-90 9 9)"/>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">${track}${arc}</svg>`
}
