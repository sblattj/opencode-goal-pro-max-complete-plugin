// The easy installer: everything `scripts/cli.mjs` does, as importable
// functions with no side effects at import time.
//
// It writes BOTH halves of the OpenCode configuration and installs the shipped
// skill, idempotently. It makes no model call and no network call of its own.
//
// Every rule below is pinned to opencode 1.18.29 (source at
// 16747470f976aca3d362ad730bcd3fe82ecc2c9a). Line numbers are points, valid at
// that commit; each names the symbol it lives in so it re-resolves after a move.
//
//   * The global config directory is `$XDG_CONFIG_HOME/opencode`, or
//     `OPENCODE_CONFIG_DIR` when set — packages/core/src/global.ts:64 (`Global.make`),
//     path built at packages/core/src/global.ts:13 (`config`).
//   * The global config FILE is the first existing of `opencode.jsonc`,
//     `opencode.json`, `config.json` — packages/opencode/src/config/config.ts:141
//     (`globalConfigFile`). That order matters: the three files are merged with
//     remeda's `mergeDeep` (packages/opencode/src/config/config.ts:43,
//     `mergeConfig`), which REPLACES arrays, and `opencode.jsonc` is merged LAST
//     (packages/opencode/src/config/config.ts:274, `loadGlobal`). Only
//     `instructions` is concatenated (config.ts:46, `mergeConfigConcatArrays`).
//     So a `plugin` entry written into the file that loses is silently discarded.
//   * TUI plugins are read from `tui.json` / `tui.jsonc` ONLY, never from
//     `opencode.json` — packages/opencode/src/config/tui.ts:184 (`loadState`).
//     Their `plugin` arrays UNION across files rather than replacing
//     (packages/opencode/src/config/tui.ts:166), so either spelling is safe;
//     `$schema` is an accepted key there (packages/tui/src/config/index.tsx:62).
//   * A `file://` spec dedupes on the EXACT string — packages/opencode/src/config/plugin.ts:70
//     (`deduplicatePluginOrigins`). Two spellings of one directory are two
//     plugins with one id, and a duplicate TUI id is rejected outright
//     (packages/opencode/src/plugin/tui/runtime.ts:655). So always emit
//     `pathToFileURL(dir).href`, with no trailing slash, and never append beside
//     an existing goal-plugin entry.
//   * A `file://` directory plugin needs `package.json` plus the files its
//     `exports` name, resolved inside the directory — packages/opencode/src/plugin/shared.ts:184
//     (`resolvePathPluginTarget`), packages/opencode/src/plugin/shared.ts:93
//     (`resolvePackageFile`). `dist/` + `package.json` is complete: the bundles
//     inline every dependency and the TUI's externals are host-supplied.
//   * Skills are scanned as `{skill,skills}/**/SKILL.md` under every config
//     directory — packages/opencode/src/skill/index.ts:24 (`OPENCODE_SKILL_PATTERN`),
//     scanned at packages/opencode/src/skill/index.ts:207 (`state`).
//
// A ':' or '#' anywhere in the plugin directory is fatal to the TUI half — bun
// splits a module path at the first colon into `namespace:path`, so opentui's
// host-module `onLoad` shim never fires, and opentui's own `sourcePath()`
// truncates a path at the first '#' (@opentui/core@0.4.5 runtime-plugin.js:76,
// used at :330). The installer refuses such a destination rather than shipping a
// half-dead install whose server half looks fine in `opencode debug config`.
// The one exemption is a Windows drive root (`C:\…`), which every absolute
// Windows path carries: refusing it would leave no installable destination at
// all, so it warns instead — see `unusablePathCharacter`. That exemption is
// unverified rather than measured; no Windows TUI run has been recorded.

import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const PACKAGE_DIRECTORY = path.resolve(fileURLToPath(new URL("..", import.meta.url)))

// The ownership marker. Nothing outside the data directory is ever removed
// without this file naming this package.
export const MARKER_FILE = ".opencode-goal-pro-max-complete-plugin-installer.json"

export const CONFIG_SCHEMA = "https://opencode.ai/config.json"
export const TUI_SCHEMA = "https://opencode.ai/tui.json"

// config.ts:141 (`globalConfigFile`) — first existing wins, else the first name.
export const SERVER_CONFIG_CANDIDATES = ["opencode.jsonc", "opencode.json", "config.json"]
// paths.ts:44 (`fileInDirectory`) — `[tui.json, tui.jsonc]`.
export const TUI_CONFIG_CANDIDATES = ["tui.json", "tui.jsonc"]

export const SKILL_NAME = "using-the-goal-plugin"
// The singular spelling; both are scanned (skill/index.ts:24).
export const SKILL_INSTALL_SEGMENTS = ["skill", SKILL_NAME, "SKILL.md"]
export const SKILL_SOURCE_SEGMENTS = ["skills", SKILL_NAME, "SKILL.md"]

// What lands in the data directory. The first three are what the loader needs;
// the rest are for humans, editors and typecheckers resolving the copy.
export const REQUIRED_PLUGIN_FILES = ["package.json", "dist/goal-plugin.js", "dist/goal-tui.js"]
export const OPTIONAL_PLUGIN_FILES = ["index.d.ts", "tui.d.ts", "LICENSE", "README.md"]

