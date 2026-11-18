# Panacode ← OpenCode upstream merge guide

This document is the authoritative guide for merging newer OpenCode versions into the Panacode fork without destroying the Panacode design system.

Read this **before** editing UI surfaces or running an upstream merge.

---

## A. Repository identity

| Item | Value |
|---|---|
| Upstream repository | `https://github.com/anomalyco/opencode` |
| Panacode fork | `https://github.com/arashmakkyy/panacode` |
| Upstream integration branch | `dev` (verified via `upstream/dev`) |
| Panacode working branch for this redesign | `cursor/panacode-ui-redesign-58f9` |
| Recommended stable Panacode branch | `master` (fork default) / future `panacode/main` |
| Baseline Panacode commit (pre-redesign tip) | `5c198b87a7adcc6f237d072be3d651c8e1433217` (`fix(cli): embed panaai provider in Bun builtins`) |
| Current Panacode redesign tip | `05fa01cca` on `cursor/panacode-ui-redesign-58f9` (update after each push) |
| Baseline date (UTC) | 2026-11-17 |
| Recorded upstream tip at redesign time | `a0fdbf9b91ed2cf8bfd778ccec340285403eddc2` on `upstream/dev` |
| Toolchain | Bun `1.4.4` (root `packageManager`), SolidJS via workspace catalog, Electron desktop in `packages/desktop` |
| Design package | `@panacode/ui` → `packages/panacode-ui` |

Remotes (expected):

```text
origin    → https://github.com/arashmakkyy/panacode.git
upstream  → https://github.com/anomalyco/opencode.git
```

Do **not** replace `upstream` with the Panacode fork. If `upstream` is missing:

```bash
git remote add upstream https://github.com/anomalyco/opencode.git
git fetch upstream
```

Update the baseline SHA in this section after every successful upstream integration.

---

## B. Panacode customization architecture

### Goal

**Functional OpenCode underneath. Visually independent Panacode on top.**

Presentation lives in Panacode-owned modules. Domain state, session engine, tools, MCP controllers, diff engine, terminal PTY, and providers stay upstream.

### Design system location

```text
packages/panacode-ui/          # @panacode/ui — Panacode-owned
  src/
    theme/                     # theme id helpers (PANACODE_THEME_ID)
    tokens/                    # reserved; CSS tokens live in theme/tokens.css
    primitives/                # Switch, Button, Input, SegmentedControl
    features/                  # 8 Arc-ported feature shells (SolidJS)
    adapters/                  # pure mappers: OpenCode state → presentation props
    styles/                    # tokens + feature CSS + Phase 2 shell overlay
    motion/
    components/ icons/         # reserved for shared composites
```

Reference Arc React demos (gitignored, not shipped):

```text
.panacode-ref/                 # extracted panacode-arc-ex.zip contents
```

### Theme + tokens

1. **Desktop theme JSON (upstream theme pipeline):** `packages/ui/src/theme/themes/panacode.json`  
   Registered in `packages/ui/src/theme/context.tsx` display names as `panacode: "Panacode"`.
2. **Arc CSS tokens (Panacode-owned):** `packages/panacode-ui/src/theme/tokens.css` imported via `@panacode/ui/styles`.
3. **App default theme:** `packages/app/src/app.tsx` sets `ThemeProvider defaultTheme={PANACODE_THEME_ID}`, document `data-brand="panacode"`, and `<Title>Panacode</Title>`.
4. **Phase 2 chrome overlay:** `packages/panacode-ui/src/styles/shell.css` scopes restyles under `[data-brand="panacode"]` so upstream components keep their contracts while adopting Arc radii, switch pill, surfaces, dialogs, composer, tools, scrollbars.

### Adapter pattern

```text
OpenCode services / session / MCP controllers
                │
                ▼
     packages/panacode-ui/src/adapters/*
                │
                ▼
     packages/panacode-ui/src/features/*
                │
                ▼
     packages/app adapters (thin wiring)
```

App-owned wiring examples:

