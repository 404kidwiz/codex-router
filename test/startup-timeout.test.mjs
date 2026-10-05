import assert from "node:assert/strict";
import test from "node:test";

import { startupTimeoutMs } from "../src/startup-timeout.mjs";

test("an unset variable keeps the shipped default", () => {
  assert.equal(startupTimeoutMs("CODEX_ROUTER_TEST_TIMEOUT_MISSING", 5_000, {}), 5_000);
});

test("a valid value overrides the default", () => {
  assert.equal(
    startupTimeoutMs("CODEX_ROUTER_TEST_TIMEOUT_MS", 5_000, { CODEX_ROUTER_TEST_TIMEOUT_MS: "300000" }),
    300_000,
  );
});

test("blank, non-numeric, and non-positive values fall back to the default", () => {
  for (const raw of ["", "   ", "fast", "-1", "0"]) {
    assert.equal(
      startupTimeoutMs("CODEX_ROUTER_TEST_TIMEOUT_MS", 5_000, { CODEX_ROUTER_TEST_TIMEOUT_MS: raw }),
      5_000,
      `raw=${JSON.stringify(raw)}`,
    );
  }
  // parseInt semantics: a leading-numeric value is honored as its integer part.
  assert.equal(
    startupTimeoutMs("CODEX_ROUTER_TEST_TIMEOUT_MS", 5_000, { CODEX_ROUTER_TEST_TIMEOUT_MS: "12ms" }),
    12,
  );
});

test("explicit caller options still win over the environment", async () => {
  const { venvRuntimeProblem } = await import("../src/venv-runtime.mjs");
  const timeouts = [];
  const spawn = (_python, _args, { timeout }) => {
    timeouts.push(timeout);
    return { error: undefined, status: 0, stderr: "", stdout: "/venv\n" };
  };
  const originalTimeout = process.env.CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS;
  const originalRetry = process.env.CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS;
  process.env.CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS = "300000";
  process.env.CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS = "300000";
  try {
    assert.equal(venvRuntimeProblem("python", { spawn }), undefined);
    assert.deepEqual(timeouts, [300_000]);
    assert.equal(
      venvRuntimeProblem("python", { spawn, timeoutMs: 5_000, retryTimeoutMs: 7_000 }),
      undefined,
    );
    assert.deepEqual(timeouts.slice(1), [5_000]);
  } finally {
    if (originalTimeout === undefined) delete process.env.CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS;
    else process.env.CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS = originalTimeout;
    if (originalRetry === undefined) delete process.env.CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS;
    else process.env.CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS = originalRetry;
  }
});
