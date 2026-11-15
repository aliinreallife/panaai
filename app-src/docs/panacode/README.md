# Panacode install (isolated from OpenCode)

## Quick install from the Panacode fork

```bash
git clone -b cursor/panaai-browser-connect-58f9 https://github.com/arashmakkyy/panacode.git
cd panacode
# apply isolation if not yet on the install branch:
# git apply path/to/isolate-from-opencode.patch
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
./install-panacode --from-source
panacode --help
```

## What isolation means

| | OpenCode | Panacode |
|---|---|---|
| Binary | `~/.opencode/bin/opencode` | `~/.panacode/bin/panacode` |
| XDG app | `…/opencode` | `…/panacode` |
| Config env | `OPENCODE_CONFIG_DIR` | `PANACODE_CONFIG_DIR` |

Verified: starting Panacode creates `~/.config/panacode` etc. and does **not** create `~/.opencode`.

## PanaAI connect

Uses `https://panaai-psi.vercel.app/connect/panacode` (merged on PanaAI master).