- `packages/app/src/settings/panacode-mcp-panel.tsx` → MCP settings presentation
- `packages/app/src/session/panacode-permission-adapter.tsx` → Agent Approvals presentation over real permission decide()

### Canonical Switch

Visual source of truth: Arc MCP Servers animated switch, ported to SolidJS + Kobalte:

- Primitive: `packages/panacode-ui/src/primitives/switch.tsx` (`data-component="panacode-switch"`)
- Upstream Kobalte switch (`@opencode/ui/switch`, `data-component="switch"`) is **restyled** by `shell.css` under `[data-brand="panacode"]` so existing call sites pick up the Arc pill without rewriting every import.

Do not introduce a second conflicting switch look.

### Preserved upstream packages

Keep and prefer upstream for:

- `@opencode/core`, `@opencode/server`, `@opencode/client`, `@opencode/session-ui` domain logic
- Diff/review engines (`@pierre/*`), terminal emulator, provider plugins
- Desktop Electron shell logic (branding/productName already Panacode in `packages/desktop`)

Internal package names `@opencode/*` remain for upstream compatibility.

---

## C. Changed-file ownership matrix

| File or directory | Owner | Reason | Upstream conflict risk | Merge guidance |
|---|---|---|---|---|
| `packages/panacode-ui/**` | Panacode-owned | Design system + adapters + feature shells | Low | Keep ours; only sync if intentionally re-porting Arc refs |
| `panacode-docs/**` | Panacode-owned | Maintenance docs | Low | Keep ours; update after merges |
| `script/panacode-ui-ownership-check.ts` | Panacode-owned | Static guard | Low | Keep ours |
| `.panacode-ref/` | External reference | Extracted Arc demos (gitignored) | None | Never commit; never copy React demos into production |
| `packages/ui/src/theme/themes/panacode.json` | Panacode-owned (lives in upstream theme dir) | Theme file required by OpenCode theme loader glob | Medium | Keep file; if upstream changes theme schema, adapt JSON |
| `packages/ui/src/theme/context.tsx` | Shared integration boundary | Added `panacode` display name only | Medium | Re-apply one-line name map if upstream rewrites THEME_NAMES |
| `packages/app/package.json` | Shared integration boundary | Adds `@panacode/ui` dependency | Medium | Preserve dependency when resolving package.json conflicts |
| `packages/app/src/index.css` | Shared integration boundary | Imports `@panacode/ui/styles` | Medium | Keep `@import "@panacode/ui/styles"` |
| `packages/app/src/app.tsx` | Shared integration boundary | Default theme, brand mark, title | High | Re-apply Panacode ThemeProvider/Title/brand hooks after upstream app shell changes |
| `packages/app/src/settings/providers/extensions.tsx` | Shared integration boundary | MCP tab uses `PanacodeMcpPanel` | High | Prefer Panacode panel; port any new upstream MCP row features into the adapter |
| `packages/app/src/settings/workspaces/project-extensions.tsx` | Shared integration boundary | Project MCP tab uses `PanacodeMcpPanel` | High | Keep Panacode panel; preserve plugins/skills/lsps tabs from upstream |
| `packages/app/src/settings/panacode-mcp-panel.tsx` | Panacode-owned | MCP presentation adapter | Low | Keep ours |
| `packages/app/src/session/panacode-permission-adapter.tsx` | Panacode-owned | Approvals presentation adapter | Low | Keep ours |
| `packages/app/src/session/composer/session-composer-region.tsx` | Shared integration boundary | Permission dock → Panacode adapter | High | Preserve adapter wiring; merge new docks/features carefully |
| `packages/session-ui/**` | Upstream-owned | Session domain/UI | High | Prefer CSS overlay / adapters over rewriting; only touch when new hooks needed |
| `packages/desktop/**` | Shared (branding already Panacode) | App identity / packaging | High | Keep Panacode appId/productName; take upstream Electron fixes |
| `bun.lock` | Generated | Lockfile | Medium | Regenerate after resolving package.json |
| `release/desktop/*.exe` | Generated output | Installers | None | Do not commit binaries |

