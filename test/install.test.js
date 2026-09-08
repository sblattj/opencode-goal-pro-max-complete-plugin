// The installer, exercised against throwaway HOME / XDG trees.
//
// Every expectation below is computed from files — the bytes the fixture wrote,
// the bytes the installer wrote — rather than from a literal typed twice, so a
// test cannot agree with the code by copying it.
import assert from "node:assert/strict"
import test from "node:test"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import {
  MARKER_FILE,
  blankJsoncComments,
  editPluginArray,
  isRelatedSpec,
  localPathOf,
  locatePluginArray,
  parseJsonc,
  rewritePluginArray,
  runInstall,
  runStatus,
  runUninstall,
  specForDirectory,
  unusablePathCharacter,
} from "../scripts/install.mjs"

const PACKAGE_NAME = "opencode-goal-pro-max-complete-plugin"
const VERSION = "9.9.9"

const SKILL = [
  "---",
  "name: using-the-goal-plugin",
  'description: "Use when a goal is running."',
  "---",
  "",
  "# Using the goal plugin",
  "",
].join("\n")

async function fixture(label) {
  const root = await mkdtemp(join(tmpdir(), `goal-installer-${label}-`))
  const sourceDir = join(root, "package")
  const configDir = join(root, "cfg", "opencode")
  const dataDir = join(root, "data", PACKAGE_NAME)
  await mkdir(join(sourceDir, "dist"), { recursive: true })
  await mkdir(join(sourceDir, "skills", "using-the-goal-plugin"), { recursive: true })
  const manifest = {
    name: PACKAGE_NAME,
    version: VERSION,
    type: "module",
    main: "./dist/goal-plugin.js",
    exports: {
      "./server": { import: "./dist/goal-plugin.js" },
      "./tui": { import: "./dist/goal-tui.js" },
    },
  }
  await writeFile(join(sourceDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(sourceDir, "dist", "goal-plugin.js"), 'export default { id: "opencode-goal-plugin" }\n')
  await writeFile(join(sourceDir, "dist", "goal-tui.js"), 'export default { id: "opencode-goal-plugin" }\n')
  await writeFile(join(sourceDir, "index.d.ts"), "export {}\n")
  await writeFile(join(sourceDir, "tui.d.ts"), "export {}\n")
  await writeFile(join(sourceDir, "LICENSE"), "MIT\n")
  await writeFile(join(sourceDir, "README.md"), "# fixture\n")
  await writeFile(join(sourceDir, "skills", "using-the-goal-plugin", "SKILL.md"), SKILL)
  return {
    root,
    sourceDir,
    configDir,
    dataDir,
    options: { sourceDir, configDir, dataDir, env: {}, home: root },
    skillFile: join(configDir, "skill", "using-the-goal-plugin", "SKILL.md"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

async function writeConfig(configDir, name, body) {
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, name), body)
  return join(configDir, name)
}

async function readMaybe(file) {
  try {
    return await readFile(file, "utf8")
  } catch {
    return null
  }
}

/** A second, deliberately dumb JSONC reader, so the tests do not verify the installer with itself. */
function looseParse(text) {
  let out = ""
  let i = 0
  let inString = false
  while (i < text.length) {
    const ch = text[i]
    if (inString) {
      if (ch === "\\") {
        out += text.slice(i, i + 2)
        i += 2
        continue
      }
      if (ch === '"') inString = false
      out += ch
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1
      continue
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
}

async function snapshotTree(directory) {
  const seen = {}
  async function walk(current) {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else {
        const info = await stat(full)
        seen[full] = `${info.mtimeMs}:${info.size}`
      }
    }
  }
  await walk(directory)
  return seen
}

test("a fresh tree gets both halves, the copy and the skill", async () => {
  const f = await fixture("fresh")
  try {
    const result = await runInstall(f.options)
    const expectedSpec = pathToFileURL(f.dataDir).href

    assert.equal(result.spec, expectedSpec)
    assert.equal(result.changed, true)
    assert.equal(result.alreadyInstalled, false)

    const server = JSON.parse(await readFile(join(f.configDir, "opencode.json"), "utf8"))
    const tui = JSON.parse(await readFile(join(f.configDir, "tui.json"), "utf8"))
    assert.deepEqual(server.plugin, [expectedSpec], "the server half is registered in opencode.json")
    assert.deepEqual(tui.plugin, [expectedSpec], "the TUI half needs its own file (config/tui.ts:184)")
    assert.equal(server.$schema, "https://opencode.ai/config.json")
    assert.equal(tui.$schema, "https://opencode.ai/tui.json")
    assert.equal(expectedSpec.endsWith("/"), false, "a trailing slash is a different plugin (config/plugin.ts:70)")

    // Every copied file must be byte-identical to the source it came from.
    const marker = JSON.parse(await readFile(join(f.dataDir, MARKER_FILE), "utf8"))
    assert.equal(marker.name, PACKAGE_NAME)
    assert.equal(marker.version, VERSION)
    const copied = Object.keys(marker.files)
    assert.ok(copied.includes("package.json") && copied.includes("dist/goal-plugin.js") && copied.includes("dist/goal-tui.js"))
    for (const relative of copied) {
      const [from, to] = await Promise.all([
        readFile(join(f.sourceDir, relative)),
        readFile(join(f.dataDir, relative)),
      ])
      assert.ok(from.equals(to), `${relative} was not copied byte for byte`)
    }

    const [skillSource, skillInstalled] = await Promise.all([
      readFile(join(f.sourceDir, "skills", "using-the-goal-plugin", "SKILL.md")),
      readFile(f.skillFile),
    ])
    assert.ok(skillSource.equals(skillInstalled), "the skill is copied verbatim into <config>/skill/")

    const status = await runStatus(f.options)
    assert.equal(status.serverWired, true)
    assert.equal(status.tuiWired, true)
    assert.equal(status.installedVersion, VERSION)
    assert.equal(status.skill.present, true)
    assert.equal(status.skill.current, true)
  } finally {
    await f.cleanup()
  }
})

test("an existing config keeps every other key and every other plugin", async () => {
  const f = await fixture("existing")
  const before = {
    $schema: "https://opencode.ai/config.json",
    model: "anthropic/claude-sonnet-4",
    plugin: ["some-other-plugin@1.2.3", "file:///somewhere/else"],
    command: { goal: { description: "Set a goal", template: "$ARGUMENTS", agent: "build" } },
  }
  try {
    const file = await writeConfig(f.configDir, "opencode.json", `${JSON.stringify(before, null, 2)}\n`)
    await runInstall(f.options)

    const after = JSON.parse(await readFile(file, "utf8"))
    for (const key of Object.keys(before)) {
      if (key === "plugin") continue
      assert.deepEqual(after[key], before[key], `${key} must survive untouched`)
    }
    assert.deepEqual(after.plugin, [...before.plugin, pathToFileURL(f.dataDir).href])

    // A snapshot of the original bytes sits beside it.
    const names = await readdir(f.configDir)
    const backups = names.filter((name) => name.startsWith("opencode.json.") && name.endsWith(".bak"))
    assert.equal(backups.length, 1, `expected exactly one snapshot, got ${JSON.stringify(names)}`)
    assert.deepEqual(JSON.parse(await readFile(join(f.configDir, backups[0]), "utf8")), before)
  } finally {
    await f.cleanup()
  }
})

test("an entry from the old package name is removed and reported", async () => {
  const f = await fixture("oldname")
  const stale = "opencode-goal-plugin@github:sblattj/OpenCode-goal-plugin#v0.10.0"
  try {
    const file = await writeConfig(
      f.configDir,
      "opencode.json",
      `${JSON.stringify({ plugin: [stale, "unrelated-plugin"] }, null, 2)}\n`,
    )
    const tuiFile = await writeConfig(f.configDir, "tui.json", `${JSON.stringify({ plugin: [stale] }, null, 2)}\n`)
    assert.equal(isRelatedSpec(stale), true)

    const result = await runInstall(f.options)
    const after = JSON.parse(await readFile(file, "utf8"))
    const tuiAfter = JSON.parse(await readFile(tuiFile, "utf8"))

    assert.deepEqual(after.plugin, ["unrelated-plugin", pathToFileURL(f.dataDir).href])
    assert.deepEqual(tuiAfter.plugin, [pathToFileURL(f.dataDir).href])
    assert.ok(
      result.actions.some((action) => action.kind === "removed-entry" && action.detail.includes(stale)),
      "removing a rival build of this plugin must be reported, not silent",
    )
  } finally {
    await f.cleanup()
  }
})

test("a jsonc-only tree is edited in place, comments and all", async () => {
  const f = await fixture("jsonc")
  const body = [
    "{",
    '  // my opencode config',
    '  "$schema": "https://opencode.ai/config.json",',
    '  "model": "anthropic/claude-sonnet-4", // the good one',
    '  "plugin": [',
    '    "some-other-plugin", // keep me',
    "  ],",
    "}",
    "",
  ].join("\n")
  try {
    const file = await writeConfig(f.configDir, "opencode.jsonc", body)
    await runInstall(f.options)

    const after = await readFile(file, "utf8")
    assert.ok(after.includes("// my opencode config"), "comments must survive a surgical edit")
    assert.ok(after.includes("// the good one"))
    assert.ok(after.includes("// keep me"))
    assert.deepEqual(looseParse(after).plugin, ["some-other-plugin", pathToFileURL(f.dataDir).href])

    // opencode.jsonc is merged LAST and REPLACES the array (config.ts:274 + :43),
    // so writing a second file next to it would be discarded.
    assert.equal(await readMaybe(join(f.configDir, "opencode.json")), null)
  } finally {
    await f.cleanup()
  }
})

test("when both global files exist the .jsonc wins and the .json entry is cleaned up", async () => {
  const f = await fixture("bothfiles")
  const ourSpec = pathToFileURL(f.dataDir).href
  try {
    const json = await writeConfig(
      f.configDir,
      "opencode.json",
      `${JSON.stringify({ plugin: ["opencode-goal-plugin@github:sblattj/OpenCode-goal-plugin#v0.9.0", "keep-me"] }, null, 2)}\n`,
    )
    const jsonc = await writeConfig(f.configDir, "opencode.jsonc", '{\n  "plugin": []\n}\n')

    const result = await runInstall(f.options)
    assert.equal(result.serverConfigFile, jsonc)
    assert.deepEqual(looseParse(await readFile(jsonc, "utf8")).plugin, [ourSpec])
    assert.deepEqual(JSON.parse(await readFile(json, "utf8")).plugin, ["keep-me"])
  } finally {
    await f.cleanup()
  }
})

test("a second install writes nothing at all", async () => {
  const f = await fixture("idempotent")
  try {
    await runInstall(f.options)
    const before = { ...(await snapshotTree(f.configDir)), ...(await snapshotTree(f.dataDir)) }
    const second = await runInstall(f.options)
    const after = { ...(await snapshotTree(f.configDir)), ...(await snapshotTree(f.dataDir)) }

    assert.equal(second.alreadyInstalled, true)
    assert.equal(second.changed, false)
    assert.deepEqual(after, before, "an idempotent run must not touch a single file")
    assert.deepEqual(second.actions, [])
  } finally {
    await f.cleanup()
  }
})

test("--dry-run reports the same work and writes nothing", async () => {
  const f = await fixture("dryrun")
  try {
    const planned = await runInstall({ ...f.options, dryRun: true })
    assert.ok(planned.actions.length > 0)
    assert.deepEqual(await snapshotTree(f.configDir), {})
    assert.deepEqual(await snapshotTree(f.dataDir), {})

    const real = await runInstall(f.options)
    assert.deepEqual(
      real.actions.map((action) => `${action.kind}:${action.path}`),
      planned.actions.map((action) => `${action.kind}:${action.path}`),
      "the dry run must describe exactly the work the real run does",
    )
  } finally {
    await f.cleanup()
  }
})

test("uninstall restores the entry set and removes only what it owns", async () => {
  const f = await fixture("uninstall")
  const before = { plugin: ["unrelated-plugin"], model: "anthropic/claude-sonnet-4" }
  try {
    const file = await writeConfig(f.configDir, "opencode.json", `${JSON.stringify(before, null, 2)}\n`)
    await runInstall(f.options)
    await runUninstall(f.options)

    const after = JSON.parse(await readFile(file, "utf8"))
    assert.deepEqual(after.plugin, before.plugin, "an unrelated plugin must survive uninstall")
    assert.equal(after.model, before.model)
    assert.deepEqual(looseParse(await readFile(join(f.configDir, "tui.json"), "utf8")).plugin, [])
    assert.equal(await readMaybe(f.skillFile), null, "the skill we installed is removed")
    assert.deepEqual(await snapshotTree(f.dataDir), {}, "the plugin copy is removed")
  } finally {
    await f.cleanup()
  }
})

test("uninstall refuses to delete a data directory it did not create", async () => {
  const f = await fixture("nomarker")
  try {
    await runInstall(f.options)
    await rm(join(f.dataDir, MARKER_FILE))
    const treasure = join(f.dataDir, "not-ours.txt")
    await writeFile(treasure, "keep me\n")

    const result = await runUninstall(f.options)
    assert.equal(await readMaybe(treasure), "keep me\n")
    assert.ok(await readMaybe(join(f.dataDir, "dist", "goal-tui.js")))
    assert.ok(
      result.warnings.some((warning) => warning.includes(MARKER_FILE)),
      `expected a refusal naming the marker, got ${JSON.stringify(result.warnings)}`,
    )
  } finally {
    await f.cleanup()
  }
})

test("a data directory containing ':' or '#' is refused with an explanation", async () => {
  for (const bad of [":", "#"]) {
    const f = await fixture(`unusable${bad === ":" ? "colon" : "hash"}`)
    try {
      const dataDir = join(f.root, `data${bad}dir`, PACKAGE_NAME)
      await assert.rejects(
        () => runInstall({ ...f.options, dataDir }),
        (error) => {
          assert.equal(error.code, "unusable-path")
          assert.ok(error.message.includes(JSON.stringify(bad)))
          assert.match(error.hint, /TUI/)
          return true
        },
      )
      assert.deepEqual(await snapshotTree(f.configDir), {}, "a refusal must not leave a half-install behind")
    } finally {
      await f.cleanup()
    }
  }
})

test("--skill-only and --no-skill do exactly one half each", async () => {
  const f = await fixture("skillonly")
  try {
    await runInstall({ ...f.options, skillOnly: true })
    assert.ok(await readMaybe(f.skillFile))
    assert.deepEqual(await snapshotTree(f.dataDir), {})
    assert.equal(await readMaybe(join(f.configDir, "opencode.json")), null)
  } finally {
    await f.cleanup()
  }

  const g = await fixture("noskill")
  try {
    await runInstall({ ...g.options, skill: false })
    assert.equal(await readMaybe(g.skillFile), null)
    assert.ok(await readMaybe(join(g.configDir, "opencode.json")))
  } finally {
    await g.cleanup()
  }
})

test("--no-backup skips the snapshot", async () => {
  const f = await fixture("nobackup")
  try {
    await writeConfig(f.configDir, "opencode.json", '{\n  "plugin": []\n}\n')
    await runInstall({ ...f.options, backup: false })
    const names = await readdir(f.configDir)
    assert.deepEqual(names.filter((name) => name.endsWith(".bak")), [])
  } finally {
    await f.cleanup()
  }
})

test("an unreadable target config is refused rather than rewritten", async () => {
  const f = await fixture("garbage")
  try {
    const file = await writeConfig(f.configDir, "opencode.json", "{ this is not json\n")
    await assert.rejects(
      () => runInstall(f.options),
      (error) => {
        assert.equal(error.code, "unreadable-config")
        return true
      },
    )
    assert.equal(await readFile(file, "utf8"), "{ this is not json\n", "the broken file is left exactly as it was")
  } finally {
    await f.cleanup()
  }
})

test("an upgrade rewrites the copy and leaves one entry behind", async () => {
  const f = await fixture("upgrade")
  try {
    await runInstall(f.options)
    const manifestPath = join(f.sourceDir, "package.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    manifest.version = "10.0.0"
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(join(f.sourceDir, "dist", "goal-plugin.js"), "export default { id: 'x', changed: true }\n")

    const result = await runInstall(f.options)
    assert.equal(result.changed, true)
    const [from, to] = await Promise.all([
      readFile(join(f.sourceDir, "dist", "goal-plugin.js")),
      readFile(join(f.dataDir, "dist", "goal-plugin.js")),
    ])
    assert.ok(from.equals(to))
    const marker = JSON.parse(await readFile(join(f.dataDir, MARKER_FILE), "utf8"))
    assert.equal(marker.version, "10.0.0")
    assert.deepEqual(JSON.parse(await readFile(join(f.configDir, "opencode.json"), "utf8")).plugin, [
      pathToFileURL(f.dataDir).href,
    ])
  } finally {
    await f.cleanup()
  }
})

test("a stale spelling of our own directory is replaced by the canonical one", async () => {
  const f = await fixture("canonical")
  try {
    // A plain path and a trailing slash both name the same directory but are
    // DIFFERENT plugins to the dedupe (config/plugin.ts:70), so they must not
    // survive next to the canonical entry.
    const file = await writeConfig(
      f.configDir,
      "opencode.json",
      `${JSON.stringify({ plugin: [f.dataDir, `${pathToFileURL(f.dataDir).href}/`] }, null, 2)}\n`,
    )
    await runInstall(f.options)
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).plugin, [pathToFileURL(f.dataDir).href])
  } finally {
    await f.cleanup()
  }
})

test("the plugin copy is refused when the source is incomplete", async () => {
  const f = await fixture("brokensource")
  try {
    await rm(join(f.sourceDir, "dist", "goal-tui.js"))
    await assert.rejects(
      () => runInstall(f.options),
      (error) => {
        assert.equal(error.code, "broken-source")
        return true
      },
    )
  } finally {
    await f.cleanup()
  }
})

test("XDG variables decide both destinations", async () => {
  const f = await fixture("xdg")
  try {
    const env = { XDG_CONFIG_HOME: join(f.root, "xdgcfg"), XDG_DATA_HOME: join(f.root, "xdgdata") }
    const result = await runInstall({ sourceDir: f.sourceDir, env, home: f.root })
    assert.equal(result.configDir, join(env.XDG_CONFIG_HOME, "opencode"))
    assert.equal(result.dataDir, join(env.XDG_DATA_HOME, PACKAGE_NAME))
    assert.ok(await readMaybe(join(result.configDir, "opencode.json")))
    assert.ok(await readMaybe(join(result.dataDir, "dist", "goal-tui.js")))
  } finally {
    await f.cleanup()
  }
})

test("HOME decides both destinations when XDG is unset", async () => {
  const f = await fixture("home")
  try {
    const result = await runInstall({ sourceDir: f.sourceDir, env: {}, home: f.root, dryRun: true })
    assert.equal(result.configDir, join(f.root, ".config", "opencode"))
    assert.equal(result.dataDir, join(f.root, ".local", "share", PACKAGE_NAME))
  } finally {
    await f.cleanup()
  }
})

test("OPENCODE_CONFIG_DIR replaces the config directory (global.ts:64)", async () => {
  const f = await fixture("configdirenv")
  try {
    const env = { OPENCODE_CONFIG_DIR: join(f.root, "elsewhere") }
    const result = await runInstall({ sourceDir: f.sourceDir, dataDir: f.dataDir, env, home: f.root, dryRun: true })
    assert.equal(result.configDir, env.OPENCODE_CONFIG_DIR)
  } finally {
    await f.cleanup()
  }
})

// --- the JSONC editor, on its own -------------------------------------------

test("the JSONC editor preserves every byte it is not asked to change", () => {
  const original = [
    "{",
    "  /* block",
    "     comment */",
    '  "plugin": [ "a", "b" ], // trailing',
    '  "other": { "deep": [1, 2, 3] },',
    "}",
    "",
  ].join("\n")
  const edited = editPluginArray(original, { remove: [0], add: "file:///x" })
  assert.ok(edited.includes("/* block"))
  assert.ok(edited.includes("// trailing"))
  assert.deepEqual(parseJsonc(edited).plugin, ["b", "file:///x"])
  assert.deepEqual(parseJsonc(edited).other, { deep: [1, 2, 3] })
  assert.equal(blankJsoncComments(original).length, original.length, "blanking comments must preserve every offset")
})

test("the JSONC editor removes adjacent elements without leaving a dangling comma", () => {
  const original = '{\n  "plugin": ["a", "b", "c"]\n}\n'
  const edited = editPluginArray(original, { remove: [0, 1], add: null })
  assert.deepEqual(parseJsonc(edited).plugin, ["c"])
  const emptied = editPluginArray(original, { remove: [0, 1, 2], add: null })
  assert.deepEqual(parseJsonc(emptied).plugin, [])
})

test("the JSONC editor adds a plugin key to a config that has none", () => {
  const withKeys = editPluginArray('{\n  "model": "x"\n}\n', { add: "file:///y" })
  assert.deepEqual(parseJsonc(withKeys), { model: "x", plugin: ["file:///y"] })
  const empty = editPluginArray("{}\n", { add: "file:///y" })
  assert.deepEqual(parseJsonc(empty), { plugin: ["file:///y"] })
})

test("a [spec, options] tuple is understood, kept and matched", () => {
  const original = '{\n  "plugin": [["some-plugin", { "a": 1 }], "opencode-goal-plugin@1.0.0"]\n}\n'
  const located = locatePluginArray(original)
  assert.equal(located.array.elements.length, 2)
  const edited = editPluginArray(original, { remove: [1], add: "file:///z" })
  assert.deepEqual(parseJsonc(edited).plugin, [["some-plugin", { a: 1 }], "file:///z"])
})

test("localPathOf understands every spelling of a local directory", () => {
  const home = "/home/someone"
  assert.equal(localPathOf("file:///a/b", { home }), "/a/b")
  assert.equal(localPathOf("file:///a/b/", { home }), "/a/b")
  assert.equal(localPathOf("~/plug", { home }), join(home, "plug"))
  assert.equal(localPathOf("/a/b", { home }), "/a/b")
  assert.equal(localPathOf("some-npm-package", { home }), null)
  assert.equal(localPathOf("github:owner/repo", { home }), null)
  assert.equal(specForDirectory("/a/b/"), pathToFileURL("/a/b").href)
})

test("a directory of a skill install is created lazily, not left empty on a refusal", async () => {
  const f = await fixture("lazydir")
  try {
    await rm(join(f.sourceDir, "skills"), { recursive: true })
    const result = await runInstall(f.options)
    assert.ok(result.warnings.some((warning) => warning.includes("skill")))
    assert.equal(await readMaybe(f.skillFile), null)
    assert.equal(await readMaybe(join(dirname(f.skillFile), "SKILL.md")), null)
  } finally {
    await f.cleanup()
  }
})

// ---------------------------------------------------------------------------
// Regressions from the 1.0.0 installer review
// ---------------------------------------------------------------------------

test("every array shape survives every removal, trailing comma included", () => {
  // The shape that used to brick a config: a trailing comma plus two or more
  // consecutive removals ending at the LAST element left an orphan `, ,`, and
  // the installer still exited 0 saying "Restart opencode to load it."
  const bricked = editPluginArray('{\n  "plugin": [\n    "keep",\n    "a",\n    "b",\n  ]\n}\n', {
    remove: [1, 2],
    add: null,
  })
  assert.deepEqual(looseParse(bricked).plugin, ["keep"])
  assert.equal(/,\s*,/.test(bricked), false, `an orphan comma was left behind:\n${bricked}`)

  // …and the general case, computed rather than typed: every layout crossed with
  // every subset of removals, checked with the second, dumber parser.
  const specs = ["a@1", "b@2", "c@3", "d@4"]
  const add = "file:///tmp/added"
  let checked = 0
  for (const count of [1, 2, 3, 4]) {
    for (const multiline of [true, false]) {
      for (const trailingComma of [true, false]) {
        for (const comments of multiline ? [true, false] : [false]) {
          const items = specs.slice(0, count).map((spec) => JSON.stringify(spec))
          const text = multiline
            ? `{\n  "model": "x",\n  "plugin": [\n${items
                .map((item, i) => `    ${item}${i < count - 1 || trailingComma ? "," : ""}${comments ? ` // ${i}` : ""}`)
                .join("\n")}\n  ]\n}\n`
            : `{ "model": "x", "plugin": [${items.join(", ")}${trailingComma ? "," : ""}] }\n`
          const before = looseParse(text).plugin
          for (let mask = 0; mask < 1 << count; mask += 1) {
            const remove = [...Array(count).keys()].filter((i) => mask & (1 << i))
            for (const wanted of [null, add]) {
              checked += 1
              const shape = JSON.stringify({ count, multiline, trailingComma, comments, remove, add: Boolean(wanted) })
              const edited = editPluginArray(text, { remove, add: wanted })
              const kept = before.filter((_, i) => !remove.includes(i))
              const expected = wanted && !kept.includes(wanted) ? [...kept, wanted] : kept
              let after
              try {
                after = looseParse(edited)
              } catch (error) {
                assert.fail(`${shape} produced unparseable JSON (${error.message}):\n${edited}`)
              }
              assert.deepEqual(after.plugin, expected, `${shape} produced ${JSON.stringify(after.plugin)}:\n${edited}`)
              assert.equal(after.model, "x", `${shape} lost a sibling key:\n${edited}`)
            }
          }
        }
      }
    }
  }
  assert.equal(checked, 360, "the matrix itself must not silently shrink")
})

test("a rewrite that does not come out right is refused, not written", () => {
  const text = '{\n  "plugin": ["keep", "drop"]\n}\n'
  const entries = [
    { index: 0, entry: "keep", spec: "keep" },
    { index: 1, entry: "drop", spec: "drop" },
  ]
  const config = { file: "/tmp/does-not-exist/opencode.json", exists: true, text, entries }

  // The happy path still returns bytes.
  const good = rewritePluginArray(config, { changed: true, remove: [1], removedSpecs: ["drop"], add: null })
  assert.deepEqual(looseParse(good).plugin, ["keep"])

  // A plan whose survivors disagree with what the edit produced — which is what
  // an editor bug looks like from the outside — must throw before any write.
  assert.throws(
    () =>
      rewritePluginArray(
        { ...config, entries: [...entries, { index: 2, entry: "ghost", spec: "ghost" }] },
        { changed: true, remove: [1], removedSpecs: ["drop"], add: null },
      ),
    (error) => {
      assert.equal(error.code, "unreadable-config")
      assert.match(error.message, /did not come out right/)
      assert.match(error.message, /nothing was written/)
      return true
    },
  )
})

test("a Windows drive colon is exempt from the path refusal, and warned about", async () => {
  const windows = { platform: "win32" }
  assert.equal(unusablePathCharacter("C:\\Users\\me\\AppData\\Local\\pkg", windows), null)
  assert.equal(unusablePathCharacter("\\\\server\\share\\pkg", windows), null)
  assert.equal(unusablePathCharacter("C:\\Users\\me\\bad:dir\\pkg", windows), ":", "a second colon is still fatal")
  assert.equal(unusablePathCharacter("C:\\Users\\me\\bad#dir\\pkg", windows), "#")
  // Same string, POSIX host: the drive colon has no special meaning there.
  assert.equal(unusablePathCharacter("C:\\Users\\me\\AppData\\Local\\pkg", { platform: "linux" }), ":")

  const f = await fixture("windows")
  try {
    const result = await runInstall({ ...f.options, platform: "win32", dryRun: true })
    assert.ok(
      result.warnings.some((warning) => warning.includes("drive colon") && warning.includes("sidebar")),
      `expected the unverified-TUI warning, got ${JSON.stringify(result.warnings)}`,
    )
    const posix = await runInstall({ ...f.options, platform: "darwin", dryRun: true })
    assert.deepEqual(posix.warnings, [], "the warning must be Windows-only")
  } finally {
    await f.cleanup()
  }
})

test("the plugin copy lands before the config entries that name it", async () => {
  const f = await fixture("copyfirst")
  try {
    const result = await runInstall(f.options)
    const kinds = result.actions.map((action) => action.kind)
    assert.ok(kinds.includes("copy") && kinds.includes("config"))
    assert.ok(
      kinds.indexOf("copy") < kinds.indexOf("config"),
      `the copy must precede every config write, got ${JSON.stringify(kinds)}`,
    )
  } finally {
    await f.cleanup()
  }
})

test("a filesystem refusal is a sentence, not a stack trace", async () => {
  const f = await fixture("eisdir")
  try {
    // A directory sitting exactly where opencode.json belongs.
    await mkdir(join(f.configDir, "opencode.json"), { recursive: true })
    await assert.rejects(
      () => runInstall(f.options),
      (error) => {
        assert.equal(error.name, "InstallError")
        assert.equal(error.code, "write-failed")
        assert.match(error.message, /cannot write .*opencode\.json \(EISDIR\)/)
        assert.match(error.hint, /directory is sitting where that file belongs/)
        return true
      },
    )
  } finally {
    await f.cleanup()
  }
})

test("a failed write does not leave its snapshot behind", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores the read-only bit")
  const f = await fixture("nostraybak")
  try {
    const file = await writeConfig(f.configDir, "opencode.json", '{\n  "plugin": []\n}\n')
    await chmod(file, 0o444)
    await assert.rejects(
      () => runInstall(f.options),
      (error) => {
        assert.equal(error.code, "write-failed")
        return true
      },
    )
    const names = await readdir(f.configDir)
    assert.deepEqual(
      names.filter((name) => name.endsWith(".bak")),
      [],
      "a snapshot of a file that was never edited is litter",
    )
  } finally {
    await chmod(join(f.configDir, "opencode.json"), 0o644).catch(() => {})
    await f.cleanup()
  }
})

test("uninstall leaves no empty skill directory behind", async () => {
  const f = await fixture("skilldir")
  try {
    await runInstall(f.options)
    assert.notEqual(await readMaybe(f.skillFile), null)
    assert.ok((await readdir(f.configDir)).includes("skill"), "the fixture must have created skill/ to begin with")
    await runUninstall(f.options)
    assert.equal(
      (await readdir(f.configDir)).includes("skill"),
      false,
      "an empty skill/ left behind is a directory the user now has to clean up by hand",
    )
  } finally {
    await f.cleanup()
  }
})

test("uninstall survives two spellings of our directory at the tail of a jsonc array", async () => {
  const f = await fixture("tailuninstall")
  const ours = pathToFileURL(f.dataDir).href
  try {
    const file = await writeConfig(
      f.configDir,
      "opencode.json",
      `{\n  "model": "x",\n  "plugin": [\n    "keep-me",\n    ${JSON.stringify(ours)},\n    ${JSON.stringify(`${ours}/`)},\n  ]\n}\n`,
    )
    const result = await runUninstall(f.options)
    assert.equal(result.ok, true)
    const after = await readFile(file, "utf8")
    assert.deepEqual(looseParse(after).plugin, ["keep-me"])
    assert.equal(looseParse(after).model, "x")
  } finally {
    await f.cleanup()
  }
})
