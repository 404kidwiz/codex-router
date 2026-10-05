// Startup-only timeout allowances for slow hosts (for example a VDI whose
// Task Scheduler ancestry adds ~60 s of process-start latency per level).
//
// Each knob is optional: an absent, blank, or non-positive value keeps the
// shipped default, so behavior is unchanged unless an operator sets one.
// These knobs cover process-start and boot-health waits only — never API
// request, inference, retry, gateway-liveness, or steady-state timeouts.
export function startupTimeoutMs(name, fallbackMs, env = process.env) {
  const raw = env?.[name];
  if (raw === undefined || raw === null) return fallbackMs;
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallbackMs;
  return parsed;
}

export function runtimeChildEnvironment(env) {
  const { CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS: _startupAclTimeout, ...runtime } = env;
  return runtime;
}
