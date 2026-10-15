# cache-guard

A Claude Code mod that watches the prompt cache. It counts down to the cache's expiry. Just before the cache lapses, it either keeps the cache warm with a tiny ping or compacts the conversation. Either way, a long context is not written to the cache again at full price after you step away for a coffee.

![The cache-guard band above the prompt](docs/band.png)

## Why

Claude Code caches the conversation on Anthropic's side, and each reply on a warm cache pays a fraction of the price. The cache lives **5 minutes** (API key, Bedrock, Vertex, Foundry) or **1 hour** (a Claude subscription within its usage limits). After it expires, the next message pays to write the **whole context** to the cache again.

| Opus 5.5, list price | 100k context | 250k context |
| --- | --- | --- |
| Next reply on a warm cache (cache read) | $0.02 | $0.05 |
| Next reply after a 5-minute cache expired (cache write) | $0.50 | $1.25 |
| Next reply after a 1-hour cache expired (cache write) | $0.80 | $2.00 |

A ping costs about as much as a cache read, so one well-timed ping is around 25× cheaper than a lapse. A compaction just before the lapse means the next message re-writes a short summary instead of the whole context.

## Install

You need Claude Code with mod (hooks module) support. cache-guard is built and tested on **Claude Code 2.1.295**, and older versions refuse the module.

Run this at the prompt of a Claude Code session in a terminal:

```
/plugin install cache-guard --marketplace kamilbakierzynski/cache-guard
```

1. Answer `y` to add the marketplace.
2. Pick a scope. **User** makes it work in every project.
3. Set the options, or keep the defaults (all of them can be changed later).

The mod is active at once, with no restart.

The same from a shell:

```bash
claude plugin marketplace add kamilbakierzynski/cache-guard
```

```bash
claude plugin install cache-guard@cache-guard
```

**Claude desktop app:** `/plugin` is not available in the desktop app's Code tab. Install it once from a terminal at the user scope, and it loads in the desktop app's local sessions too. There the band draws a progress ring instead of the terminal's dot.

**Update** to the latest commit:

```bash
claude plugin update cache-guard
```

Then run `/reload-plugins` in an open session.

**Uninstall:**

```bash
claude plugin uninstall cache-guard
```

## What you see

### The band above the prompt

- **Title.** It shows how long the cache stays warm.
  - With pings planned, it counts down to the end of the last one: `28 min left` with 5 pings on a 5-minute cache.
  - With unlimited pings it reads **Kept warm**.
- **Colour.** Green while there is time, yellow under a quarter of it, red in the last minute.
- **Savings.** Shown beside the title: `saved $3.39 this session · saved $12.80 in all`. They turn yellow as `net −$0.04` when the mod has spent more than it spared so far.
- **Details line.** The cache's TTL, the next action (`ping 1/5 in 3:25`, `compact in 4:30`), the last thing the mod did, the time since the reply, and the context size.
- **While Claude works.** The band reads `Claude is working`. During a long tool it adds `tool running 6:12` and the tool-wait pings.
- **After expiry.** `Cache expired · resume ≈ $1.25 at API price` tells you what your next message will cost to re-cache.
- **Buttons.**
  - **Watch / Ping / Compact / Ping → Compact** switch the mode.
  - **Profile** cycles the compaction prompt (Code → Debug → Plan).
  - **⚙ Settings** opens the panel.
  - **Off** turns the mod off for this session.
- **Unknown TTL.** The band asks **Pick the cache TTL** and offers `TTL 5 min` / `TTL 1 hour` until it learns the TTL. It highlights the likely one: a subscription (usage limits reported) usually has 1 hour, an API key 5 minutes.

### Lines in the conversation

Everything the mod does leaves a dim line in the transcript, with ✓ or ✗:

```
✓ Ping 1/5 · cache kept warm · read 249k of 249k · $0.06 billed
✗ Ping 2/5 · missed the cache · read 2k of 249k, wrote 247k · $1.24 billed
✓ Ping 1 during a tool · cache kept warm · read 249k of 249k · $0.06 billed
✓ Compacted 249k → 15k before the cache expired · ≈ $0.06
✓ Reply read 249k from the cache the ping kept · spared $1.20 of re-caching
✓ Reply wrote 15k instead of 249k · spared $1.17 of re-caching
✗ Reply re-wrote 249k · the ping did not keep the cache warm (read 0k)
```

A line's cost comes from the session's cost ledger when it moved (`billed`), otherwise from the price list (`≈`). Pings never appear as messages: they are forks of the conversation that the model answers on the side.

### The settings panel

Open it with **⚙ Settings** on the band or with the `/cache-guard` command. The command also prints a report: the current state, the price at your model, and the stats.

- **Session.** Turn the mod off (or back on) for this session only. While off, the band is hidden and nothing is pinged or compacted.
- **Mode, cache TTL, keep warm during long tools.**
- **Pings before compact.** 0–10, then ∞. At ∞ the panel says what an idle hour of pinging costs at your context and after how long that exceeds one re-cache.
- **Act before expiry.** 10–180 s.
- **Minimum context.** 10k–500k.
- **Compaction.** Pick the instruction profile and **edit its prompt in place**: type, then Enter to save. **Restore default** or an empty field brings back the default text. Edits are kept across sessions.
- **Cost.** The price of your next reply on a warm and on an expired cache, at your model's list price.
- **Savings.** This session and all sessions: lapses avoided, re-caching spared, money spent on pings and compactions, and the net.
- **Reset to the options' defaults.**

