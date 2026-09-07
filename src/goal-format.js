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
 * no trailing `.0` (`1h`, `1.5h`, `8h`). One decimal is the whole rounding
 * rule: 481 minutes is 8.016 hours, which rounds to 8.0 and renders `8h`.
 *
 * Elapsed and limit are formatted independently, so a fresh 8-hour goal reads
 * `0m/8h` and the same goal 90 minutes in reads `1.5h/8h`.
 */
export function formatBudgetMinutes(minutes) {
  const parsed = Number(minutes)
  const whole = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0
  if (whole < 60) return `${whole}m`
  const hours = Math.round((whole / 60) * 10) / 10
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`
}

/** The same rendering from a millisecond duration. */
export function formatBudgetDuration(ms) {
  const parsed = Number(ms)
  return formatBudgetMinutes(Number.isFinite(parsed) ? parsed / 60000 : 0)
}
