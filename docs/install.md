# Install

A full install is **two config entries in two different files plus a skill**.
The installer does all three; the manual route is below it, in case you would
rather see every byte before it lands.

## The easy way

```sh
npx -y github:sblattj/opencode-goal-pro-max-complete-plugin install
```

No `npx` (or no Node yet)? The bootstrap script does the same thing, and falls
back to `git clone` + `node` when `npx` is missing:

```sh
curl -fsSL https://raw.githubusercontent.com/sblattj/opencode-goal-pro-max-complete-plugin/main/install.sh | sh
```

From a clone of this repository:

```sh
node scripts/cli.mjs install
```

Then **restart opencode**. The installer never calls a model and makes no
network call of its own — `npx` fetches the package, and after that everything
is local file copying.

### What it does

1. Copies the plugin (`dist/`, `package.json`, the type declarations, the
   licence) into `$XDG_DATA_HOME/opencode-goal-pro-max-complete-plugin`
   (`~/.local/share/…` by default), with an ownership marker beside it.
2. Adds one `plugin` entry — `file://<that directory>` — to OpenCode's global
   **server** config, i.e. the first of `opencode.jsonc`, `opencode.json`,
   `config.json` that already exists in `~/.config/opencode`, creating
   `opencode.json` when none does.
3. Adds the same entry to the global **TUI** config, `tui.json` (or `tui.jsonc`
   if that is what you have). This is a separate file and it is the only place
   the sidebar half is read from.
4. Copies the shipped skill to `~/.config/opencode/skill/using-the-goal-plugin/SKILL.md`.

Before it edits a config file it writes a snapshot beside it
(`opencode.json.20260907T214450Z.bak`), unless you pass `--no-backup`.

It is idempotent: a second run prints `Already installed (<version>)` and writes
nothing at all — not even a timestamp.

### Commands and flags

| Command | Effect |
| --- | --- |
| `install` | Wire both halves and install the skill. |
| `uninstall` | Remove this installer's entries, its plugin copy and its skill. |
| `status` | Print where everything is and whether each half is wired. |
| `verify` | Run the shipped installation verifier (no model call). |
| `help` | Usage. Also what a bare invocation prints. |

| Flag | Effect |
| --- | --- |
| `--dry-run` | Print every path and entry that would change; write nothing. |
| `--skill-only` | Install only the skill. |
| `--no-skill` | Install the plugin without the skill. |
| `--no-backup` | Do not snapshot a config file before editing it. |
| `--config-dir DIR` | Override OpenCode's global config directory. |
| `--data-dir DIR` | Override where the plugin copy is written. |
| `--json` | Machine-readable summary instead of the report. |

Exit codes: `0` ok (including "already installed"), `1` failed, `2` usage error,
`3` refused on purpose — an unusable destination path, or a config file the
installer will not rewrite blind.

`GOAL_PLUGIN_REF=v1.0.0 sh install.sh` installs a specific tag instead of `main`.

### What it will refuse to do

* **Install into a path containing `:` or `#`.** Those two characters break the
  TUI half and only the TUI half: the module loader splits a path at the first
  colon, so the host's runtime-module shim never runs, and the TUI runtime's own
  path helper truncates a path at the first `#`. Measured one factor at a time
  on the current runtime: a plain directory loads, `https:/` fails, `a:b` fails,
  `a#b` fails through the truncation. The server half is unaffected, which is
  exactly why this is worth refusing — the tools would work, `opencode debug
  config` would look right, and the sidebar would silently never appear.
* **Rewrite a config file it could not parse.** It prints the file and stops.
* **Delete a directory it did not create.** `uninstall` removes the plugin copy
  only when the ownership marker inside it names this package, and removes the
  installed skill only when the file still matches the shipped bytes.

It *will* remove an entry naming an **older build of this same plugin** (the
previous package name, a `github:` spec, a tarball, another local copy) and say
so on its way past. That is not tidiness: both halves still export the
historical plugin id `opencode-goal-plugin`, and the TUI runtime rejects a
duplicate id outright, so a second entry does not add a plugin — it breaks the
one that is already there.

## The manual way

Two files in your global config directory (`~/.config/opencode`, or
`$XDG_CONFIG_HOME/opencode`).

