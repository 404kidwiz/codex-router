- **`codex-router.ps1 start --foreground` runs again on Windows.** Since the
  foreground path started entering through `src/foreground-start.mjs`, it
  failed at once on every install with a working LiteLLM environment: "The
  Windows service could not verify its own start.mjs process identity; refusing
  to run without a stoppable process record." That record is how the Windows
  service manager stops the tree it launched, and it only accepts a command
  line that names `src/start.mjs`. The foreground supervisor is the explicit
  unmanaged debugging path, so it no longer claims the record, and
  `codex-router.ps1 stop` leaves it alone as `bin/stop` does on macOS and
  Linux. The logon task's direct `src/start.mjs` still records itself and
  still refuses to run without it.
