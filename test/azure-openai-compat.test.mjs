import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAzureOpenAIResponsesRequest } from "../src/azure-openai-compat.mjs";

const AZURE = { providerId: "azure-kmamc", route: "/responses" };

function toolsOf(payload) {
  return payload.tools.map((tool) => tool.type + (tool.name ? ":" + tool.name : ""));
}

test("A: azure-kmamc + /responses removes image_gen namespace while unrelated tools remain", () => {
  const collaboration = { type: "namespace", name: "collaboration", description: "spawn helpers" };
  const shell = { type: "function", name: "shell", description: "run commands" };
  const appThread = { type: "function", name: "codex_app__create_thread" };
  const payload = {
    model: "gpt-5.6-sol",
    input: "hello",
    tools: [
      { type: "namespace", name: "image_gen" },
      collaboration,
      shell,
      appThread,
      { type: "function", name: "my_tool" },
    ],
  };
  const result = normalizeAzureOpenAIResponsesRequest(payload, AZURE);
  assert.equal(result, payload);
  assert.deepEqual(toolsOf(result), [
    "namespace:collaboration",
    "function:shell",
    "function:codex_app__create_thread",
    "function:my_tool",
  ]);
});

test("B: other providers are untouched", () => {
  const payload = {
    model: "gpt-5",
    tools: [{ type: "image_generation" }, { type: "namespace", name: "image_gen" }],
  };
  const before = structuredClone(payload);
  const result = normalizeAzureOpenAIResponsesRequest(payload, {
    providerId: "openai",
    route: "/responses",
  });
  assert.equal(result, payload);
  assert.deepEqual(payload, before);
});

test("C: other Azure namespaces are untouched", () => {
  const payload = {
    model: "gpt-5.6-sol",
    tools: [
      { type: "namespace", name: "collaboration" },
      { type: "namespace", name: "shell_tools" },
      { type: "function", name: "codex_app__wait_threads" },
    ],
  };
  const before = structuredClone(payload);
  const result = normalizeAzureOpenAIResponsesRequest(payload, AZURE);
  assert.equal(result, payload);
  assert.deepEqual(payload, before);
});

test("D: flat image_generation and both function-name forms are removed only on azure-kmamc /responses", () => {
  const mixed = () => ({
    model: "gpt-5.6-luna",
    tools: [
      { type: "image_generation" },
      { type: "function", name: "image_gen.imagegen" },
      { type: "function", name: "image_gen__imagegen" },
      { type: "function", name: "image_gen.other" },
      { type: "function", name: "keep_me" },
    ],
  });

  const azure = mixed();
  normalizeAzureOpenAIResponsesRequest(azure, AZURE);
  assert.deepEqual(
    azure.tools.map((tool) => tool.name ?? tool.type),
    ["image_gen.other", "keep_me"],
  );

  // Same payload on another route is untouched.
  const otherRoute = mixed();
  const beforeRoute = structuredClone(otherRoute);
  normalizeAzureOpenAIResponsesRequest(otherRoute, { providerId: "azure-kmamc", route: "/chat/completions" });
  assert.deepEqual(otherRoute, beforeRoute);

  // Same payload on another provider is untouched.
  const otherProvider = mixed();
  const beforeProvider = structuredClone(otherProvider);
  normalizeAzureOpenAIResponsesRequest(otherProvider, { providerId: "openai", route: "/responses" });
  assert.deepEqual(otherProvider, beforeProvider);
});

test("payloads without tools are returned unchanged", () => {
  const payload = { model: "gpt-5.6-sol", input: "hi" };
  assert.equal(normalizeAzureOpenAIResponsesRequest(payload, AZURE), payload);
  assert.equal(normalizeAzureOpenAIResponsesRequest(undefined, AZURE), undefined);
});