// Any spec that could be another build of THIS plugin. The wire id is still the
// historical `opencode-goal-plugin` in both halves, and a duplicate TUI id is
// rejected (plugin/tui/runtime.ts:655), so a second entry does not add a plugin
// — it breaks the one that is already there.
const RELATED_SPEC_PATTERN = /goal-plugin|goal-pro-max/i

export class InstallError extends Error {
  constructor(message, { code = "install-failed", hint } = {}) {
    super(message)
    this.name = "InstallError"
    this.code = code
    this.hint = hint
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

async function readFileOrNull(file) {
  try {
    return await readFile(file)
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") return null
    throw error
  }
}

async function exists(file) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

// A filesystem refusal is a normal outcome of installing into somebody's home
// directory — a read-only config file, a directory sitting where a file belongs,
// a full disk. Each one gets a sentence and a hint instead of a Node stack trace.
const WRITE_ERROR_HINTS = {
  EACCES: "Check the permissions on that path and the directory holding it, then re-run.",
  EPERM: "Check the permissions on that path and the directory holding it, then re-run.",
  EROFS: "That path is on a read-only filesystem. Pass --config-dir or --data-dir to write somewhere else.",
  EISDIR: "A directory is sitting where that file belongs. Move or remove it, then re-run.",
  ENOTDIR: "A path component is a file, not a directory. Move or remove it, then re-run.",
  ENOSPC: "The disk is full.",
  EMFILE: "Too many open files. Close something, or raise the limit with `ulimit -n`, then re-run.",
  ENAMETOOLONG: "That path is too long for this filesystem. Pass a shorter --config-dir or --data-dir.",
}

function asWriteError(error, file) {
  const hint = WRITE_ERROR_HINTS[error?.code]
  if (!hint) return error
  return new InstallError(`cannot write ${file} (${error.code})`, { code: "write-failed", hint })
}

async function writeFileSafely(file, data) {
  try {
    await writeFile(file, data)
  } catch (error) {
    throw asWriteError(error, file)
  }
}

async function mkdirSafely(directory) {
  try {
    await mkdir(directory, { recursive: true })
  } catch (error) {
    throw asWriteError(error, directory)
  }
}

// ---------------------------------------------------------------------------
// JSONC: read anything OpenCode can read, write back with a surgical edit.
//
// `jsonc-parser` is not a dependency and adding one would make `npx -y
// github:…` do a network install, so comments are preserved by editing the raw
// text at byte offsets instead of round-tripping through JSON.stringify. Every
// helper below preserves offsets, so an offset found in the blanked text is the
// same offset in the original.
// ---------------------------------------------------------------------------

/** Replace comments with spaces, keeping every offset and every newline. */
export function blankJsoncComments(text) {
  let out = ""
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      const end = skipString(text, i)
      out += text.slice(i, end)
      i = end
      continue
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " "
        i += 1
      }
      continue
    }
    if (ch === "/" && text[i + 1] === "*") {
      out += "  "
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " "
        i += 1
      }
      if (i < text.length) {
        out += "  "
        i += 2
      }
      continue
    }
    out += ch
    i += 1
  }
  return out
}

function skipString(text, i) {
  let j = i + 1
  while (j < text.length) {
    if (text[j] === "\\") {
      j += 2
      continue
    }
    if (text[j] === '"') return j + 1
    j += 1
  }
  return j
}

function skipWhitespace(text, i) {
  while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i += 1
  return i
}

function skipValue(text, i) {
  const ch = text[i]
  if (ch === '"') return skipString(text, i)
  if (ch === "{" || ch === "[") {
    let depth = 0
    let j = i
    while (j < text.length) {
      const c = text[j]
      if (c === '"') {
        j = skipString(text, j)
        continue
      }
      if (c === "{" || c === "[") depth += 1
      else if (c === "}" || c === "]") {
        depth -= 1
        if (depth === 0) return j + 1
      }
      j += 1
    }
    return j
  }
  let j = i
  while (j < text.length && !",}] \t\r\n".includes(text[j])) j += 1
  return j
}

/** Blank trailing commas (allowed by ConfigParse.jsonc, parse.ts:10) without touching string contents. */
export function blankTrailingCommas(text) {
  const chars = text.split("")
  let i = 0
  while (i < chars.length) {
    if (chars[i] === '"') {
      i = skipString(text, i)
      continue
    }
    if (chars[i] === "}" || chars[i] === "]") {
      let back = i - 1
      while (back >= 0 && " \t\r\n".includes(chars[back])) back -= 1
      if (back >= 0 && chars[back] === ",") chars[back] = " "
    }
    i += 1
  }
  return chars.join("")
}

/** Parse JSONC the way OpenCode does (comments + trailing commas). Throws on garbage. */
export function parseJsonc(text) {
  const blanked = blankTrailingCommas(blankJsoncComments(text))
  return JSON.parse(blanked.trim() === "" ? "{}" : blanked)
}

/**
 * Locate the top-level `plugin` array in a JSONC document.
 * Returns `{ ok, rootStart, key, array }`, where `array` carries the `[`/`]`
 * offsets and one span per element, all valid against the ORIGINAL text.
 */
