export type GuardMode = 'watch' | 'ping' | 'compact' | 'ping+compact'
export type GuardTtl = 'auto' | '5m' | '1h'
export type Ttl = '5m' | '1h'
export type GuardProfile = 'code' | 'debug' | 'plan'

/** What the mod has done, kept across sessions. */
export type GuardStats = {
  compactions: number
  tokensBefore: number
  tokensAfter: number
  pings: number
  pingMisses: number
  /** Re-caching the mod spared, in US dollars at list price: credited only once a reply found the cache it kept. */
  avoidedUsd: number
  /** What the mod's own pings and compactions cost, in US dollars at list price. */
  spentUsd: number
  /** Replies that found a cache the mod kept warm or made small. */
  saves: number
}

/** What the band above the prompt draws, refreshed every second while the session waits. */
export type GuardView = {
  /** Clock time the last answer ended; null before the first one. */
  lastReplyAt: number | null
  /** Clock time the cache was last touched; null while nothing warm is guarded. */
  warmAt: number | null
  /** Clock time of the last refresh. */
  now: number
  isWorking: boolean
  context: number
  /** The TTL in force: the option, or the learned one under `auto`; null while unknown. */
  ttl: Ttl | null
  mode: GuardMode
  ttlOption: GuardTtl
  /** Which instructions a compaction is given. */
  profile: GuardProfile
  minTokens: number
  marginMs: number
  /** Pings allowed in one pause before `ping+compact` compacts (`ping` stops there). */
  maxPings: number
  /** Pings made in this pause. */
  pings: number
  stats: GuardStats
  /** The same stats for this session alone. */
  session: GuardStats
  /** Clock time the main loop's running tool started; null while none runs. */
  toolSince: number | null
  /** Whether the cache is kept warm while a long tool runs. */
  toolPings: boolean
  /** Whether a system notification comes shortly before the cache lapses or is compacted. */
  notify: boolean
  /** How long before that the notification comes. */
  notifyMs: number
  /** The TTL learned for this session under `auto`, and how: measured, configured, reported or from a pause. */
  learnedTtl: Ttl | null
  ttlSource: string | null
  /** The TTL this session most likely has, as a hint while it is unknown. */
  likelyTtl: Ttl | null
  /** The main loop's model as the last reply named it; prices the cache. */
  model: string | null
  /** Turned off for this session from the band or the settings panel. */
  isOff: boolean
  /** What the mod does when the countdown reaches the margin. */
  nextAction: 'ping' | 'compact' | null
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    'cache-guard': { view: GuardView }
  }
}
