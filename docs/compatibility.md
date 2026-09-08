# Compatibility policy

## Supported package surface

The latest published release is the supported line. Public compatibility covers:

- the package root, `opencode-goal-pro-max-complete-plugin/server`, and
  `opencode-goal-pro-max-complete-plugin/tui` ESM exports
- the declarations exported by `index.d.ts`
- the documented `GoalPluginOptions` fields
- the documented OpenCode hook names
- the six canonical goal tools and five legacy tool aliases
- persisted-state recovery from versions documented in the changelog
- concurrent persistence for distinct OpenCode sessions in one project, with
  single-writer protection retained per session and passive goal behavior for
  a same-session process that does not own the lease

The package requires Node.js 18 or newer and OpenCode 1.17.15 through the latest
compatible 1.x release. CI runs the complete unit suite on Node 18, 20, 22, and
24. Installed-package contracts compile TypeScript consumers using both NodeNext
and Bundler resolution and require a clean npm-tarball install to expose the
default agent-tool surface without a separately installed OpenCode helper package.

Filesystem-sensitive lifecycle tests run on Linux, macOS, and Windows. POSIX file
mode and symbolic-link protections are applied where the operating system supports
them; the plugin does not claim that Windows provides equivalent POSIX semantics.
The Windows job also runs the installed-package type, host, and tool contracts
so their portable npm launcher path is exercised in CI.

When two processes open the same OpenCode session, only the lease owner may read
or change that session's goal workflow. The contender keeps ordinary chat and
unrelated tools available, but goal controls are denied and ambient hooks do not
attempt a takeover. Canonical goal tools return the stable envelope code
`session_owned_elsewhere`; a `/goal` slash command instead produces a
human-readable denial through its normal model-rendered command turn. Once the
owner exits, an explicit goal command or tool may acquire the shard; recovered
active goals load paused and require an explicit resume. Forking creates a
distinct session shard and remains the supported way to work concurrently from
the same conversation.

The immutable-claim lease protocol atomically hard-links a complete regular-file
compatibility guard at `<shard>/state.json.lock`; active owners publish unique
claims in the sibling `<shard>/state.json.lock.claims-v2/` directory. Publication
is no-replace: an older lock directory and the current guard cannot both win the
same startup race. Older releases treat the future-dated guard as non-reclaimable,
while current releases determine ownership only from immutable claims. Automatic
takeover requires all participating processes to run the current release.
Legacy, incomplete, tampered, or unsupported lease layouts fail closed rather
than being rewritten online. If that condition persists, first close every
OpenCode process that could own the session and upgrade them; then either fork
the session or manually remove only the affected shard's adjacent `.lock` file
or legacy directory and `.lock.claims-v2` directory. Do not remove its state or
lifecycle ledger. The local filesystem must support regular-file hard links
and preserve the guard's future timestamp; the plugin does not fall back to a
weaker publication protocol.

## OpenCode host compatibility

OpenCode's experimental hooks and SDK request shapes may change within the 1.x
line. Automated tests cover both current flattened session inputs and the legacy
generated-client shape, but a real-host smoke test remains required when hook or
SDK behavior changes. The current manual provider matrix is maintained in
[providers.md](providers.md).

OpenCode custom commands still become model turns. The plugin handles `/goal`
arguments in `command.execute.before` and mutates the host-retained parts array
in place so the turn contains the plugin-generated command result rather than
raw command text. This makes command routing deterministic, but does not turn the
hook into a direct-render API: the selected model remains responsible for the
visible response.

For objective-bearing commands, retained file attachments may be expanded by
OpenCode into synthetic Read/MCP text and file parts before `chat.message`. The
plugin correlates that host-resolved shape to the exact one-shot command and
generated message/session before treating it as plugin-owned. Each retained
file must yield at least one resolved companion part; a host-reported read error
pauses the goal without reclassifying the command as human intervention.

OpenCode 1.17.15 and 1.18.10 do not invoke
`experimental.chat.system.transform`. Control-command correctness therefore
comes from the rewritten turn's escaped reporting frame, fail-closed tool
blocking, and parent-correlated lifecycle suppression. The system transform
remains registered as additional protection for hosts that support it.

## Todo mirror

