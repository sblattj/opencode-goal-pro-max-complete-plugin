#!/usr/bin/env node
// The package bin: the easy installer.
//
//   npx -y github:sblattj/opencode-goal-pro-max-complete-plugin install
//   node scripts/cli.mjs install            (from a clone)
//   sh install.sh                           (bootstrap for people without npx)
//
// It is a thin wrapper: every decision lives in scripts/install.mjs, which is
// unit-tested in test/install.test.js. It makes no model call and no network
// call of its own.
//
// Exit codes:
//   0  success (including "already installed", which writes nothing)
//   1  the command failed
//   2  usage error (unknown subcommand or flag)
//   3  refused on purpose — an unusable destination path, or a config file
//      this installer will not rewrite blind
import { readFile } from "node:fs/promises"

import { InstallError, runInstall, runStatus, runUninstall } from "./install.mjs"

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))

const USAGE = `${manifest.name} ${manifest.version}

Usage:
  npx -y github:sblattj/${manifest.name} install [options]
  ${manifest.name} <install|uninstall|status|verify|help> [options]

Commands:
  install      Wire both halves of the plugin into OpenCode's global config and
               install the shipped skill. Idempotent: a second run writes nothing.
  uninstall    Remove this installer's config entries, its plugin copy and its
               skill. Never deletes a directory it did not create.
  status       Print where everything is and whether both halves are wired.
  verify       Run the shipped installation verifier (no model call).
  help         Print this text.

Options:
  --dry-run          Print every path and entry that would change; write nothing.
  --skill-only       Install only the skill; touch no config and copy no files.
  --no-skill         Install the plugin without the skill.
  --no-backup        Do not snapshot a config file before editing it.
  --config-dir DIR   Override OpenCode's global config directory.
  --data-dir DIR     Override where the plugin copy is written.
  --json             Print a machine-readable summary instead of the report.
  --version          Print the package version.

Exit codes: 0 ok, 1 failed, 2 usage error, 3 refused (unusable path or config).
`

const FLAGS_WITH_VALUES = new Set(["--config-dir", "--data-dir"])
const BOOLEAN_FLAGS = new Set(["--dry-run", "--skill-only", "--no-skill", "--no-backup", "--json"])

function parseArgs(argv) {
  const options = { command: null, dryRun: false, skillOnly: false, skill: true, backup: true, json: false }
  const rest = [...argv]
  while (rest.length > 0) {
    const arg = rest.shift()
    if (arg === "--help" || arg === "-h") return { ...options, command: "help" }
    if (arg === "--version" || arg === "-v") return { ...options, command: "version" }
    if (FLAGS_WITH_VALUES.has(arg) || FLAGS_WITH_VALUES.has(arg.split("=")[0])) {
      const [name, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null]
      const value = inline ?? rest.shift()
      if (!value) return { ...options, error: `${name} needs a directory` }
      // `install --data-dir --dry-run` used to install for real into a directory
      // named "--dry-run". A value that looks like a flag is a typo, not a path;
      // the `=` form stays literal for the one person who really has such a
      // directory.
      if (inline === null && value.startsWith("-")) {
        return {
          ...options,
          error: `${name} needs a directory, but the next argument is ${value}; write ${name}=${value} if that really is one`,
        }
      }
      if (name === "--config-dir") options.configDir = value
      if (name === "--data-dir") options.dataDir = value
      continue
    }
    if (BOOLEAN_FLAGS.has(arg)) {
      if (arg === "--dry-run") options.dryRun = true
      if (arg === "--skill-only") options.skillOnly = true
      if (arg === "--no-skill") options.skill = false
      if (arg === "--no-backup") options.backup = false
      if (arg === "--json") options.json = true
      continue
    }
    if (arg.startsWith("-")) return { ...options, error: `unknown option ${arg}` }
    if (options.command === null) {
      options.command = arg
      continue
    }
    return { ...options, error: `unexpected argument ${arg}` }
  }
  if (options.command === null) options.command = "help"
  return options
}

