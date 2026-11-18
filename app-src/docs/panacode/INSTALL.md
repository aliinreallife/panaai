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

If a previous build stuck on the loading screen (or you see `Timed out waiting for the background service to start`):

1. Quit Panacode completely (Task Manager → end `Panacode.exe` / `panacode-cli.exe` if needed).
2. Delete everything matching `%USERPROFILE%\.local\state\panacode\service*.json`.
3. Install the latest release build and relaunch.

If chat fails with `Cannot find package '@opencode/ai'` for a `panaai/...` model, install **r4+** (the CLI must embed the panaai provider).

Release notes:

- **r3** — fixed `service.json` vs `service-<channel>.json` so the desktop finds the background CLI.
- **r4** — embeds `@opencode/ai/providers/panaai` in the bundled CLI so PanaAI models initialize for chat.

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

Connect URL (hosted demo): https://panaai-psi.vercel.app/connect/panacode

### Self-hosted PanaAI (no Vercel)

Run the Next.js app from `app-src` on any Node VPS with its **own local Postgres** (`docker compose up -d db`) — see **`docs/DEPLOY.md` §3**.

After you confirm the API key on `/connect/panacode`, the browser navigates to `http://127.0.0.1:<port>/callback` so Panacode finishes the exchange and comes to the front. Keep Panacode open while you authorize.

To point a stock desktop build at your server without rebuilding: set panaai provider `baseURL` to `https://your-domain/v1` and paste a `pana-…` key. Browser “Sign in with PanaAI” still uses the baked-in auth host until you rebuild Panacode with your `authURL` / `baseURL`.