export function locatePluginArray(text) {
  const blanked = blankTrailingCommas(blankJsoncComments(text))
  let i = skipWhitespace(blanked, 0)
  if (blanked[i] !== "{") return { ok: false, reason: "the top level is not a JSON object" }
  const rootStart = i
  i += 1
  while (i < blanked.length) {
    i = skipWhitespace(blanked, i)
    if (blanked[i] === "}") break
    if (blanked[i] === ",") {
      i += 1
      continue
    }
    if (blanked[i] !== '"') return { ok: false, reason: "unexpected token where an object key was expected" }
    const keyStart = i
    const keyEnd = skipString(blanked, i)
    let key
    try {
      key = JSON.parse(blanked.slice(keyStart, keyEnd))
    } catch {
      return { ok: false, reason: "unparseable object key" }
    }
    i = skipWhitespace(blanked, keyEnd)
    if (blanked[i] !== ":") return { ok: false, reason: `no value for key ${key}` }
    i = skipWhitespace(blanked, i + 1)
    const valueStart = i
    const valueEnd = skipValue(blanked, i)
    if (key === "plugin") {
      if (blanked[valueStart] !== "[") return { ok: false, reason: '"plugin" is not an array' }
      return {
        ok: true,
        rootStart,
        key: { start: keyStart, end: keyEnd },
        array: {
          start: valueStart,
          end: valueEnd,
          multiline: blanked.slice(valueStart, valueEnd).includes("\n"),
          elements: arrayElements(blanked, valueStart, valueEnd),
        },
      }
    }
    i = valueEnd
  }
  return { ok: true, rootStart, array: null }
}

function arrayElements(blanked, start, end) {
  const items = []
  let i = start + 1
  while (i < end - 1) {
    i = skipWhitespace(blanked, i)
    if (i >= end - 1) break
    if (blanked[i] === ",") {
      i += 1
      continue
    }
    const from = i
    const to = skipValue(blanked, i)
    if (to <= from) break
    items.push({ start: from, end: to })
    i = to
  }
  return items
}

function applyEdits(text, edits) {
  // Deletions are merged before they are applied: removing two adjacent
  // elements produces two ranges that share the comma between them, and
  // applying them independently would drop only one of the two.
  const deletions = edits.filter((edit) => edit.end > edit.start).sort((a, b) => a.start - b.start)
  const merged = []
  for (const edit of deletions) {
    const last = merged[merged.length - 1]
    if (last && edit.start <= last.end) last.end = Math.max(last.end, edit.end)
    else merged.push({ ...edit })
  }
  const inserts = edits.filter((edit) => edit.end === edit.start)
  const all = [...merged, ...inserts].sort((a, b) => b.start - a.start || b.end - a.end)
  let out = text
  for (const edit of all) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }
  return out
}

function indentOf(text, offset) {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1
  const line = text.slice(lineStart, offset)
  const match = /^[ \t]*/.exec(line)
  return match ? match[0] : ""
}

/**
 * Rewrite the `plugin` array: drop the elements at `remove` (indices into
 * `locatePluginArray().array.elements`) and append `add` when it is not already
 * a survivor. Every byte outside the edited spans — comments included — is kept.
 */
export function editPluginArray(text, { remove = [], add = null } = {}) {
  const located = locatePluginArray(text)
  if (!located.ok) throw new InstallError(`cannot edit this config: ${located.reason}`, { code: "unreadable-config" })

  if (!located.array) {
    if (!add) return text
    // No `plugin` key at all: insert one right after the opening brace, at the
    // file's own indentation.
    const insertAt = located.rootStart + 1
    const rest = text.slice(insertAt)
    const hasKeys = /^\s*[}]/.test(rest) === false
    const bodyIndent = detectBodyIndent(text, located.rootStart)
    const entry = `\n${bodyIndent}"plugin": [${JSON.stringify(add)}]${hasKeys ? "," : "\n"}`
    return text.slice(0, insertAt) + entry + rest
  }

  const removeSet = new Set(remove)
  const elements = located.array.elements
  const survivors = elements.filter((_, index) => !removeSet.has(index))
  const edits = []
  // Comments are blanked so a comma inside one is invisible, but trailing commas
  // are NOT: `applyEdits` rewrites the ORIGINAL text, where a trailing comma is
  // still a real byte. Scanning the trailing-comma-blanked text here made the
  // LAST element of a trailing-comma array look like it had no separator, sent
  // it down the backward branch, and merged its deletion with the one before it
  // — leaving an orphan `, ,` that no JSON or JSONC parser accepts.
  const scan = blankJsoncComments(text)

  for (const [index, element] of elements.entries()) {
    if (!removeSet.has(index)) continue
    let start = element.start
    let end = element.end
    // Take the separating comma with the element: forward first, then backward.
    const forward = skipWhitespace(scan, end)
    if (scan[forward] === ",") {
      end = forward + 1
      // …and the run of spaces behind it, so removing the first element of a
      // one-line array does not leave `[ "kept"]`.
      while (end < scan.length && (scan[end] === " " || scan[end] === "\t")) end += 1
    } else {
      let back = start - 1
      while (back > located.array.start && " \t\r\n".includes(scan[back])) back -= 1
      if (scan[back] === ",") start = back
      // The element was last and had no comma of its own: its line is going with
      // it, so take the newline too rather than leaving a blank line behind.
      const tail = text.indexOf("\n", end)
      if (tail !== -1 && scan.slice(end, tail).trim() === "") end = tail + 1
    }
    // When the element had a line to itself, take the whole line — including a
    // trailing comment, which described the entry that is going away. A comment
    // anywhere else is left exactly where the user put it.
    const lineStart = text.lastIndexOf("\n", start - 1) + 1
    const newline = text.indexOf("\n", end)
    const lineEnd = newline === -1 ? text.length : newline + 1
    if (scan.slice(lineStart, start).trim() === "" && scan.slice(end, lineEnd).trim() === "") {
      start = lineStart
      end = lineEnd
    }
    edits.push({ start, end, text: "" })
  }

  if (add) {
    const alreadyThere = survivors.some((element) => rawSpecMatches(text.slice(element.start, element.end), add))
    if (!alreadyThere) {
      if (survivors.length === 0) {
        // Nothing survives: replace the whole array so no orphan whitespace or
        // dangling comma is left behind.
        return applyEdits(text, [
          { start: located.array.start, end: located.array.end, text: `[${JSON.stringify(add)}]` },
        ])
      }
      const last = survivors[survivors.length - 1]
      const insert = located.array.multiline
        ? `,\n${indentOf(text, last.start)}${JSON.stringify(add)}`
        : `, ${JSON.stringify(add)}`
      edits.push({ start: last.end, end: last.end, text: insert })
    }
  }

  return applyEdits(text, edits)
}

