# Panacode UI redesign (Arc → SolidJS)

This directory ships the Panacode desktop UI redesign that was implemented against the OpenCode-based fork (`arashmakkyy/panacode`), based on the eight Arc reference projects in `panacode-arc-ex.zip`.

## Why patches live here

The cloud agent environment can **read** `arashmakkyy/panacode` but cannot **push** branches to it (`permissions.push: false`). Deliverables are therefore exported as applyable patches for a maintainer with write access to the Panacode fork.

Local implementation also remains on the agent VM at `/workspace/panacode` on branch `cursor/panacode-ui-redesign-58f9` (commits `013e9c250` … `0e555403e`).

## Contents

| Path | Purpose |
|---|---|
| `UPSTREAM-MERGE.md` | Mandatory upstream maintenance guide (copy to `panacode-docs/UPSTREAM-MERGE.md`) |
| `patches/0001-*.patch` … `0004-*.patch` | Ordered `git format-patch` series from baseline `5c198b87a…` |
| `panacode-ui-redesign.diff` | Combined diff (same range) for review |

## Apply on the Panacode fork

```bash
git clone https://github.com/arashmakkyy/panacode.git
cd panacode
git fetch origin
git switch -c cursor/panacode-ui-redesign-58f9 5c198b87a7adcc6f237d072be3d651c8e1433217
# or: git switch -c cursor/panacode-ui-redesign-58f9 origin/master  # if tip matches baseline

git am /path/to/panaai/app-src/docs/panacode/ui-redesign/patches/*.patch
bun install
bun script/panacode-ui-ownership-check.ts
bun --cwd packages/panacode-ui test
bun --cwd packages/panacode-ui typecheck
git push -u origin cursor/panacode-ui-redesign-58f9
```

## What the series does

1. Adds `@panacode/ui` (`packages/panacode-ui`) — tokens, Switch, primitives, eight feature shells, adapters, Phase 2 `[data-brand="panacode"]` shell CSS, ownership check, `panacode` theme JSON.
2. Wires the app — default theme Panacode, brand mark, MCP settings panel adapter, permission dock → Agent Approvals.
3. Adds `panacode-docs/UPSTREAM-MERGE.md`.

## Verification already run in the agent VM

- `bun script/panacode-ui-ownership-check.ts` — ok
- `bun --cwd packages/panacode-ui test` — 3 pass
- `bun --cwd packages/panacode-ui typecheck` — ok
- `bun --cwd packages/desktop test electron-builder.config.test.ts` — 11 pass

Full monorepo `bun typecheck` / desktop GUI smoke were not fully executed in this environment; see UPSTREAM-MERGE §H–L.
