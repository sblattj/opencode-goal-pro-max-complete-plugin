// Packed manifest contract.
//
// The package ships TWO plugin targets: the server half (`./server`, the tools
// and hooks) and the TUI half (`./tui`, the sidebar goal panel). OpenCode
// discovers them from the SAME package.json `exports` map, so an edit that
// drops or renames either key silently removes half the plugin with no test
// failure anywhere else. This contract re-implements opencode 1.18.29's own
// discovery rules against the PACKED tarball — the bytes a user installs, not
// the working tree — and then loads the packed `./tui` entry the way the TUI
// runtime does.
//
// Re-implemented from opencode 1.18.29:
//   * `exportValue`      packages/opencode/src/plugin/install.ts:105-119
//   * `exportTarget`     packages/opencode/src/plugin/install.ts:128-138
//   * `packageTargets`   packages/opencode/src/plugin/install.ts:145-166
//     (the target list behind `readPluginManifest`, install.ts:283-330)
//   * `resolvePackageEntrypoint` packages/opencode/src/plugin/shared.ts:103-115
//   * `readV1Plugin`     packages/opencode/src/plugin/shared.ts:272-304
//
// `solid-js` and `@opentui/solid/jsx-runtime` are provided to plugins by the
// host at runtime (`ensureRuntimePluginSupport`, packages/opencode/src/plugin/
// tui/runtime.ts:47), so they are deliberately NOT dependencies of this
// package. They are stubbed in the consumer's node_modules here, which is also
// how the packed bundle is held to importing them rather than declaring them.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const repository = new URL("..", import.meta.url)
const root = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-packed-manifest-"))
const packDirectory = join(root, "pack")
const projectDirectory = join(root, "consumer")
const cacheDirectory = join(root, "npm-cache")
const npmEnvironment = { ...process.env, npm_config_cache: cacheDirectory }

function execNpm(args, options) {
  if (process.env.npm_execpath) {
    return execFileSync(process.execPath, [process.env.npm_execpath, ...args], options)
  }
  if (process.platform === "win32") {
    return execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd", ...args], options)
  }
  return execFileSync("npm", args, options)
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// install.ts:105-119.
function exportValue(value) {
  if (typeof value === "string") {
    const next = value.trim()
    return next || undefined
  }
  if (!isRecord(value)) return
  for (const key of ["import", "default"]) {
    const next = value[key]
    if (typeof next !== "string") continue
    const hit = next.trim()
    if (hit) return hit
  }
}

// install.ts:128-138.
function exportTarget(pkg, kind) {
  if (!isRecord(pkg.exports)) return
  const value = pkg.exports[`./${kind}`]
  const entry = exportValue(value)
  if (!entry) return
  return { entry }
}

// install.ts:140-166. `oc-themes` is not used by this package, so the theme
// branch that can synthesise a bare `tui` target cannot fire here — the `tui`
// target below has to come from a real `exports["./tui"]`.
function packageTargets(pkg) {
  assert.equal(pkg["oc-themes"], undefined, "oc-themes would synthesise a tui target without an entrypoint")
  const targets = []
  const server = exportTarget(pkg, "server")
  if (server) targets.push({ kind: "server", entry: server.entry })
  else if (typeof pkg.main === "string" && pkg.main.trim()) targets.push({ kind: "server", entry: pkg.main.trim() })

  const tui = exportTarget(pkg, "tui")
  if (tui) targets.push({ kind: "tui", entry: tui.entry })

  return targets
}

// shared.ts:272-304, the `kind` the TUI runtime asks for (tui/runtime.ts:676-685).
function readV1Plugin(mod, spec, kind) {
  const value = mod.default
  assert.ok(isRecord(value), `Plugin ${spec} must default export an object with ${kind}()`)
  const server = "server" in value ? value.server : undefined
  const tui = "tui" in value ? value.tui : undefined
  if (server !== undefined) assert.equal(typeof server, "function", `Plugin ${spec} has invalid server export`)
  if (tui !== undefined) assert.equal(typeof tui, "function", `Plugin ${spec} has invalid tui export`)
  assert.ok(
    server === undefined || tui === undefined,
    `Plugin ${spec} must default export either server() or tui(), not both`,
  )
  if (kind === "server") assert.notEqual(server, undefined, `Plugin ${spec} must default export an object with server()`)
  if (kind === "tui") assert.notEqual(tui, undefined, `Plugin ${spec} must default export an object with tui()`)
  return value
}

async function writeStub(directory, manifest, files) {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest, null, 2))
  for (const [name, source] of Object.entries(files)) {
    await writeFile(join(directory, name), source)
  }
}

