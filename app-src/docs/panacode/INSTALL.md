# Install Panacode CLI

These binaries are built from the Panacode fork (PanaAI-only). They use XDG app name `panacode` and install under `~/.panacode` — they do **not** write OpenCode’s `~/.opencode`.

## Linux / macOS

```bash
mkdir -p ~/.panacode/bin
# pick your platform binary, e.g. panacode-linux-x64
cp panacode-linux-x64 ~/.panacode/bin/panacode
chmod +x ~/.panacode/bin/panacode
echo 'export PATH="$HOME/.panacode/bin:$PATH"' >> ~/.bashrc
echo 'export PANACODE_APP_DIR=panacode' >> ~/.bashrc
source ~/.bashrc
panacode --help
```

Or from the repo:

```bash
./install-panacode --binary ./packages/cli/dist/cli-linux-x64/bin/opencode
```

## Windows

Copy `panacode-windows-x64.exe` to `%USERPROFILE%\.panacode\bin\panacode.exe` and add that folder to PATH.

## Sign in

Connect uses https://panaai-psi.vercel.app (`/connect/panacode`).
