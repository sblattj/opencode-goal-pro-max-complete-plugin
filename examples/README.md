# Example OpenCode configuration

**The easy path is the installer — it writes both of these files for you:**

```sh
npx -y github:sblattj/opencode-goal-pro-max-complete-plugin install
```

See [docs/install.md](../docs/install.md) for what it writes, what it refuses to
do, and how to undo it.

The files here are for the manual route. There are two of them because a full
install is **two entries in two different files**: `opencode.json` registers the
*server* half (the `/goal` command, the tools, the hooks, and the sidebar
payload), and `tui.json` — beside it, in the same config directory — registers
the *TUI* half (the sidebar panel). The server half works alone; you get the
status line and no panel.

> **`<tag>` is a placeholder: these files do not install as shipped.** Replace
> `<tag>` with a released tag. And note the trap in `tui.json`: a `github:` spec
> is cached in a directory whose name contains a `:`, which the TUI loader
> cannot read — so the sidebar half will not appear even though the server half
> does. Point both files at a local copy of the package **directory** (never a
> file inside it), which is exactly what the installer does for you:
>
> ```json
> { "plugin": ["file:///absolute/path/to/opencode-goal-pro-max-complete-plugin"] }
> ```
