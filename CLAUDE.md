# godot-mcp

MCP server for Godot 4 with Android export validator support. **Fork of [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp)** at commit `1209744` (MIT licence); maintained independently by [@jamesdowzard](https://github.com/jamesdowzard). Fork relationship is severed at the git level; attribution preserved per MIT.

Published npm: `@jamesdowzard/godot-mcp`.

## Why the fork exists

Upstream does not cover Android export validation. James's Godot work (piano-xr, vr-player, others) needs automated checks that Android export presets are present and valid before a CI/local build. This fork adds that validator and other AI-friendly tooling.

Do not submit changes here upstream unless you are sure they belong there — the fork's direction is AI tooling + Android pipeline, which may diverge from upstream's scope.

## Run / dev

```bash
bun install             # or npm i
bun run build
bun run dev             # local stdio server for Claude Code
```

Register in `~/.claude.json` MCP servers block (stdio transport) — see `README.md` for the exact snippet.

## Layout

| Path | Purpose |
|------|---------|
| `src/` | TypeScript MCP server — tool handlers, Godot CLI wrapper |
| `build/` | compiled JS (committed for quick npm install) |
| `scripts/` | dev helpers |

## House rules

- Feature branches only. No direct commits to `main`.
- Keep Android export validator and other added tools cleanly separated from upstream modules so a future upstream rebase stays tractable.
- MIT notices must stay intact — do not remove the upstream attribution header in `README.md`.

## Related

- Reference: `reference_godot_mcp_fork.md` in auto-memory.
- Apps using it: `piano-xr`, `vr-player`, `unity-quest-base`-adjacent work.
- Claude Code dossier: `dossiers/claude-stack/` covers the MCP server inventory.
