import assert from "node:assert/strict";
import { once } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";

import { normalizeAzureOpenAIResponsesRequest } from "../src/azure-openai-compat.mjs";
import {
  createResponsesJsonTransform,
  createResponsesStreamTransform,
} from "../src/openai-adapters.mjs";
import { injectSessionModelForSpawnCalls } from "../src/namespace-relay.mjs";

const AZURE = { providerId: "azure-kmamc", route: "/responses" };

function toolsOf(payload) {
  return payload.tools.map((tool) => tool.type + (tool.name ? ":" + tool.name : ""));
}

test("A: Azure removes image_gen and translates collaboration while unrelated tools remain", () => {
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
    "namespace:agents",
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

test("C: only the Azure collaboration namespace changes", () => {
  const payload = {
    model: "gpt-5.6-sol",
    tools: [
      { type: "namespace", name: "collaboration" },
      { type: "namespace", name: "shell_tools" },
      { type: "function", name: "codex_app__wait_threads" },
    ],
  };
  const result = normalizeAzureOpenAIResponsesRequest(payload, AZURE);
  assert.equal(result, payload);
  assert.deepEqual(payload.tools.map((tool) => tool.name), [
    "agents", "shell_tools", "codex_app__wait_threads",
  ]);
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

test("Azure translates declared collaboration tools, replayed calls, and tool choice", () => {
  const encrypted = { type: "string", encrypted: true };
  const messageTool = (name) => ({
    type: "function",
    name,
    parameters: {
      type: "object",
      properties: { message: encrypted, target: { type: "string" } },
    },
  });
  const unrelated = { type: "function", name: "unrelated", parameters: { encrypted: true } };
  const payload = {
    tools: [
      { type: "namespace", name: "collaboration", tools: [
        messageTool("spawn_agent"),
        messageTool("send_message"),
        messageTool("followup_task"),
        { type: "function", name: "wait_agent", parameters: { encrypted: true } },
      ] },
      { type: "function", name: "collaboration__interrupt_agent" },
      unrelated,
    ],
    input: [
      { type: "function_call", namespace: "collaboration", name: "spawn_agent", call_id: "a", arguments: "{}" },
      { type: "function_call_output", call_id: "a", output: "done" },
      { type: "function_call", name: "collaboration__wait_agent", call_id: "b", arguments: "{}" },
    ],
    tool_choice: { type: "allowed_tools", tools: [
      { type: "function", namespace: "collaboration", name: "spawn_agent" },
      { type: "function", name: "collaboration__wait_agent" },
    ] },
  };
  normalizeAzureOpenAIResponsesRequest(payload, AZURE);
  assert.equal(payload.tools[0].name, "agents");
  assert.equal(payload.tools[0].tools[0].parameters.properties.message.encrypted, undefined);
  assert.equal(payload.tools[0].tools[1].parameters.properties.message.encrypted, undefined);
  assert.equal(payload.tools[0].tools[2].parameters.properties.message.encrypted, undefined);
  assert.equal(payload.tools[0].tools[3].parameters.encrypted, true);
  assert.equal(payload.tools[1].name, "agents__interrupt_agent");
  assert.equal(payload.tools[2], unrelated);
  assert.deepEqual(payload.input.map((item) => [item.namespace, item.name, item.call_id]), [
    ["agents", "spawn_agent", "a"],
    [undefined, undefined, "a"],
    [undefined, "agents__wait_agent", "b"],
  ]);
  assert.deepEqual(payload.tool_choice.tools, [
    { type: "function", namespace: "agents", name: "spawn_agent" },
    { type: "function", name: "agents__wait_agent" },
  ]);
});

test("Azure refuses a collaboration/agents declaration collision before mutation", () => {
  const payload = {
    tools: [
      { type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent" }] },
      { type: "namespace", name: "agents", tools: [{ type: "function", name: "other" }] },
    ],
    input: [{ type: "function_call", namespace: "collaboration", name: "spawn_agent", call_id: "a", arguments: "{}" }],
  };
  const original = structuredClone(payload);
  assert.throws(
    () => normalizeAzureOpenAIResponsesRequest(payload, AZURE),
    (error) => error.status === 400 && /collision/i.test(error.message),
  );
  assert.deepEqual(payload, original);
});

test("Azure does not translate history without a declared collaboration tool", () => {
  const payload = {
    tools: [{ type: "namespace", name: "other", tools: [] }],
    input: [{ type: "function_call", namespace: "collaboration", name: "spawn_agent", call_id: "a", arguments: "{}" }],
  };
  const original = structuredClone(payload);
  assert.equal(normalizeAzureOpenAIResponsesRequest(payload, AZURE), payload);
  assert.deepEqual(payload, original);
});

test("Azure omits an unrequested spawn model while preserving explicit and local-thread models", () => {
  const session = { model: "azure-kmamc/gpt-6-sol", preserveDefaultSubagentModel: true };
  const spawn = { type: "function_call", namespace: "collaboration", name: "spawn_agent", arguments: '{"message":"hi"}' };
  const explicit = { ...spawn, arguments: '{"model":"azure-kmamc/gpt-6-luna","message":"hi"}' };
  const thread = { type: "function_call", namespace: "codex_app", name: "create_thread",
    arguments: '{"prompt":"hi","target":{"type":"projectless"}}' };
  assert.equal(injectSessionModelForSpawnCalls(spawn, session), spawn);
  assert.equal(injectSessionModelForSpawnCalls(explicit, session), explicit);
  assert.equal(
    JSON.parse(injectSessionModelForSpawnCalls(thread, session).arguments).model,
    session.model,
  );
  assert.equal(
    JSON.parse(injectSessionModelForSpawnCalls(spawn, session.model).arguments).model,
    session.model,
    "other providers retain parent-model injection",
  );
});

async function transformed(transform, chunks) {
  const result = [];
  transform.on("data", (chunk) => result.push(Buffer.from(chunk)));
  Readable.from(chunks).pipe(transform);
  await once(transform, "end");
  return Buffer.concat(result).toString("utf8");
}

const collaborationLookup = new Map([
  ["agents__spawn_agent", { namespace: "collaboration", name: "spawn_agent", plaintextCollaboration: true }],
  ["agents__send_message", { namespace: "collaboration", name: "send_message", plaintextCollaboration: true }],
]);

test("Azure response restoration marks only verified plaintext messages", async () => {
  const output = [
    { type: "function_call", namespace: "agents", name: "spawn_agent", call_id: "plain",
      arguments: JSON.stringify({ message: "Read harmless marker AZURE_TEST." }) },
    { type: "function_call", name: "agents__send_message", call_id: "opaque",
      arguments: JSON.stringify({ message: "gAAAAABkZmtM7cT9w_XY_zThisIsAnOpaqueBlob==" }) },
    { type: "function_call", namespace: "agents", name: "spawn_agent", call_id: "no-message",
      arguments: JSON.stringify({ task_name: "probe" }) },
  ];
  const response = JSON.parse(await transformed(
    createResponsesJsonTransform(collaborationLookup),
    [JSON.stringify({ id: "resp", output })],
  ));
  for (const item of response.output) {
    assert.equal(item.namespace, "collaboration");
  }
  assert.deepEqual(response.output[0].encrypted_function_args, []);
  assert.equal("encrypted_function_args" in response.output[1], false);
  assert.equal("encrypted_function_args" in response.output[2], false);
});

test("Azure streamed restoration covers added, done, and completed items", async () => {
  const call = { type: "function_call", name: "agents__spawn_agent", call_id: "one",
    arguments: JSON.stringify({ message: "Fresh plaintext task." }) };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
    { type: "response.output_item.done", output_index: 0, item: call },
    { type: "response.completed", response: { id: "resp", output: [call] } },
  ];
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const midpoint = Math.floor(body.length / 2);
  const output = await transformed(createResponsesStreamTransform(collaborationLookup), [
    body.slice(0, midpoint), body.slice(midpoint),
  ]);
  const restored = output.split("\n").filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  assert.equal(restored[0].item.namespace, "collaboration");
  assert.equal(restored[1].item.namespace, "collaboration");
  assert.deepEqual(restored[1].item.encrypted_function_args, []);
  assert.equal(restored[2].response.output[0].namespace, "collaboration");
  assert.deepEqual(restored[2].response.output[0].encrypted_function_args, []);
});
