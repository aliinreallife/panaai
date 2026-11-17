# Install Panacode

Panacode is the PanaAI-branded OpenCode fork. Builds store config/history under `~/.panacode` (Windows: `%APPDATA%\ai.panacode.desktop*`) and never write OpenCode’s `~/.opencode` / `ai.opencode.desktop*`.

Artifacts live in the panacode repo `release/` (CLI) and `release/desktop/` (Windows installer) when built from `cursor/panacode-windows-desktop-58f9` (or later).

## Windows desktop (recommended)

1. Download the NSIS installer:  
   https://github.com/aliinreallife/panaai/releases/download/panacode-desktop-win-x64/panacode-desktop-win-x64.exe  
   (release page: https://github.com/aliinreallife/panaai/releases/tag/panacode-desktop-win-x64)
2. Run it — product name **Panacode**, app id `ai.panacode.desktop` (separate from OpenCode).
3. Open Panacode → **Sign in with PanaAI** (https://panaai-psi.vercel.app/connect/panacode).

Unsigned builds may trigger SmartScreen — More info → Run anyway.

If a previous build stuck on the loading screen: quit Panacode, delete `%USERPROFILE%\.local\state\panacode\service.json` (and any `service-*.json` next to it), then reinstall/relaunch.

Build from the panacode repo (Linux host needs `wine` + `wine32`):

```bash
OPENCODE_TARGET=windows-x64 OPENCODE_CHANNEL=prod bun run --cwd packages/desktop build
OPENCODE_TARGET=windows-x64 OPENCODE_CHANNEL=prod bun run --cwd packages/desktop pack
# → dist/desktop/panacode-desktop-win-x64.exe
```

## CLI — Linux / macOS

```bash
mkdir -p ~/.panacode/bin
cp panacode-linux-x64 ~/.panacode/bin/panacode   # or darwin-*
chmod +x ~/.panacode/bin/panacode
echo 'export PATH="$HOME/.panacode/bin:$PATH"' >> ~/.bashrc
echo 'export PANACODE_APP_DIR=panacode' >> ~/.bashrc
source ~/.bashrc
panacode --help
```

Or: `./install-panacode --binary ./packages/cli/dist/cli-linux-x64/bin/panacode`

## CLI — Windows

Copy `panacode-windows-x64.exe` to `%USERPROFILE%\.panacode\bin\panacode.exe` and add that folder to PATH.

## Sign in

Connect URL: https://panaai-psi.vercel.app/connect/panacode
