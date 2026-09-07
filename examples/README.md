# Example OpenCode configuration

Two files, because a full install is **two entries in two different files**:
`opencode.json` registers the *server* half (the `/goal` command, the tools, the
hooks, and the sidebar payload), and `tui.json` — beside it, in the same config
directory — registers the *TUI* half (the sidebar panel). The server half works
alone; you get the status line and no panel. See
[Install](../README.md#install) in the README for why a spec must name the
package **before** the source, and what happens silently when it does not.

> **`<tag>` is a placeholder: these files do not install as shipped.** No tag
> has been cut under `opencode-goal-pro-max-complete-plugin` yet, and nothing is
> published on npm under that name. Replace `<tag>` with a released tag once one
> exists. Until then, point both files at a local copy of the package
> **directory** (never a file inside it):
>
> ```json
> { "plugin": ["file:///absolute/path/to/opencode-goal-pro-max-complete-plugin"] }
> ```