From 1.0.1 the session's native Todo list is drawn from the goal plan while a plan exists
(`mirrorTodos: "plan"`, the default; the mechanism is in
[reference.md](reference.md#todo-mirror)). The mirror is a rewrite of the model's own `todowrite`
arguments, so it reaches every surface that renders the **stored** list — the TUI's Todo sidebar
section, the `opencode run` renders, and the desktop client's todo dock — and it survives a restart,
because the TUI re-seeds that store from the server on session hydration.

**Two more surfaces, reached indirectly.** OpenCode also renders the `todowrite` *transcript bubble*,
in the TUI and again on the web share page (`opencode run` prints a third). Neither is a plugin
slot — the TUI plugin API exposes sidebar, prompt and app-shell slots only, and the transcript is a
hardcoded switch rather than a slot lookup — so nothing in this package can *render* into them. But
all three read the tool call's recorded `state.input.todos`, and the host records that part from the
very `args` object `tool.execute.before` rewrites in place, so the rewrite reaches the transcript
anyway. **Measured on OpenCode 1.18.29: the bubble shows the mirrored rows**, so scrollback, the Todo
sidebar section and the host's own table all agree. `npm run smoke:todo-safety` re-measures this on
every run and prints the answer as an `F19 — verdict` line rather than asserting it, because a future
host that snapshotted the arguments *before* the hook would flip it back — and only then would
scrollback start keeping the model's original wording. Its control is already in the same run: with
no goal the mirror is inert and the bubble shows exactly what the model sent.

**`priority` is wire-only in the TUI.** Mirrored rows carry a `priority` (`high` for the first row
still to act on, `low` for completed rows, `medium` otherwise) because the host's schema requires
one, but the TUI's todo item component never reads it — it renders `[✓]`, `[•]` or `[ ]` from
`status` alone. Other clients, including the desktop app, may render it, so the field is populated
honestly rather than stubbed.

### Seven documented hazards

Each of these is a property of the host or of another plugin, not something this package can fix.
They are documented rather than worked around, and `mirrorTodos: "off"` removes all seven.

1. **The suffixed `todowrite` description reaches sessions that have no goal.** The
   `tool.definition` hook carries no session id, and OpenCode caches one plugin instance per project
   directory, so the suffix is served to every session in the same project — ordinary `build`
   sessions and custom subagents included. Primary sessions (`build`, `plan`) inherit `"*": "allow"`
   and can act on the suffix; **subagents are the opposite**. Every subagent spawned through the
   `task` tool gets `todowrite` denied by default — the host appends a `todowrite` `*` deny to the
   child session unless the subagent's own ruleset already names `todowrite`
   (`packages/opencode/src/agent/subagent-permissions.ts`, `deriveSubagentSessionPermission`, applied
   twice on the spawn path in `packages/opencode/src/tool/task.ts`). Agent *definitions* are the
   softer story — only `general` and `explore` deny the tool there — but it is the child *session's*
   ruleset that decides, so the suffix reaches sessions that can act on it and sessions that cannot.
   (Measured against OpenCode 1.18.29.) The
   suffix is deliberately *static*, so it never flips mid-conversation and never invalidates a
   cached prompt prefix, and it is *self-checking*: it ends by telling the model that with no
   `<goal_plan>` block the tool behaves normally, which is true — in a session that has never held a
   goal the mirror hooks return without rewriting anything.
2. **`todowrite: "ask"` turns every refresh into a permission modal.** OpenCode's permission check
   is three-valued: anything that is not `allow` or `deny` raises a user-facing request. The
   plugin's explicit stale-mirror nudge is budgeted at **three per goal run** (refunded by
   `/goal resume`), which bounds the prompts it asks for by name; the plan block's standing
   instruction to call `todowrite({todos: []})` when the list drifts is not budgeted, so a model
   that follows it eagerly can ask more often. `mirrorTodos: "off"` removes both.
3. **On hosts where `todowrite` is denied, the mirror never becomes fresh.** `general` denies the
   tool outright, `explore` denies everything but a read-only allow-list, and every `task`-spawned
   subagent inherits a default deny (hazard 1), so the before-hook never gets to mirror anything and
   no write ever lands. The mirror then reads `stale` for the whole run rather than `off`, which has
   two visible consequences: the Goal panel's progress line carries ` · todo list stale` — or
   ` · mirror drift (N≠0)` when the session's own native list is not empty, because the panel checks
   drift against `plan.mirror.rows` (0 here) *before* it reports staleness — and the
   panel still shows the **exception list**, so `pending` actions appear only in `/goal status`. The
   nudge self-suppresses once its budget is spent. **No configuration introspection is performed** —
   the plugin cannot see the merged ruleset, and the empirical signal is both simpler and correct.
   If you run goals under an agent that denies `todowrite`, set `mirrorTodos: "off"`: that is the
   mode in which the panel goes back to listing every action.
4. **Another plugin's `tool.execute.before` can overwrite the mirror.** Hooks run in plugin load
   order with no arbitration, so the last plugin to mutate `args.todos` wins. Neither side can
   detect this from inside; the observable is a Todo list that does not match the plan while the
   panel reports the mirror fresh.
5. **A second, hookless `todowrite` implementation exists in the host.** It writes the same table
   and fires no plugin hooks. The live loop today is the hooked one, so the mirror works; if that
   other runner ever became the default, the mirror would go inert — and silently, because the
   plugin would see no calls at all rather than an error.
6. **`/undo` does not rewind todos.** Session revert rewinds messages and file snapshots only, so a
   revert past the last mirrored write leaves the mirrored rows in place beside a transcript that no
   longer contains them. One `todowrite({todos: []})` redraws the list from the current plan.
7. **One deliberate departure from the host's todo convention.** That convention asks for exactly
   one `in_progress` item at a time. The mirror does not honour it: a plan may hold several
   `in_progress` actions, and `blocked` and unverified-`done` actions also mirror as `in_progress`.
   The second half follows the same convention, which states that a blocked item stays
   `in_progress`; the first is a consequence of the list being a projection of the plan rather than
   a hand-maintained checklist. The plan, not the list, is the source of truth about the work.

### Verifying it against a real host

Two smoke scripts exercise the mirror through the production plugin loader, the host's own
`todowrite`, its permission check and its SQLite write, with nothing faked but the model:
`npm run smoke:todo-mirror` (the plan is redrawn over a divergent list, with an `"off"` control and
a no-goal control) and `npm run smoke:todo-safety` (every assertion is about rows *surviving* an
empty `todowrite` after a stop, after a completion, and in a session that never had a goal, where it
must still clear the list). Both need the `opencode` binary on `PATH` and a freshly bundled `dist/`,
and neither is part of `release:check`, because that binary is not a dev dependency.

## OpenCode 2

**Status: not supported, and not yet tested.**

The package declares `engines.opencode` as `>=1.17.15 <2`. There is no
`peerDependencies` entry: the host supplies the plugin API, so a peer range
would only add an install-time warning about something OpenCode already
controls. That bound is deliberate: no claim in this repository is made without
a verified run behind it, and the project has not yet exercised the plugin
against an OpenCode 2 build. Treat OpenCode 2 as unverified rather than as
known-broken.

### What already exists in this direction

- `createOpenCodeSessionApi` speaks both the legacy generated-client shape
  (`{ path, body, query }`) and the flattened shape (`{ sessionID, ... }`),
  selected per operation and remembered after the first success. The
  `sdkShape: "flat"` option pins the flattened shape for embedded clients.
- Only read-only operations are ever replayed against the alternate shape, so a
  shape probe can never duplicate a mutating call. This invariant is pinned by
  the mutation contract.

### What a supported v2 claim would require

Before the pin is widened, all of the following need to pass against a real
OpenCode 2 build, not a mock:

1. Plugin load and hook registration through the v2 plugin entrypoint.
2. `command.execute.before`, `event`, `experimental.chat.system.transform`,
   `experimental.session.compacting`, and `experimental.compaction.autocontinue`
   firing with the shapes the plugin expects.
3. The execution-context signals (`chat.message`, `chat.params`,
   `session.updated`) still reporting the active agent, which the planning-only
   restriction depends on.
4. Session-API calls (`messages`, `promptAsync`, `create`, `get`, `update`,
   `abort`) under whichever argument shape v2 ships.
5. Goal-specific compaction context and recovery of running child sessions after
   a plugin restart, which are the areas most likely to differ.

### Configuration

This package ships **both plugin halves**, and a full install is therefore
**two entries in two different files**. `package.json` exports three paths: the
root and `opencode-goal-pro-max-complete-plugin/server` (the server half —
commands, tools, hooks, and the title and metadata writes) and
`opencode-goal-pro-max-complete-plugin/tui` (the sidebar panel).

`opencode.json`'s `plugin` array only ever produces *server* plugins; OpenCode
reads *TUI* plugins from a separate `tui.json`/`tui.jsonc`, whose location
differs between OpenCode lines, and the two formats must not be mixed. Register
the package in **both** files to get the panel. The server half works alone —
you get the [status line](reference.md#status-line), which reaches every client
through the session title rather than through a TUI plugin, and no panel. On a
host without TUI plugin slots the `./tui` target is simply never loaded.

## Versioning

Semantic-versioning intent is:

- patch: compatible fixes, documentation, and stronger verification
- minor: backward-compatible options, hooks, commands, or tools
- major: removal or incompatible change to a documented public surface

`testInternals` is exported for diagnostics and the project's own tests; it is not
part of the semantic-version compatibility guarantee.