Classification reminder: modifying an upstream file does **not** make it Panacode-owned. Prefer moving presentation into `@panacode/ui` when a touch becomes large.

---

## D. Component replacement map

| Feature | Upstream surface | Panacode feature | Adapter | App wiring | Contracts preserved |
|---|---|---|---|---|---|
| AI Chat | `packages/app/src/session/timeline/*`, `packages/session-ui/src/message/*`, `timeline/*` | `features/ai-chat` | `adapters/ai-chat.ts` | CSS shell + feature shell ready; timeline still drives real messages | Streaming, markdown, restore |
| AI Composer | `packages/app/src/session/composer/*`, `packages/app/src/composer/*` | `features/ai-composer` | `adapters/ai-composer.ts` | Shell CSS on composer chrome; controllers unchanged | Submit/stop, drafts, model slot |
| Agent Run | `session/timeline`, `session-ui/tools` | `features/agent-run` | `adapters/agent-run.ts` | Status mapper + CSS | Real execution events |
| Agent Orchestrator | subagent bars / session UI | `features/agent-orchestrator` | `adapters/agent-orchestrator.ts` | Lane mapper for delegated work | Existing task graph only |
| Agent Approvals | `session/requests/session-permission-dock.tsx` | `features/agent-approvals` | `adapters/agent-approvals.ts` | `panacode-permission-adapter.tsx` in composer region | once / always / reject |
| Tool Call | `session-ui/src/tools/*` | `features/tool-call` | `adapters/tool-call.ts` | Shell CSS on `tool-part-wrapper` | Args/output/errors/status |
| Code Suggestion | `gui-plugins/review`, session review | `features/code-suggestion` | `adapters/code-suggestion.ts` | Shell CSS; Pierre engine untouched | Diff + review actions |
| MCP Servers | `settings/providers/extensions.tsx` MCP tab | `features/mcp-servers` + Switch primitive | `adapters/mcp-servers.ts` | `panacode-mcp-panel.tsx` | Toggle, auth, DialogMcp, real registry |
| Switch (global) | `@opencode/ui/switch` | primitive + shell CSS bridge | — | Brand-scoped CSS | Kobalte a11y / focus / disabled |

External deps of `@panacode/ui`: `@kobalte/core`, `@opencode/ui` (workspace), `solid-js` peer. **No React.**

Tests:

- `packages/panacode-ui/src/adapters/mcp-servers.test.ts`
- `bun script/panacode-ui-ownership-check.ts`

---

## E. Step-by-step upstream update procedure

Use a dedicated integration branch. Prefer merge (`--no-ff`) onto shared branches so history stays traceable. Do not force-push protected branches.

```bash
# 0) Clean tree
git status
# stash or commit local work first

# 1) Remotes
git remote -v
# ensure origin=panacode fork, upstream=anomalyco/opencode
git fetch origin
git fetch upstream

# 2) Inspect what is coming
git log --oneline --left-right HEAD...upstream/dev | head -100
git diff --stat HEAD...upstream/dev | head -200

# 3) Highlight high-risk Panacode touch points
git diff --name-only HEAD...upstream/dev | \
  rg 'packages/app/src/app\.tsx|packages/app/src/index\.css|packages/app/src/settings/providers/extensions\.tsx|packages/app/src/session/composer/session-composer-region\.tsx|packages/ui/src/theme/context\.tsx|packages/session-ui|packages/desktop|package\.json|bun\.lock'

# 4) Integration branch (date in America/Los_Angeles or UTC — record which)
git switch -c integration/upstream-$(date -u +%Y%m%d) origin/master
# or from your current Panacode stable tip

# 5) Merge
git merge --no-ff upstream/dev

# 6) Resolve conflicts using section F (never blanket ours/theirs)

# 7) Install + checks
bun install
bun script/panacode-ui-ownership-check.ts
bun --cwd packages/panacode-ui test
bun --cwd packages/panacode-ui typecheck
# then broader suite as needed:
# bun --cwd packages/app test
# bun typecheck

# 8) Manual UI checklist (sections H–I)

# 9) Update this document: baseline SHA, date, known risks

# 10) Merge integration branch into Panacode stable via PR
```

