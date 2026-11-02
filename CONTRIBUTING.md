# Contributing

Thanks for helping improve `opencode-goal-pro-max-complete-plugin`.

## Development

Contributors use Bun **1.3.14** (exactly this version) for dependencies, tests, scripts and the `dist/` bundle:

```sh
bun --version        # 1.3.14
bun install --frozen-lockfile
```

`bun.lock` is the only lockfile. Always build `dist/` from a clean frozen install with that Bun: a stale `node_modules` shipped a wrong `zod` in v1.5.0, and a different Bun produces a different bundle. After `bun run bundle`, `git diff --stat -- dist` must show only changes you meant to make.

The installer (`scripts/cli.mjs`) and the packed-package contracts (`type:check`, `smoke:packed-*`, `smoke:git-install`, `pack:check`) stay on Node, because users run them through `npx` and they shell out to `npm pack`. Node 18 is the floor (`engines`), and CI runs the installer on it. Check those with:

```sh
node --test test/installer-cli.test.js test/bootstrap-dispatch.test.js
```

Run the local checks before submitting changes:

```sh
bun run test
bun run test:coverage
bun run type:check
bun run test:mutation
bun run smoke
bun run smoke:packed-host
bun run smoke:packed-tools
bun run benchmark:behavior
bun run benchmark:todo-mirror
bun run verify
bun run check
bun run pack:check
```

For behavior changes, add or update tests in `test/goal-plugin.test.js`.

## OpenCode Compatibility

This plugin depends on OpenCode plugin hooks, including experimental hooks. When changing hook usage, command behavior, or system-prompt transforms:

1. Check the current OpenCode plugin and command documentation.
2. Run `bun run smoke`, `bun run smoke:packed-host`, `bun run smoke:packed-tools`, and `bun run type:check` to verify the source and installed-tarball contracts.
3. Test against a real OpenCode install when possible.
4. Update the compatibility snapshot in [`docs/reference.md`](docs/reference.md#compatibility), and the policy in [`docs/compatibility.md`](docs/compatibility.md), if the tested surface changes.

`bun run smoke` verifies the package export path and `/goal` command hook without invoking a model. The packed-host and packed-tool checks install the npm artifact in isolated consumer projects and verify the public hooks and clean-install default tool contracts. `bun run type:check` compiles installed-package consumers with NodeNext and Bundler resolution. `bun run benchmark:behavior` covers deterministic autonomy and token-efficiency scenarios, and `bun run benchmark:todo-mirror` measures the Todo mirror against a `mirrorTodos: "off"` control. None replaces a real OpenCode smoke test after hook, SDK, or command behavior changes.

## Release checklist

Before publishing or tagging a release, follow [the release process](docs/releasing.md). The required automated gate is:

- run `bun install --frozen-lockfile`
- update `CHANGELOG.md` and the version in `package.json`
- run `bun run release:check`
- perform at least one manual OpenCode smoke test if hook behavior changed
- refresh compatibility notes if the tested OpenCode surface changed

## Pull Requests

Keep pull requests focused. Include:

- what changed
- why it changed
- the checks you ran
- any manual OpenCode smoke testing performed