`opencode.json` — the server half: the `/goal` command, the tools, the hooks,
the sidebar payload.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///Users/you/.local/share/opencode-goal-pro-max-complete-plugin"],
  "command": {
    "goal": {
      "description": "Set a session-scoped goal and auto-continue until complete.",
      "template": "$ARGUMENTS",
      "agent": "build"
    }
  }
}
```

`tui.json` — the TUI half: the sidebar goal panel. Nothing in `opencode.json`
registers it.

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["file:///Users/you/.local/share/opencode-goal-pro-max-complete-plugin"]
}
```

Point both at a **directory** that contains `package.json` and `dist/` — a
checkout of this repository works. Three rules:

1. **Use an absolute `file://` URL with no trailing slash.** A relative path is
   resolved against the config file that declared it, and duplicate detection
   compares `file://` specs as exact strings, so `…/dir` and `…/dir/` are two
   plugins with one id — which is a rejection, not a second plugin.
2. **Do not point `tui.json` at a `github:` spec or a tarball URL.** OpenCode
   caches such a package in a directory whose name is the raw spec, which
   contains a `:` — see the refusal above. The server half loads from it; the
   sidebar never appears, with no error anywhere.
3. **Pick the right file.** Inside the global directory OpenCode merges
   `config.json`, then `opencode.json`, then `opencode.jsonc`, and the merge
   **replaces** arrays rather than concatenating them. If you have an
   `opencode.jsonc`, a `plugin` array written into `opencode.json` is silently
   discarded. (TUI configs are the friendly exception: their `plugin` arrays are
   unioned across files.) Comments and trailing commas are fine in any of them —
   every config file goes through the same JSONC parser.

### `opencode plugin … --global`

For the **server half only**, OpenCode's own CLI can write the entry:

```sh
opencode plugin file:///Users/you/.local/share/opencode-goal-pro-max-complete-plugin --global
```

It patches `opencode.json` for the server half and `tui.json` for the TUI half,
so for a local directory declaring both halves it does the same job. The
installer does not shell out to it, for three reasons: it needs the `opencode`
binary on `PATH`, it runs an npm install for anything that is not already a
local path, and when both `opencode.json` and `opencode.jsonc` exist it picks
the *opposite* one from the file the config loader lets win — writing into the
file that loses is a silent no-op.

## Upgrading

Re-run the installer. It rewrites the copy, leaves exactly one entry per file,
and reports what changed:

```sh
npx -y github:sblattj/opencode-goal-pro-max-complete-plugin install
```

`status` tells you whether the copy is behind:

```sh
npx -y github:sblattj/opencode-goal-pro-max-complete-plugin status
```

Both halves must be upgraded together — they are separate registrations, and an
older panel reading a newer payload quietly drops stats.

## Uninstalling

```sh
npx -y github:sblattj/opencode-goal-pro-max-complete-plugin uninstall
```

Removes the two config entries (snapshotting each file first), the skill it
installed, and the plugin copy. Anything it did not write is left alone, and it
says so when it leaves something behind.

## `OPENCODE_CONFIG` and friends

If you export `OPENCODE_CONFIG`, that file is loaded **in addition to** the
global directory and the two sources are unioned — an entry the installer writes
into the global file still takes effect, and you do not need to unset anything.
`OPENCODE_CONFIG_DIR` is different: it *replaces* the global config directory
for config, skills and TUI config alike, and the installer follows it.

## Troubleshooting

**The `/goal` command and the `goal_*` tools work, but there is no sidebar
panel.** The TUI half is not registered. Check `tui.json` — not `opencode.json`
— and check that the path in it contains no `:` or `#`:

```sh
npx -y github:sblattj/opencode-goal-pro-max-complete-plugin status
```

**Nothing loaded at all.** Config problems are logged, not fatal. Dump the
resolved config to a file (never a pipe — the output is large and a truncated
JSON error reads like a broken command) and look at `plugin` and
`plugin_origins`:

```sh
opencode debug config > /tmp/opencode-config.json
```

`plugin_origins` names the file each entry came from. If your entry is missing,
another file in the global directory replaced the array — see rule 3 above.

**The skill is not offered.** List what OpenCode found, again to a file:

```sh
opencode debug skill > /tmp/opencode-skills.txt
```

`using-the-goal-plugin` should be there with a `location` under your config
directory. Duplicate names are resolved by taking the first one found, so if
another tool already installs a skill with this name, yours may be shadowed.

**"already installed" but nothing works.** `status` prints every `plugin` entry
in every global config file, marks the one that is ours, and says which files
OpenCode will actually read.