Before merging, review the upstream PR/commit list for new UI surfaces (section G).

---

## F. Conflict resolution playbook

**Never** use a blanket “always keep ours” or “always take theirs.”

Target outcome: **new upstream functionality + preserved Panacode visual identity.**

| Area | Prefer Panacode presentation when… | Prefer upstream when… | Adapter action |
|---|---|---|---|
| Application shell (`app.tsx`) | Theme default, Title, `data-brand` | New providers/error boundaries/routing | Re-insert brand hooks after accepting upstream structure |
| Shared UI (`@opencode/ui`) | Token/theme name map for `panacode` | New primitives/APIs | Extend shell.css; avoid forking whole components |
| Session UI / timeline | Message chrome styling | New part types, virtualizer, streaming fixes | Map new parts through adapters; CSS for chrome |
| Composer | Arc radii/actions styling | Submit lifecycle, mentions, slash commands | Keep controllers; restyle or wrap chrome |
| Agent timeline / tools | Tool card chrome | Tool schemas, execution status machine | Update `toToolCallStatus` / CSS |
| Permissions | AgentApprovals labels/layout | New permission kinds / decide() API | Update `panacode-permission-adapter` |
| MCP settings | `PanacodeMcpPanel` list chrome | New auth flows, server fields | Extend `toMcpServerViews` + panel actions |
| Code review | Suggestion header/mode control | Diff engine / review protocol | Keep Pierre; wrap presentation |
| Desktop packaging | `ai.panacode.*` appId, productName | Electron security/updater fixes | Merge code; keep identity constants |
| `package.json` / lockfiles | `@panacode/ui` workspace dep | Upstream version bumps | Combine both; regenerate lockfile |
| Generated files | — | Regenerate | Do not hand-merge binaries |

If an upstream change rewrites a file Panacode only lightly touched, accept upstream then re-apply the small integration hunks listed in section C.

---

## G. New upstream feature policy

When OpenCode adds a screen, control, or setting:

1. Ship the **functionality** immediately (do not block on perfect visuals).
2. Style it through existing Panacode primitives / `shell.css` / theme tokens.
3. If no primitive fits, add one under `packages/panacode-ui/src/primitives` (not a one-off in the feature).
4. Add or extend an adapter if props need mapping.
5. Add tests for adapters / ownership check updates.
6. Update this component map (section D).

Do **not** paste raw upstream JSX chrome into Panacode-owned feature folders without adaptation.  
Do **not** embed the React Arc demos or add `react` / `react-dom` to `packages/app`.

---

## H. Regression testing checklist

Commands (from repo root `/` of the panacode checkout):

```bash
bun script/panacode-ui-ownership-check.ts
bun --cwd packages/panacode-ui test
bun --cwd packages/panacode-ui typecheck
bun --cwd packages/app typecheck   # when environment allows
bun --cwd packages/desktop test   # packaging identity tests
```

Manual / product:

- [ ] Desktop startup (splash shows Panacode)
- [ ] Session create / restore
- [ ] Streaming assistant responses
- [ ] Composer send / stop / draft persistence
- [ ] Model selection
- [ ] Agent execution + cancellation
- [ ] Tool calls expand/collapse + errors
- [ ] Permission once / always / reject
- [ ] MCP toggle, connect/auth, DialogMcp
- [ ] Code review / diffs
- [ ] File explorer operations
- [ ] Terminal PTY input/ANSI
- [ ] Browser tab chrome (if used)
- [ ] SSH / WSL where supported
- [ ] Settings persistence (including theme = Panacode)
- [ ] Light and dark schemes under Panacode theme
- [ ] Keyboard shortcuts
- [ ] Desktop packaging identity (`ai.panacode.desktop*`)
- [ ] Updater channel does **not** silently install stock OpenCode builds

