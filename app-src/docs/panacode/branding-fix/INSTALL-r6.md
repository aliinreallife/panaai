# Install Panacode (Windows desktop)

1. Download: https://github.com/arashmakkyy/panacode/releases/download/panacode-desktop-win-x64-r6/panacode-desktop-win-x64.exe
2. Run the NSIS installer (product **Panacode**, app id `ai.panacode.desktop`).
3. Open Panacode → Sign in with PanaAI.

**r6** restores full Panacode branding (splash, wordmark, icons, menus, About) on top of the UI redesign and r4/r5 CLI/desktop fixes.

If upgrading: quit Panacode, delete `%USERPROFILE%\.local\state\panacode\service*.json` if a prior build hung, then install r6.

SHA256: see the `.sha256` asset next to the installer on the release page.
