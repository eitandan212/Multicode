# Vendored from T3 Code

Copied unchanged (tests left out) from [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
at commit `95411e3cd75afa47c1c891d4be426600ce46be3a`, under the MIT license in `LICENSE`
(Copyright (c) 2026 T3 Tools Inc.). T3 Code's name and branding are not covered by that license
and are not used by MultiCode.

- `effect-codex-app-server/`: T3 Code's Codex app-server client (`packages/effect-codex-app-server/src`)
- `effect-acp/`: T3 Code's Agent Client Protocol client (`packages/effect-acp/src`)

MultiCode's providers (`server/providers/codex.ts`, `server/providers/acp.ts`) launch these the
way T3 Code does: `ChildProcess.make` → `spawner.spawn` → `layerChildProcess`. They need
`effect` and `@effect/platform-node` 4.1.5, the versions T3 Code pins.