Platform notes: Windows NSIS installers live under `release/desktop/` (generated; not source of truth). Linux metainfo generation uses Panacode appIds in `packages/desktop/script/copy-metainfo.ts`.

---

## I. Visual regression checklist

Under `[data-brand="panacode"]` and theme `panacode`:

- [ ] Switch pill (42×24) matches Arc MCP reference; reduced-motion respected
- [ ] Buttons / inputs / dialogs / popovers / menus / tabs use Arc radii
- [ ] Sidebar + settings headers use muted surfaces
- [ ] Composer card elevation + radius
- [ ] Tool cards + permission dock actions
- [ ] MCP Servers panel search + rows
- [ ] Loading indicators / toasts still readable
- [ ] Light and dark modes
- [ ] No leftover OpenCode wordmark in app-controlled chrome (Title = Panacode)

Prefer existing Storybook / screenshot infrastructure when present; do not invent a second visual test stack.

---

## J. Rollback and recovery

| Situation | Safe action |
|---|---|
| Merge in progress, conflicts unmanageable | `git merge --abort` |
| Validation failed on integration branch | Fix forward on the branch, or reset soft to pre-merge commit **only if unpublished** |
| Integration already merged to stable | `git revert -m 1 <merge_commit>` (preserves history) |
| Need known-good desktop binary | Reinstall previous `release/desktop` artifact / prior GitHub Release; do not `git reset --hard` shared branches |
| Uncommitted work during incident | `git stash push -u -m "wip before recovery"` |
| Broken theme only | Set theme back via UI or clear theme storage key; confirm `panacode.json` still loads |

Prefer non-destructive recovery. Destructive resets are last resort and never the default on shared branches.

---

## K. Future AI agent instructions

1. Read **this file** before changing UI or merging upstream.
2. Identify ownership (section C) before editing. Prefer `packages/panacode-ui` for presentation.
3. Keep application logic in OpenCode services; use adapters for props only.
4. Minimize edits to upstream-owned files; document every unavoidable touch here.
5. Do not duplicate Switch/Button/Input — extend primitives.
6. Preserve Panacode visual identity (`data-brand="panacode"`, theme id `panacode`).
7. Run ownership check + adapter tests + relevant package tests.
8. Update sections A, C, D, L whenever integration boundaries change.
9. Never commit `.panacode-ref/` or React demo apps into production packages.
10. Never weaken permission semantics to simplify UI.

---

## L. Known risks and limitations

- **High-risk files:** `packages/app/src/app.tsx`, session composer region, settings extensions, theme context, desktop builder config. Upstream refactors here will conflict.
- **Shell CSS selectors** (`[data-component=…]`) can drift if upstream renames data attributes — treat as soft coupling; fix selectors deliberately.
- **Shallow or partial ports:** AI Chat / Composer / Tool Call feature shells exist for composition; much session chrome still renders via upstream components + Phase 2 CSS overlay. Full DOM replacement of virtualized timelines remains intentionally incomplete to avoid forking the session engine.
- **Upstream tip drift:** At redesign time, Panacode tip `5c198b8…` and `upstream/dev` `a0fdbf9…` already differ; the next integration must triage that range.
- **Release channel:** Panacode must not consume OpenCode production update feeds. Packaging identity is Panacode; confirm updater endpoints on each release.
- **No conflict-free guarantee:** Large upstream architectural changes can still require multi-day conflict resolution. This architecture reduces surface area and makes conflicts understandable; it does not eliminate them.
- **Unverified in this agent environment:** full desktop GUI smoke, Windows NSIS install, SSH/WSL, and broad `bun typecheck` across the monorepo may be incomplete depending on VM resources — re-run section H before shipping.

---

## Ownership guard

```bash
bun script/panacode-ui-ownership-check.ts
```

Fails if `@panacode/ui` is missing from the app, React demo deps leak into `packages/app`, brand/theme hooks are removed, or this guide / design package files disappear.
