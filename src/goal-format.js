// Shared budget formatting for both halves of the plugin.
//
// The server half (src/goal-plugin.js) renders the session title, the
// `/goal status` text, and the `metadata.goal` payload; the TUI half
// (src/goal-sidebar-view.js, loaded through src/goal-tui.js) renders the
// sidebar panel from that same payload. The two must never disagree about the
// same number, so every budget string is built here, in a module that imports
// nothing of its own.
//
// The TUI bundle is built with `--packages external`, which externalizes bare
// package specifiers only. A RELATIVE import like the one in
// goal-sidebar-view.js is still inlined, so this file ships inside
// dist/goal-tui.js and needs no runtime resolution by the host.

/** U+221E — the rendered ceiling of an unlimited budget. */
export const UNLIMITED_MARK = "∞"

/** The prose spelling of an unlimited turn budget, for history and log lines. */
export const UNLIMITED_WORD = "unlimited"

/**
 * `maxTurns: 0` is the first-class "unlimited turns" value. It is used instead
 * of `Infinity` because the option round-trips through the persisted JSON
 * state, and `JSON.stringify(Infinity)` is `null` — an unlimited goal reloaded
 * from disk would silently become a default-limited one. `null` is accepted
 * here too because that is what the `metadata.goal` payload carries for a
 * turn budget with no ceiling.
 */
export function isUnlimitedTurnBudget(max) {
  const parsed = Number(max)
  return !(Number.isFinite(parsed) && parsed > 0)
}

/** `10` → `"10"`, unlimited → `"∞"`. */
export function formatTurnLimit(max) {
  return isUnlimitedTurnBudget(max) ? UNLIMITED_MARK : String(Math.floor(Number(max)))
}

/** `3/10`, or `3/∞` when the turn budget is unlimited. */
export function formatTurnBudget(used, max) {
  const parsed = Number(used)
  const count = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
  return `${count}/${formatTurnLimit(max)}`
}

/**
 * Render a minute count as a budget field. Minutes up to an hour stay minutes
 * (`0m`, `45m`); an hour or more switches to hours with a single decimal and
 * no trailing `.0` (`1h`, `1.5h`, `8h`).
 *
 * Every value is TRUNCATED toward zero, never rounded up. Rounding made the
 * elapsed clock reach the limit's own rendering early — an 8-hour goal read
 * `8h/8h` from 7h57m, three minutes before it could stop — and made a limit
 * name a budget the goal does not have. Truncated, 477 minutes is `7.9h`, 480
 * is `8h`, and 481 (8.016 h) is `8h` too.
 *
 * Elapsed and limit are formatted independently, so a fresh 8-hour goal reads
 * `0s/8h` and the same goal 90 minutes in reads `1.5h/8h`.
 */
export function formatBudgetMinutes(minutes) {
  const parsed = Number(minutes)
  const whole = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
  if (whole < 60) return `${whole}m`
  // Tenths of an hour, truncated. The multiply happens before the divide so
  // the tenth is computed from an integer rather than from `whole / 60`.
  const hours = Math.floor((whole * 10) / 60) / 10
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`
}

/**
 * The same rendering from a millisecond duration, plus one granularity the
 * minute scale cannot express: a duration under a minute renders in whole
 * seconds (`0s`, `20s`, `59s`). Without it a `--max-duration-ms 20000` goal
 * reported its limit as `0m` and stopped with `max duration reached (0m)`,
 * and the session title of a 45-second-old goal read `0m` rather than `45s`.
 */
export function formatBudgetDuration(ms) {
  const parsed = Number(ms)
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  if (value < 60000) return `${Math.floor(value / 1000)}s`
  return formatBudgetMinutes(value / 60000)
}
