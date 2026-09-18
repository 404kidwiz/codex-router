import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { MODELS } from "../src/model-registry.mjs";
import { renderLiteLlmConfig } from "../src/litellm-config.mjs";

// Regression: Azure TPM 429s mid-stream close the SSE without
// response.completed (Codex: "stream closed before response.completed",
// 5x reconnect). LiteLLM must not retry the same exhausted deployment and
// amplify TPM pressure/cost; Codex owns retries. Mirrors the zai-coding
// precedent in the same file.
test("azure-kmamc model groups disable LiteLLM rate-limit retries", () => {
  const rendered = renderLiteLlmConfig();
  const azure = MODELS.filter(({ provider }) => provider === "azure-kmamc");
  // On machines with curated azure-kmamc models (e.g. VDI), each gateway
  // group must be single-shot on rate-limits.
  for (const model of azure) {
    assert.match(
      rendered,
      new RegExp(`${model.gatewayModel}:\\n\\s+RateLimitErrorRetries: 0`),
      model.slug,
    );
  }
  // The filter must name azure-kmamc so future/CI builds without a local
  // user overlay still carry the policy once curated.
  const source = readFileSync(
    new URL("../src/litellm-config.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /provider === "azure-kmamc"/);
});

test("zai-coding precedent still holds", () => {
  const rendered = renderLiteLlmConfig();
  for (const model of MODELS.filter(({ provider }) => provider === "zai-coding")) {
    assert.match(
      rendered,
      new RegExp(`${model.gatewayModel}:\\n\\s+RateLimitErrorRetries: 0`),
      model.slug,
    );
  }
});
