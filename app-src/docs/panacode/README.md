# Panacode install (isolated from OpenCode)

Isolation landed on the Panacode fork:

- Branch: [`cursor/panacode-install-isolate-58f9`](https://github.com/arashmakkyy/panacode/tree/cursor/panacode-install-isolate-58f9)
- Compare / open PR (needs write on that repo):  
  https://github.com/arashmakkyy/panacode/compare/cursor/panaai-browser-connect-58f9...cursor/panacode-install-isolate-58f9

## Install

```bash
git clone -b cursor/panacode-install-isolate-58f9 https://github.com/arashmakkyy/panacode.git
cd panacode
curl -fsSL https://bun.sh/install | bash && source ~/.bashrc   # once
bun install
bun run script/install-local.ts
# → ~/.panacode/bin/panacode
export PATH="$HOME/.panacode/bin:$PATH"
panacode --version
```

Or from a built binary:

```bash
./install --binary ./packages/cli/dist/cli-linux-x64/bin/panacode
```

## Isolation (verified)

| | OpenCode | Panacode |
|---|---|---|
| Binary | `~/.opencode/bin/opencode` | `~/.panacode/bin/panacode` |
| XDG / project config | `…/opencode`, `.opencode/` | `…/panacode`, `.panacode/` |
| Env | `OPENCODE_*` | Prefer `PANACODE_*` |

Sign in with PanaAI: `https://panaai-psi.vercel.app/connect/panacode` (PanaAI connect APIs are on master).

## Files in this folder

- `INSTALL.md` — short binary copy steps
- `install-panacode` / `isolate-from-opencode.patch` — earlier local helpers; prefer the fork branch above