Changes made on the band or in the panel are remembered across sessions. The plugin's options (below) are the defaults they reset to.

## Modes

| Mode | Just before the cache expires |
| --- | --- |
| **Watch** | Nothing. Only the countdown, the cost of resuming, and the TTL learning. |
| **Ping** | Sends a tiny forked request (`Reply with exactly: ok`) that reads the whole cached context and so renews it, up to *Pings before compact* times per pause, then lets the cache lapse. |
| **Compact** (default) | Compacts the conversation with the selected profile's prompt, so your next message re-writes a short summary instead of the whole context. |
| **Ping → Compact** | Pings first, and compacts after the last ping or when a ping misses the cache. With ∞ pings it never compacts. |

The mod acts only when the context is at least *Minimum context*, the TTL is known, and Claude is not working. A new message from you cancels the plan, and the countdown starts again after the reply.

### Keeping the cache warm during long tools

A tool that runs past the cache's lifetime makes the next request re-write the context too. Examples are a test suite, a build, or a slow MCP call. With *Keep warm during long tools* on (the default; never in Watch), the mod pings while a tool in the main conversation is running. It stops pinging once more pings would cost more than the one re-cache they save.

## Options

Set at install, or later with `claude plugin configure cache-guard`.

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `compact` | `watch`, `ping`, `compact` or `ping+compact` |
| `ttl` | `auto` | `auto` learns the session's TTL and only counts down until it does; `5m` or `1h` set it by hand |
| `maxPings` | `2` | Keep-alive pings in one pause; `11` or more means unlimited |
| `marginSeconds` | `30` | How long before expiry the ping or compaction runs |
| `minTokens` | `50000` | Below this context size the mod only watches |
| `toolPings` | `true` | Keep the cache warm while a long tool runs |
| `profile` | `code` | Which compaction prompt is used: `code`, `debug` or `plan` |
| `instructionsCode` | see below | Prompt of the `code` profile |
| `instructionsDebug` | see below | Prompt of the `debug` profile |
| `instructionsPlan` | see below | Prompt of the `plan` profile |

### Compaction profiles

The prompt is added to Claude Code's own summary prompt. It is short on purpose, because every item asked for lengthens the summary that each later request sends. CLAUDE.md, the plan, skills and recently read files are re-attached after a compaction anyway, so the prompts leave them out.

- **code:** keep the user's corrections and preferences verbatim; decisions and why; approaches ruled out; exact paths, symbols, commands, failing tests and error text; uncommitted or unverified changes; todo state; the exact next step. Drop tool output, code already on disk and resolved debugging.
- **debug:** the symptom and exact repro; the current hypothesis and its evidence; hypotheses ruled out and why; exact errors and `file:line`; temporary instrumentation to revert.
- **plan:** the goal, constraints and preferences verbatim; options chosen and rejected, with reasons; open questions; the agreed steps and their status. No code, paths only.

Claude Code's own automatic compaction does not receive these prompts. To steer it too, add a `# Compact instructions` section to your `CLAUDE.md`.

## How it works

- **TTL.** The mod reads the session's cache TTL from Claude Code where the engine reports it: before a compaction or a model switch. Otherwise it learns the TTL from the first request after a pause of 5–60 minutes, or after a tool that ran that long without pings.
  - If that request had to write most of the context again, the TTL is 5 minutes.
  - If it read the context from the cache, the TTL is 1 hour.
- **Timing.** The cache lives from the **start** of the last request, not the end of the reply, so the countdown starts there too. A ping renews the cache from the ping's own start.
- **Ping.** `$.model.fork` resends the conversation's last request with one question after it. It counts as warm only when the API reports at least 70% of the context read from the cache.
- **Prices.** Prices are the list prices of Claude Code 2.1.295's model catalog, per model, for cache write (5 min and 1 hour), cache read, input and output. An unrecognised model is priced at the $5/M input tier. On a subscription you pay in usage limits rather than dollars, but the ratios are the same.
- **Savings.** Savings are counted conservatively.
  - Every ping and compaction is counted as **spent** when it happens.
  - The re-caching it avoided is **credited** only when your next request actually found the cache the ping kept, or wrote the smaller compacted context.
  - A ping before you came back too late stays a pure cost.

### Your cache TTL (as of Claude Code 2.1.295)

- **1 hour:** the main conversation on a Claude subscription within its usage limits.
- **5 minutes:** API keys, Bedrock, Vertex and Foundry; a subscription past its limits; and all subagents.
- **Forcing 1 hour:** set `"promptCacheTtl": "1h"` in settings, or the environment variable `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`. Each cache write then costs 2× the input price instead of 1.25×.

On a 1-hour cache cache-guard has much less to do, but it still helps with longer breaks.

## Development

```bash
git clone https://github.com/kamilbakierzynski/cache-guard
```

```bash
claude --plugin-dir ./cache-guard
```

With `--plugin-dir` the engine lays the API's types in `.claude-plugin/types/`, and then `tsc -p .` type-checks the mod.

Run the tests:

```bash
claude plugin test ./cache-guard
```

Validate the manifest, the marketplace file and the module:

```bash
claude plugin validate ./cache-guard
```

The repository is its own marketplace (`.claude-plugin/marketplace.json`), listing the mod at its root.

| File | Contents |
| --- | --- |
| `hooks/register.tsx` | The hooks, timers, actions, band and settings panel |
| `hooks/view.ts` | Pure helpers: the band's text, prices, savings, transcript lines |
| `types/index.d.ts` | The mod's state contract |
| `tests/cache-guard.test.ts` | The test suite |

## License

MIT