try {
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(projectDirectory, { recursive: true }),
    mkdir(cacheDirectory, { recursive: true }),
  ])
  await writeFile(join(projectDirectory, "package.json"), JSON.stringify({ private: true, type: "module" }))

  // `npm pack --json` can print lifecycle or notice output ahead of its JSON
  // array (it did, until the `prepack` build was removed in 0.10.1 to keep the
  // package installable from a git spec), so the payload starts at the first `[`.
  const packOutput = execNpm(["pack", "--json", "--pack-destination", packDirectory], {
    cwd: repository,
    encoding: "utf8",
    env: npmEnvironment,
  })
  const packJsonStart = packOutput.indexOf("[")
  assert.notEqual(packJsonStart, -1, `npm pack --json produced no JSON array:\n${packOutput}`)
  const packResult = JSON.parse(packOutput.slice(packJsonStart))
  assert.equal(packResult.length, 1)
  const tarball = join(packDirectory, packResult[0].filename)

  execNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--cache", cacheDirectory, tarball],
    { cwd: projectDirectory, stdio: "pipe", env: npmEnvironment },
  )

  const installedRoot = join(projectDirectory, "node_modules", "opencode-goal-plugin")
  const manifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"))

  // 1. The manifest exposes exactly the two plugin targets, in the order
  //    `packageTargets` builds them.
  const targets = packageTargets(manifest)
  assert.deepEqual(
    targets.map((target) => target.kind),
    ["server", "tui"],
    "readPluginManifest must see a server target and a tui target",
  )

  // 2. Both entrypoints are real files IN THE TARBALL. `files` omitting `dist`
  //    or a renamed bundle would pass every in-tree test and ship a broken
  //    package.
  const entries = Object.fromEntries(targets.map((target) => [target.kind, target.entry]))
  assert.equal(entries.server, manifest.main, "the server target must be the package main, as v0.9.x shipped it")
  assert.notEqual(entries.server, entries.tui, "server and tui must be distinct files (shared.ts:293-294)")
  for (const [kind, entry] of Object.entries(entries)) {
    const file = join(installedRoot, entry)
    const info = await stat(file).catch(() => undefined)
    assert.ok(info?.isFile(), `${kind} entrypoint ${entry} is missing from the tarball`)
  }

  // 3. Host runtime modules the TUI plugin imports, stubbed. These must resolve
  //    from the consumer's node_modules, which only works if the bundle kept
  //    them external.
  const registrations = []
  const nodeModules = join(projectDirectory, "node_modules")
  await writeStub(
    join(nodeModules, "solid-js"),
    { name: "solid-js", version: "0.0.0-stub", type: "module", main: "./index.js" },
    {
      "index.js": [
        "export const For = function For() {}",
        "export const Show = function Show() {}",
        "export function createMemo(fn) {",
        "  return fn",
        "}",
        "",
      ].join("\n"),
    },
  )
  await writeStub(
    join(nodeModules, "@opentui", "solid"),
    {
      name: "@opentui/solid",
      version: "0.0.0-stub",
      type: "module",
      exports: { "./jsx-runtime": "./jsx-runtime.js" },
    },
    {
      "jsx-runtime.js": [
        "export function jsx(type, props) {",
        "  return { type, props }",
        "}",
        "",
      ].join("\n"),
    },
  )

  // 4. The packed `./tui` subpath resolves through Node's own exports map and
  //    satisfies readV1Plugin for kind "tui".
  const probe = join(projectDirectory, "probe.mjs")
  await writeFile(probe, 'export * from "opencode-goal-plugin/tui"\nexport { default } from "opencode-goal-plugin/tui"\n')
  const tuiModule = await import(pathToFileURL(probe).href)
  const plugin = readV1Plugin(tuiModule, "opencode-goal-plugin", "tui")
  assert.equal(plugin.id, "opencode-goal-plugin")
  assert.equal(typeof tuiModule.goalPanelModel, "function", "the tui entry must re-export its pure model")

  // The server entry must still refuse to load as a TUI plugin, and vice
  // versa: that asymmetry is the whole reason there are two targets.
  const serverModule = await import(pathToFileURL(join(installedRoot, entries.server)).href)
  assert.throws(
    () => readV1Plugin(serverModule, "opencode-goal-plugin", "tui"),
    /must default export an object with tui\(\)/,
    "the server entry must not satisfy the tui contract",
  )
  assert.throws(
    () => readV1Plugin(tuiModule, "opencode-goal-plugin", "server"),
    /must default export an object with server\(\)/,
    "the tui entry must not satisfy the server contract",
  )

  // 5. `tui()` registers a sidebar_content view, and that view renders the goal
  //    panel for the session it is handed.
  const goal = {
    v: 1,
    state: "active",
    objective: "ship the sidebar panel",
    turns: { used: 3, max: 10 },
  }
  const sessions = new Map([
    ["ses_with_goal", { id: "ses_with_goal", metadata: { goal } }],
    ["ses_cleared", { id: "ses_cleared", metadata: { goal: null } }],
  ])
  const logged = []
  const api = {
    slots: {
      register(view) {
        registrations.push(view)
      },
    },
    theme: { current: { text: "#fff", textMuted: "#888", error: "#f00", warning: "#fa0", success: "#0f0" } },
    state: { session: { get: (id) => sessions.get(id) } },
    client: {
      app: {
        log: async (input) => {
          logged.push(input)
        },
      },
    },
  }
  await plugin.tui(api, {}, { spec: "opencode-goal-plugin" })

  assert.equal(registrations.length, 1, "tui() must register exactly one slot view")
  const [registration] = registrations
  assert.equal(typeof registration.order, "number", "the view must declare a render order")
  assert.equal(
    typeof registration.slots?.sidebar_content,
    "function",
    "tui() must register a sidebar_content slot (sidebar.tsx:85)",
  )

  const node = registration.slots.sidebar_content({}, { session_id: "ses_with_goal" })
  assert.equal(typeof node.type, "function", "the slot must return a component element")
  const rendered = node.type(node.props)
  assert.equal(rendered.props.when, true, "the panel must render for a session with a goal")

  const clearedNode = registration.slots.sidebar_content({}, { session_id: "ses_cleared" })
  assert.equal(
    clearedNode.type(clearedNode.props).props.when,
    false,
    "the panel must hide itself once the goal is cleared",
  )

  const missingNode = registration.slots.sidebar_content({}, { session_id: "ses_unknown" })
  assert.equal(missingNode.type(missingNode.props).props.when, false, "an unknown session must not render a panel")

  assert.equal(logged.length, 1, "registration must be recorded once in opencode's log")

  console.log(
    `packed manifest contract passed (${manifest.name}@${manifest.version}; targets: ${targets
      .map((target) => `${target.kind} -> ${target.entry}`)
      .join(", ")})`,
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
