# Panacode Windows desktop r7

## Fixes
- Splash / error brand text: selectable, high-contrast (no black-on-black)
- Error log TextField: no white-on-white (force transparent textarea + seeded theme ink)
- Background service timeout on Windows: match CLI `service-<channel>.json`, port `28894`, longer health probes

## Apply on arashmakkyy/panacode
```bash
git checkout cursor/panacode-ui-redesign-58f9
git checkout -b cursor/panacode-splash-contrast-58f9
git apply panacode-docs/panacode-r7-splash-contrast.patch
```

Installer is built locally at `panacode/dist/desktop/panacode-desktop-win-x64.exe` pending upload to GitHub release `panacode-desktop-win-x64-r7`.