function report(result) {
  const lines = []
  const prefix = result.dryRun ? "would " : ""
  for (const action of result.actions) {
    const detail = action.detail ? ` (${action.detail})` : ""
    const created = action.created ? " [created]" : ""
    lines.push(`${`${action.label}:`.padEnd(16)}${prefix}${action.path}${created}${detail}`)
  }
  for (const warning of result.warnings) lines.push(`Warning:        ${warning}`)
  if (result.command === "install") {
    if (result.alreadyInstalled) lines.push(`Already installed (${result.version}); nothing was written.`)
    else if (result.dryRun) lines.push("Dry run: nothing was written.")
    else lines.push("Restart opencode to load it.")
  }
  if (result.command === "uninstall") {
    if (!result.changed) lines.push("Nothing to remove.")
    else if (result.dryRun) lines.push("Dry run: nothing was written.")
    else lines.push("Restart opencode to unload it.")
  }
  return lines.join("\n")
}

function statusReport(result) {
  const lines = [
    `Package:        ${result.packageName} ${result.version}`,
    `Config dir:     ${result.configDir}`,
    `Server config:  ${result.serverConfigFile ?? "(none yet)"}`,
    `TUI config:     ${result.tuiConfigFile ?? "(none yet)"}`,
    `Plugin copy:    ${result.dataDir}${result.installedVersion ? ` (${result.installedVersion})` : " (absent)"}`,
    `Expected entry: ${result.spec}`,
    `Skill:          ${result.skill.file} ${result.skill.present ? (result.skill.current ? "(current)" : "(differs from the shipped copy)") : "(absent)"}`,
    `Server half:    ${result.serverWired ? "wired" : "NOT wired"}`,
    `TUI half:       ${result.tuiWired ? "wired" : "NOT wired"}`,
  ]
  for (const file of result.files) {
    const where = file.loaded ? "loaded" : "ignored by opencode's merge"
    lines.push(`${file.file} (${file.kind}, ${where}):`)
    if (file.error) lines.push(`  unreadable: ${file.error}`)
    if (file.entries.length === 0) lines.push("  no plugin entries")
    for (const entry of file.entries) {
      const tag = entry.ours ? " <- this install" : entry.related ? " <- another goal-plugin build" : ""
      lines.push(`  ${entry.spec}${tag}`)
    }
  }
  if (result.installedVersion && result.installedVersion !== result.version) {
    lines.push(`Update available: the copy is ${result.installedVersion}, this package is ${result.version}.`)
  }
  return lines.join("\n")
}

async function main(argv) {
  const options = parseArgs(argv)
  if (options.error) {
    process.stderr.write(`${options.error}\n\n${USAGE}`)
    return 2
  }
  if (options.command === "help") {
    process.stdout.write(USAGE)
    return 0
  }
  if (options.command === "version") {
    process.stdout.write(`${manifest.version}\n`)
    return 0
  }
  if (options.command === "verify") {
    // Delegated so `npm run verify`, `npx <pkg> verify` and the packaging
    // contracts all run the exact same file. It exits non-zero itself on a
    // failed check.
    await import("./verify.mjs")
    return 0
  }
  const runners = { install: runInstall, uninstall: runUninstall, status: runStatus }
  const runner = runners[options.command]
  if (!runner) {
    process.stderr.write(`unknown command ${options.command}\n\n${USAGE}`)
    return 2
  }
  try {
    const result = await runner(options)
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    else process.stdout.write(`${options.command === "status" ? statusReport(result) : report(result)}\n`)
    return 0
  } catch (error) {
    if (error instanceof InstallError) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, code: error.code, error: error.message, hint: error.hint }, null, 2)}\n`)
      } else {
        process.stderr.write(`${error.message}\n`)
        if (error.hint) process.stderr.write(`${error.hint}\n`)
      }
      return error.code === "unusable-path" || error.code === "unreadable-config" ? 3 : 1
    }
    process.stderr.write(`${error.stack ?? error.message}\n`)
    return 1
  }
}

process.exitCode = await main(process.argv.slice(2))
