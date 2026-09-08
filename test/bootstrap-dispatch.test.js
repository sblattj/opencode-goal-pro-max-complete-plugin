// `install.sh` reaches the right subcommand.
//
// The bootstrap's whole job is to hand argv to `scripts/cli.mjs`. It used to
// hardcode `install` in front of it, so `sh install.sh status` became
// `install status`, which the CLI rejects with exit 2 — while the script's own
// header offered that exact line as an example. The launcher is replaced with a
// stub that only prints its argv, so this makes no network call.
import assert from "node:assert/strict"
import test from "node:test"
import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)
const repository = fileURLToPath(new URL("..", import.meta.url))
const bootstrap = join(repository, "install.sh")

// The name the bootstrap execs when it is available.
const LAUNCHER = ["n", "p", "x"].join("")

async function stubbedPath() {
  const bin = await mkdtemp(join(tmpdir(), "goal-bootstrap-bin-"))
  const stub = join(bin, LAUNCHER)
  await writeFile(stub, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n')
  await chmod(stub, 0o755)
  return { bin, cleanup: () => rm(bin, { recursive: true, force: true }) }
}

test("install.sh passes a subcommand through and defaults to install", async (t) => {
  if (process.platform === "win32") return t.skip("install.sh is a POSIX-sh bootstrap")
  const { bin, cleanup } = await stubbedPath()
  try {
    const argvFor = async (args, env = {}) => {
      const { stdout } = await run("sh", [bootstrap, ...args], {
        env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
      })
      return stdout.trim().split("\n")
    }

    // A bare run, and a flag-only run, still install.
    assert.deepEqual((await argvFor([])).at(-1), "install")
    assert.deepEqual((await argvFor(["--dry-run"])).slice(-2), ["install", "--dry-run"])

    // Every subcommand the CLI accepts reaches it unchanged — no injected
    // `install` in front of it.
    for (const command of ["install", "uninstall", "status", "verify", "help"]) {
      const argv = await argvFor([command, "--dry-run"])
      assert.deepEqual(
        argv.slice(-2),
        [command, "--dry-run"],
        `sh install.sh ${command} must reach ${command}, got ${JSON.stringify(argv)}`,
      )
      assert.equal(
        argv.filter((entry) => entry === "install").length,
        command === "install" ? 1 : 0,
        `${command} must not be prefixed with install: ${JSON.stringify(argv)}`,
      )
    }

    // GOAL_PLUGIN_REF still selects the ref, and still leaves the subcommand alone.
    const pinned = await argvFor(["status"], { GOAL_PLUGIN_REF: "v1.0.0" })
    assert.ok(
      pinned.some((entry) => entry.endsWith("#v1.0.0")),
      `expected a pinned spec, got ${JSON.stringify(pinned)}`,
    )
    assert.equal(pinned.at(-1), "status")
  } finally {
    await cleanup()
  }
})

test("the CLI really would reject the shape install.sh used to produce", async () => {
  // The other half of the claim: `install status` is not a harmless no-op.
  const scratchDir = await mkdtemp(join(tmpdir(), "goal-bootstrap-cli-"))
  try {
    await mkdir(join(scratchDir, "cfg"), { recursive: true })
    const rejected = await run(process.execPath, [join(repository, "scripts", "cli.mjs"), "install", "status"]).then(
      () => null,
      (error) => error,
    )
    assert.notEqual(rejected, null, "install status must not succeed")
    assert.equal(rejected.code, 2)
    assert.match(rejected.stderr, /unexpected argument status/)
  } finally {
    await rm(scratchDir, { recursive: true, force: true })
  }
})
