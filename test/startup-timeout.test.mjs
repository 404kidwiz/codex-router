import assert from "node:assert/strict";
import test from "node:test";

import {
  runtimeChildEnvironment,
  serviceStartupTimeoutEnvironment,
  startupTimeoutMs,
} from "../src/startup-timeout.mjs";

test("runtime children never inherit the supervisor's startup ACL allowance", () => {
  const env = {
    CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS: "900000",
    CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS: "300000",
    PATH: "test-path",
  };
  assert.deepEqual(runtimeChildEnvironment(env), {
    CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS: "300000",
    PATH: "test-path",
  });
  assert.equal(env.CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS, "900000");
});

test("an unset variable keeps the shipped default", () => {
  assert.equal(startupTimeoutMs("CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS", 15_000, {}), 15_000);
});

test("valid decimal integer overrides stay within their per-setting startup bound", () => {
  for (const [name, value] of [
    ["CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS", "300000"],
    ["CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS", "300000"],
    ["CODEX_ROUTER_WINDOWS_PROCESS_PROBE_TIMEOUT_MS", "900000"],
    ["CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS", "900000"],
    ["CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS", "300000"],
    ["CODEX_ROUTER_GATEWAY_HEALTH_TIMEOUT_MS", "900000"],
  ]) {
    assert.equal(startupTimeoutMs(name, 5_000, { [name]: value }), Number(value), name);
  }
});

test("malformed, fractional, and out-of-bound overrides keep the shipped default", () => {
  for (const raw of [
    "",
    "   ",
    "fast",
    "-1",
    "0",
    "12ms",
    "1.5",
    "300001",
    "900001",
    "Infinity",
  ]) {
    assert.equal(
      startupTimeoutMs("CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS", 5_000, {
        CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS: raw,
      }),
      5_000,
      `raw=${JSON.stringify(raw)}`,
    );
  }
  assert.equal(
    startupTimeoutMs("CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS", 5_000, {
      CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS: "900000",
    }),
    5_000,
    "startup health retains its tighter 300-second ceiling",
  );
});

test("service startup settings include only explicitly supplied valid overrides", () => {
  assert.deepEqual(serviceStartupTimeoutEnvironment({}), {});
  assert.deepEqual(
    serviceStartupTimeoutEnvironment({
      CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS: "300000",
      CODEX_ROUTER_WINDOWS_PROCESS_PROBE_TIMEOUT_MS: "900000",
      CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS: "12ms",
      CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS: "900000",
      CODEX_ROUTER_UNKNOWN_TIMEOUT_MS: "300000",
    }),
    {
      CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS: "300000",
      CODEX_ROUTER_WINDOWS_PROCESS_PROBE_TIMEOUT_MS: "900000",
    },
  );
});

test("explicit caller options still win over the environment", async () => {
  const { venvRuntimeProblem } = await import("../src/venv-runtime.mjs");
  const timeouts = [];
  let calls = 0;
  const spawn = (_python, _args, { timeout }) => {
    timeouts.push(timeout);
    calls += 1;
    if (calls % 2 === 1) {
      return {
        error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }),
        status: null,
        stderr: "",
        stdout: "",
      };
    }
    return { error: undefined, status: 0, stderr: "", stdout: "/venv\n" };
  };
  const originalTimeout = process.env.CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS;
  const originalRetry = process.env.CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS;
  process.env.CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS = "120000";
  process.env.CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS = "300000";
  try {
    assert.equal(venvRuntimeProblem("python", { spawn }), undefined);
    assert.deepEqual(timeouts, [120_000, 300_000]);
    timeouts.length = 0;
    assert.equal(
      venvRuntimeProblem("python", { spawn, timeoutMs: 5_000, retryTimeoutMs: 7_000 }),
      undefined,
    );
    assert.deepEqual(timeouts, [5_000, 7_000]);
  } finally {
    if (originalTimeout === undefined) delete process.env.CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS;
    else process.env.CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS = originalTimeout;
    if (originalRetry === undefined) delete process.env.CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS;
    else process.env.CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS = originalRetry;
  }
});