function detectBodyIndent(text, rootStart) {
  const after = text.slice(rootStart + 1)
  const match = /\n([ \t]+)\S/.exec(after)
  return match ? match[1] : "  "
}

function rawSpecMatches(raw, spec) {
  try {
    const value = JSON.parse(blankTrailingCommas(blankJsoncComments(raw)))
    return specOf(value) === spec
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Plugin specs
// ---------------------------------------------------------------------------

/** A `plugin` element is either a spec string or a `[spec, options]` tuple (config/plugin.ts:33). */
export function specOf(entry) {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0]
  return null
}

/** The absolute filesystem path a spec names, or null when it names none. */
export function localPathOf(spec, { home = homedir() } = {}) {
  if (typeof spec !== "string") return null
  let raw = null
  if (spec.toLowerCase().startsWith("file://")) raw = decodeURIComponent(spec.slice("file://".length))
  else if (spec.toLowerCase().startsWith("file:")) raw = decodeURIComponent(spec.slice("file:".length))
  else if (spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("~")) raw = spec
  else return null
  if (raw.startsWith("~")) raw = path.join(home, raw.slice(1))
  if (!path.isAbsolute(raw)) return null
  return path.normalize(raw.replace(/\/+$/, "")) || raw
}

export function isRelatedSpec(spec) {
  return typeof spec === "string" && RELATED_SPEC_PATTERN.test(spec)
}

/** The canonical entry for a plugin directory: no trailing slash, exact string (config/plugin.ts:70). */
export function specForDirectory(directory) {
  return pathToFileURL(path.resolve(directory)).href.replace(/\/+$/, "")
}

/**
 * `:` and `#` are fatal to the TUI half. Returns the offending character, or null.
 *
 * On Windows the drive root is exempt. Every absolute Windows path carries a
 * drive colon (`path.win32.resolve(homedir(), pkg)` is always `C:\…`), so
 * checking the whole string refuses every possible destination — there is no
 * colon-free path to point `--data-dir` at, and `install` becomes an
 * unconditional exit 3. Only a colon the user can actually remove is refused.
 * The exemption is a carve-out, not a clean bill of health: no Windows TUI run
 * has been recorded, so `install` warns (see `windowsTuiWarning`).
 */
export function unusablePathCharacter(target, { platform = process.platform } = {}) {
  const body = platform === "win32" ? target.slice(path.win32.parse(target).root.length) : target
  if (body.includes(":")) return ":"
  if (body.includes("#")) return "#"
  return null
}

/** Said on Windows, where the drive colon is exempt but unverified. */
export function windowsTuiWarning(dataDir) {
  return (
    `${dataDir} contains a drive colon, which is unavoidable on Windows and is exempt from the path check — but a ` +
    "colon is exactly what breaks the TUI half's module loader on the hosts this was measured on, and no Windows " +
    "run has been recorded. The server half (the /goal command, the tools, the hooks) and the skill are unaffected. " +
    "If the sidebar panel never appears, that is the reason."
  )
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export function resolveConfigDir({ env = process.env, home = homedir() } = {}) {
  if (env.OPENCODE_CONFIG_DIR) return path.resolve(env.OPENCODE_CONFIG_DIR)
  const base = env.XDG_CONFIG_HOME || path.join(home, ".config")
  return path.resolve(base, "opencode")
}

export function resolveDataDir({ env = process.env, home = homedir(), packageName } = {}) {
  const base = env.XDG_DATA_HOME || path.join(home, ".local", "share")
  return path.resolve(base, packageName)
}

async function firstExisting(directory, candidates) {
  for (const name of candidates) {
    const file = path.join(directory, name)
    if (await exists(file)) return file
  }
  return null
}

// ---------------------------------------------------------------------------
// Reading a config file
// ---------------------------------------------------------------------------

async function readConfig(file) {
  const buffer = await readFileOrNull(file)
  if (buffer === null) return { file, exists: false, text: null, data: {}, entries: [] }
  const text = buffer.toString("utf8")
  // A whitespace-only file has nothing to edit surgically; it is replaced by a
  // fresh document, exactly as a missing one would be.
  if (text.trim() === "") return { file, exists: false, text, data: {}, entries: [] }
  let data
  try {
    data = parseJsonc(text)
  } catch (error) {
    throw new InstallError(`${file} is not valid JSON/JSONC (${error.message})`, {
      code: "unreadable-config",
      hint: "Fix or move that file, then re-run. Nothing was written.",
    })
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new InstallError(`${file} does not contain a JSON object`, { code: "unreadable-config" })
  }
  const list = Array.isArray(data.plugin) ? data.plugin : []
  const entries = list.map((entry, index) => ({ index, entry, spec: specOf(entry) }))
  return { file, exists: true, text, data, entries }
}

function utcStamp(now) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Decide what has to change in one config file.
 *
 * `mode: "install"` keeps exactly one canonical entry for the plugin directory
 * and removes every other entry that could be a rival build of this plugin
 * (they would collide on the wire id). `mode: "uninstall"` removes only the
 * entries that point at OUR directory and leaves everything else alone.
 */
export function planConfigFile(config, { spec, dataDir, mode, isTarget, home }) {
  const remove = []
  const removedSpecs = []
  let keptOurs = false
  for (const entry of config.entries) {
    const raw = entry.spec
    const local = localPathOf(raw, { home })
    const ours = local !== null && local === dataDir
    if (mode === "uninstall") {
      if (ours || raw === spec) {
        remove.push(entry.index)
        removedSpecs.push(raw)
      }
      continue
    }
    if (isTarget && raw === spec && !keptOurs) {
      keptOurs = true
      continue
    }
    if (ours || isRelatedSpec(raw)) {
      remove.push(entry.index)
      removedSpecs.push(raw)
    }
  }
  const add = mode === "install" && isTarget && !keptOurs ? spec : null
  return { file: config.file, remove, removedSpecs, add, changed: remove.length > 0 || add !== null }
}

async function planCopy({ sourceDir, dataDir }) {
  const files = []
  for (const relative of [...REQUIRED_PLUGIN_FILES, ...OPTIONAL_PLUGIN_FILES]) {
    const from = path.join(sourceDir, relative)
    const buffer = await readFileOrNull(from)
    if (buffer === null) {
      if (REQUIRED_PLUGIN_FILES.includes(relative)) {
        throw new InstallError(`the package at ${sourceDir} is missing ${relative}`, {
          code: "broken-source",
          hint: 'Run "npm run bundle" in a checkout, or install from a released tarball.',
        })
      }
      continue
    }
    const to = path.join(dataDir, relative)
    const current = await readFileOrNull(to)
    files.push({
      relative,
      from,
      to,
      sha256: sha256(buffer),
      buffer,
      changed: current === null || !current.equals(buffer),
    })
  }
  return files
}

async function readMarker(dataDir) {
  const buffer = await readFileOrNull(path.join(dataDir, MARKER_FILE))
  if (buffer === null) return null
  try {
    return JSON.parse(buffer.toString("utf8"))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

async function resolveContext(options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const platform = options.platform ?? process.platform
  const sourceDir = path.resolve(options.sourceDir ?? PACKAGE_DIRECTORY)
  const manifestBuffer = await readFileOrNull(path.join(sourceDir, "package.json"))
  if (manifestBuffer === null) {
    throw new InstallError(`no package.json at ${sourceDir}`, { code: "broken-source" })
  }
  const manifest = JSON.parse(manifestBuffer.toString("utf8"))
  const packageName = manifest.name
  const configDir = path.resolve(options.configDir ?? resolveConfigDir({ env, home }))
  const dataDir = path.resolve(options.dataDir ?? resolveDataDir({ env, home, packageName }))
  return {
    env,
    home,
    platform,
    sourceDir,
    manifest,
    packageName,
    version: manifest.version,
    configDir,
    dataDir,
    spec: specForDirectory(dataDir),
    now: options.now ?? new Date(),
    dryRun: Boolean(options.dryRun),
    backup: options.backup !== false,
    skill: options.skill !== false,
    skillOnly: Boolean(options.skillOnly),
  }
}

/**
 * Every rewrite is re-parsed and re-checked BEFORE anything is written: the
 * result must parse the way OpenCode parses it, and its `plugin` array must hold
 * exactly the survivors plus the entry being added. An edit bug is then a
 * refusal that touches nothing, rather than a config file OpenCode can no longer
 * read — which would take the user's model, agents, MCP servers and every other
 * plugin with it.
 */
export function rewritePluginArray(config, plan) {
  const next = editPluginArray(config.text, { remove: plan.remove, add: plan.add })
  if (next === config.text) return null
  const removeSet = new Set(plan.remove)
  const kept = config.entries.filter((entry) => !removeSet.has(entry.index)).map((entry) => entry.entry)
  const expected = plan.add && !kept.some((entry) => specOf(entry) === plan.add) ? [...kept, plan.add] : kept
  const refuse = (detail) =>
    new InstallError(`the edit to ${config.file} did not come out right (${detail}); nothing was written`, {
      code: "unreadable-config",
      hint:
        "This is a bug in this installer, not in your config, and your file is untouched. Please report it with " +
        `the "plugin" array from ${config.file}. The manual two-file install in docs/install.md works meanwhile.`,
    })
  let parsed
  try {
    parsed = parseJsonc(next)
  } catch (error) {
    throw refuse(`the result would not parse back: ${error.message}`)
  }
  const got = Array.isArray(parsed.plugin) ? parsed.plugin : []
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    throw refuse(`the resulting entries are ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`)
  }
  return next
}

async function snapshot(file, text, { stamp, actions, dryRun, backup }) {
  if (!backup) return null
  const target = `${file}.${stamp}.bak`
  actions.push({ kind: "snapshot", label: "Snapshot", path: target })
  if (!dryRun) await writeFileSafely(target, text)
  return dryRun ? null : target
}

/**
 * Write `next` over `file`, removing the snapshot taken just before it when the
 * write fails: a `.bak` of a file that was never edited is litter the user then
 * has to identify and clean up by hand.
 */
async function writeWithSnapshot(file, next, backupFile) {
  try {
    await writeFileSafely(file, next)
  } catch (error) {
    if (backupFile) await rm(backupFile, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * The pure half of a config write: decide the exact bytes, and refuse here if
 * anything is wrong. Nothing on disk has been touched when this returns, which
 * is what lets `runInstall` validate every file before it writes the first one.
 */
function planConfigWrite(config, plan, { schema, label }) {
  if (!plan.changed) return null
  // A file that does not exist is created from scratch, which only makes sense
  // when there is an entry to put in it.
  if (!config.exists) return plan.add ? { config, plan, next: null, schema, label } : null
  const next = rewritePluginArray(config, plan)
  if (next === null) return null
  return { config, plan, next, schema, label }
}

async function applyConfigWrite({ config, plan, next, schema, label }, { actions, dryRun, backup, stamp }) {
  if (config.exists) {
    const backupFile = await snapshot(config.file, config.text, { stamp, actions, dryRun, backup })
    for (const removed of plan.removedSpecs) {
      actions.push({
        kind: "removed-entry",
        label: "Removed",
        path: config.file,
        detail: `superseded plugin entry ${JSON.stringify(removed)}`,
      })
    }
    if (plan.add) actions.push({ kind: "config", label, path: config.file, detail: plan.add })
    if (!dryRun) await writeWithSnapshot(config.file, next, backupFile)
    return true
  }
  const body = `{\n  "$schema": "${schema}",\n  "plugin": [${JSON.stringify(plan.add)}]\n}\n`
  actions.push({ kind: "config", label, path: config.file, detail: plan.add, created: true })
  if (!dryRun) {
    await mkdirSafely(path.dirname(config.file))
    await writeFileSafely(config.file, body)
  }
  return true
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

export async function runInstall(options = {}) {
  const ctx = await resolveContext(options)
  const actions = []
  const warnings = []
  const stamp = utcStamp(ctx.now)

  const skillSource = path.join(ctx.sourceDir, ...SKILL_SOURCE_SEGMENTS)
  const skillTarget = path.join(ctx.configDir, ...SKILL_INSTALL_SEGMENTS)

  let copy = []
  let serverConfigFile = null
  let tuiConfigFile = null

  if (!ctx.skillOnly) {
    const bad = unusablePathCharacter(ctx.dataDir, { platform: ctx.platform })
    if (bad) {
      throw new InstallError(
        `refusing to install into ${ctx.dataDir}: the path contains ${JSON.stringify(bad)}.`,
        {
          code: "unusable-path",
          hint:
            "OpenCode's TUI half cannot load a plugin from a path containing ':' or '#' — bun splits a module " +
            "path at the first colon, and opentui truncates it at the first '#'. The server half would load and " +
            "the sidebar would silently never appear. Set XDG_DATA_HOME (or pass --data-dir) to a path with " +
            "neither character.",
        },
      )
    }
    if (ctx.platform === "win32") warnings.push(windowsTuiWarning(ctx.dataDir))

    copy = await planCopy({ sourceDir: ctx.sourceDir, dataDir: ctx.dataDir })
    const marker = await readMarker(ctx.dataDir)
    const dataDirExists = await exists(ctx.dataDir)
    if (dataDirExists && marker === null && copy.some((file) => file.changed)) {
      warnings.push(
        `${ctx.dataDir} already exists and carries no ${MARKER_FILE} marker; its files are being overwritten but ` +
          "nothing there will ever be deleted by --uninstall.",
      )
    }

    serverConfigFile =
      (await firstExisting(ctx.configDir, SERVER_CONFIG_CANDIDATES)) ??
      path.join(ctx.configDir, SERVER_CONFIG_CANDIDATES[1])
    tuiConfigFile =
      (await firstExisting(ctx.configDir, TUI_CONFIG_CANDIDATES)) ?? path.join(ctx.configDir, TUI_CONFIG_CANDIDATES[0])

    // Every candidate is inspected, not just the winner: an entry left behind in
    // a file that loses the merge is dead weight on the server side and a
    // duplicate-id collision on the TUI side.
    // An unreadable file we must WRITE is fatal; an unreadable one we would
    // only inspect is a warning, because refusing to install over somebody
    // else's broken file helps nobody.
    const readCandidates = async (names, target) => {
      const list = []
      for (const name of names) {
        const file = path.join(ctx.configDir, name)
        try {
          list.push(await readConfig(file))
        } catch (error) {
          if (file === target) throw error
          warnings.push(`${file} could not be parsed; left untouched (${error.message})`)
        }
      }
      return list
    }
    const serverConfigs = await readCandidates(SERVER_CONFIG_CANDIDATES, serverConfigFile)
    const tuiConfigs = await readCandidates(TUI_CONFIG_CANDIDATES, tuiConfigFile)

    // Everything that can refuse runs before anything is written: the unreadable
    // target config above, then every plugin-array rewrite, each one re-parsed
    // and re-checked by `rewritePluginArray`.
    const configWrites = []
    for (const [configs, target, schema, label] of [
      [serverConfigs, serverConfigFile, CONFIG_SCHEMA, "Config written"],
      [tuiConfigs, tuiConfigFile, TUI_SCHEMA, "TUI config"],
    ]) {
      for (const config of configs) {
        if (!config.exists && config.file !== target) continue
        const plan = planConfigFile(config, {
          spec: ctx.spec,
          dataDir: ctx.dataDir,
          mode: "install",
          isTarget: config.file === target,
          home: ctx.home,
        })
        const write = planConfigWrite(config, plan, { schema, label })
        if (write) configWrites.push(write)
      }
    }

    // The plugin files land BEFORE the config entries that name them. The other
    // order leaves OpenCode pointed at a directory that does not exist whenever
    // a copy fails — not fatal to the host, but a wiring the user never asked
    // for and has to undo by hand.
    const changedFiles = copy.filter((file) => file.changed)
    if (changedFiles.length > 0) {
      actions.push({
        kind: "copy",
        label: "Plugin copy",
        path: ctx.dataDir,
        detail: `${ctx.packageName}@${ctx.version} (${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"})`,
      })
      if (!ctx.dryRun) {
        for (const file of changedFiles) {
          await mkdirSafely(path.dirname(file.to))
          await writeFileSafely(file.to, file.buffer)
        }
      }
    }

    for (const write of configWrites) {
      await applyConfigWrite(write, { actions, dryRun: ctx.dryRun, backup: ctx.backup, stamp })
    }

    // Files an older version of this installer wrote and this one does not.
    if (marker?.name === ctx.packageName && marker.files) {
      const shipped = new Set(copy.map((file) => file.relative))
      for (const relative of Object.keys(marker.files)) {
        if (shipped.has(relative)) continue
        actions.push({ kind: "prune", label: "Removed", path: path.join(ctx.dataDir, relative) })
        if (!ctx.dryRun) await rm(path.join(ctx.dataDir, relative), { force: true })
      }
    }
  }

  let skillSha = null
  if (ctx.skill) {
    const source = await readFileOrNull(skillSource)
    if (source === null) {
      warnings.push(`no skill at ${skillSource}; skipping the skill install`)
    } else {
      skillSha = sha256(source)
      const current = await readFileOrNull(skillTarget)
      if (current === null || !current.equals(source)) {
        actions.push({ kind: "skill", label: "Skill", path: skillTarget, detail: SKILL_NAME })
        if (!ctx.dryRun) {
          await mkdirSafely(path.dirname(skillTarget))
          await writeFileSafely(skillTarget, source)
        }
      }
    }
  }

  // The marker is the ownership proof. It is rewritten whenever anything else
  // changed, and left untouched on a no-op run so a second install writes
  // nothing at all.
  const markerPath = path.join(ctx.dataDir, MARKER_FILE)
  const previousMarker = ctx.skillOnly ? null : await readMarker(ctx.dataDir)
  const markerStale =
    !ctx.skillOnly &&
    (previousMarker === null ||
      previousMarker.name !== ctx.packageName ||
      previousMarker.version !== ctx.version ||
      previousMarker.spec !== ctx.spec ||
      previousMarker.skill?.sha256 !== skillSha)
  const changed = actions.some((action) => action.kind !== "snapshot")

  if (!ctx.skillOnly && (changed || markerStale)) {
    const body = {
      name: ctx.packageName,
      version: ctx.version,
      spec: ctx.spec,
      source: ctx.sourceDir,
      installedAt: ctx.now.toISOString(),
      files: Object.fromEntries(copy.map((file) => [file.relative, file.sha256])),
      skill: skillSha ? { path: skillTarget, sha256: skillSha } : null,
    }
    actions.push({ kind: "marker", label: "Marker", path: markerPath })
    if (!ctx.dryRun) {
      await mkdirSafely(ctx.dataDir)
      await writeFileSafely(markerPath, `${JSON.stringify(body, null, 2)}\n`)
    }
  }

  return {
    command: "install",
    ok: true,
    dryRun: ctx.dryRun,
    version: ctx.version,
    packageName: ctx.packageName,
    configDir: ctx.configDir,
    dataDir: ctx.skillOnly ? null : ctx.dataDir,
    spec: ctx.skillOnly ? null : ctx.spec,
    serverConfigFile,
    tuiConfigFile,
    skillFile: ctx.skill ? skillTarget : null,
    actions,
    warnings,
    changed: changed || (!ctx.skillOnly && markerStale),
    alreadyInstalled: !(changed || (!ctx.skillOnly && markerStale)),
  }
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

export async function runUninstall(options = {}) {
  const ctx = await resolveContext(options)
  const actions = []
  const warnings = []
  const stamp = utcStamp(ctx.now)

  for (const name of [...SERVER_CONFIG_CANDIDATES, ...TUI_CONFIG_CANDIDATES]) {
    const file = path.join(ctx.configDir, name)
    let config
    try {
      config = await readConfig(file)
    } catch (error) {
      warnings.push(`${file} could not be parsed; left untouched (${error.message})`)
      continue
    }
    if (!config.exists) continue
    const plan = planConfigFile(config, {
      spec: ctx.spec,
      dataDir: ctx.dataDir,
      mode: "uninstall",
      isTarget: false,
      home: ctx.home,
    })
    if (!plan.changed) continue
    // Re-parsed and re-checked before it is written, exactly as install is: two
    // spellings of our own directory sitting at the tail of a trailing-comma
    // array is the same edit shape, and a bricked config here would be worse —
    // the user is trying to REMOVE this thing.
    const next = rewritePluginArray(config, plan)
    if (next === null) continue
    const backupFile = await snapshot(config.file, config.text, {
      stamp,
      actions,
      dryRun: ctx.dryRun,
      backup: ctx.backup,
    })
    actions.push({
      kind: "removed-entry",
      label: "Removed",
      path: config.file,
      detail: plan.removedSpecs.map((spec) => JSON.stringify(spec)).join(", "),
    })
    if (!ctx.dryRun) await writeWithSnapshot(config.file, next, backupFile)
  }

  const marker = await readMarker(ctx.dataDir)
  const skillTarget = marker?.skill?.path ?? path.join(ctx.configDir, ...SKILL_INSTALL_SEGMENTS)
  const skillOnDisk = await readFileOrNull(skillTarget)
  if (skillOnDisk) {
    const shipped = await readFileOrNull(path.join(ctx.sourceDir, ...SKILL_SOURCE_SEGMENTS))
    const known = sha256(skillOnDisk)
    const ours = known === marker?.skill?.sha256 || (shipped !== null && shipped.equals(skillOnDisk))
    if (ours) {
      actions.push({ kind: "skill-removed", label: "Removed", path: skillTarget })
      if (!ctx.dryRun) {
        await rm(skillTarget, { force: true })
        // The skill's own directory, then the `skill/` root that held it. Both
        // rmdir calls fail harmlessly when anything else lives there.
        await rmdir(path.dirname(skillTarget)).catch(() => {})
        await rmdir(path.dirname(path.dirname(skillTarget))).catch(() => {})
      }
    } else {
      warnings.push(`${skillTarget} has local edits (or came from elsewhere); leaving it in place`)
    }
  }

  if (await exists(ctx.dataDir)) {
    if (marker?.name !== ctx.packageName) {
      warnings.push(
        `${ctx.dataDir} carries no ${MARKER_FILE} naming ${ctx.packageName}; refusing to delete a directory this ` +
          "installer did not create",
      )
    } else {
      actions.push({ kind: "copy-removed", label: "Removed", path: ctx.dataDir })
      if (!ctx.dryRun) {
        for (const relative of Object.keys(marker.files ?? {})) {
          await rm(path.join(ctx.dataDir, relative), { force: true })
        }
        await rm(path.join(ctx.dataDir, MARKER_FILE), { force: true })
        await pruneEmptyDirectories(ctx.dataDir)
        if (await exists(ctx.dataDir)) {
          warnings.push(`${ctx.dataDir} still holds files this installer did not write; it was left in place`)
        }
      }
    }
  }

  return {
    command: "uninstall",
    ok: true,
    dryRun: ctx.dryRun,
    version: ctx.version,
    packageName: ctx.packageName,
    configDir: ctx.configDir,
    dataDir: ctx.dataDir,
    spec: ctx.spec,
    actions,
    warnings,
    changed: actions.some((action) => action.kind !== "snapshot"),
  }
}

async function pruneEmptyDirectories(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await pruneEmptyDirectories(path.join(directory, entry.name))
  }
  await rmdir(directory).catch(() => {})
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function runStatus(options = {}) {
  const ctx = await resolveContext(options)
  const marker = await readMarker(ctx.dataDir)
  const serverConfigFile = await firstExisting(ctx.configDir, SERVER_CONFIG_CANDIDATES)
  const tuiConfigFile = await firstExisting(ctx.configDir, TUI_CONFIG_CANDIDATES)

  const files = []
  for (const name of [...SERVER_CONFIG_CANDIDATES, ...TUI_CONFIG_CANDIDATES]) {
    const config = await readConfig(path.join(ctx.configDir, name)).catch((error) => ({
      file: path.join(ctx.configDir, name),
      exists: true,
      entries: [],
      error: error.message,
    }))
    if (!config.exists) continue
    files.push({
      file: config.file,
      kind: SERVER_CONFIG_CANDIDATES.includes(name) ? "server" : "tui",
      loaded: config.file === serverConfigFile || config.file === tuiConfigFile,
      error: config.error,
      entries: config.entries.map((entry) => ({
        spec: entry.spec,
        ours: localPathOf(entry.spec, { home: ctx.home }) === ctx.dataDir,
        related: isRelatedSpec(entry.spec),
      })),
    })
  }

  const skillFile = path.join(ctx.configDir, ...SKILL_INSTALL_SEGMENTS)
  const skillOnDisk = await readFileOrNull(skillFile)
  const shippedSkill = await readFileOrNull(path.join(ctx.sourceDir, ...SKILL_SOURCE_SEGMENTS))

  const serverWired = files.some((file) => file.kind === "server" && file.loaded && file.entries.some((e) => e.ours))
  const tuiWired = files.some((file) => file.kind === "tui" && file.loaded && file.entries.some((e) => e.ours))

  return {
    command: "status",
    ok: true,
    packageName: ctx.packageName,
    version: ctx.version,
    configDir: ctx.configDir,
    dataDir: ctx.dataDir,
    spec: ctx.spec,
    serverConfigFile,
    tuiConfigFile,
    installedVersion: marker?.version ?? null,
    markerPresent: marker !== null,
    upToDate: marker?.version === ctx.version,
    serverWired,
    tuiWired,
    files,
    skill: {
      file: skillFile,
      present: skillOnDisk !== null,
      current: skillOnDisk !== null && shippedSkill !== null && skillOnDisk.equals(shippedSkill),
    },
    installed: serverWired && tuiWired && marker !== null,
    warnings: [],
    actions: [],
  }
}
