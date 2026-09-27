// Azure OpenAI Responses compatibility normalizer.
//
// Scoped narrowly to the Kotak Azure OpenAI provider on the Responses route.
// Any other provider or route is returned byte-identical (same reference, no
// mutation) so native/personal OpenAI traffic can never be affected.
//
// Removes the image-generation tool representations that Azure's Responses
// surface rejects:
//   1. { type: "image_generation" }
//   2. { type: "namespace", name: "image_gen" }
//   3. function tool named "image_gen.imagegen"
//   4. function tool named "image_gen__imagegen"
// Azure also reserves the collaboration namespace and rejects Codex's private
// encrypted annotation on collaboration message parameters. Translate only
// declared collaboration tools and their history; the client still sees its
// original namespace on the response path.

import { stripCodexEncryptedSchemaAnnotation } from "./tool-schema-root.mjs";

const AZURE_PROVIDER_ID = "azure-kmamc";
const RESPONSES_ROUTE = "/responses";

const REMOVED_FUNCTION_NAMES = new Set(["image_gen.imagegen", "image_gen__imagegen"]);
const MESSAGE_TOOLS = new Set(["spawn_agent", "send_message", "followup_task"]);
const COLLABORATION = "collaboration";
const AZURE_NAMESPACE = "agents";

function functionToolName(tool) {
  if (typeof tool?.name === "string") return tool.name;
  const nested = tool?.function;
  if (nested && typeof nested.name === "string") return nested.name;
  return undefined;
}

function isRemovableImageTool(tool) {
  if (!tool || typeof tool !== "object") return false;
  if (tool.type === "image_generation") return true;
  if (tool.type === "namespace" && tool.name === "image_gen") return true;
  if (tool.type === "function" && REMOVED_FUNCTION_NAMES.has(functionToolName(tool))) return true;
  return false;
}

function functionIdentity(tool) {
  if (tool?.type !== "function") return undefined;
  const name = functionToolName(tool);
  if (typeof name !== "string") return undefined;
  if (tool.namespace === COLLABORATION || tool.namespace === AZURE_NAMESPACE) {
    return { namespace: tool.namespace, name };
  }
  for (const namespace of [COLLABORATION, AZURE_NAMESPACE]) {
    for (const delimiter of ["__", "."]) {
      if (name.startsWith(`${namespace}${delimiter}`)) {
        return { namespace, name: name.slice(namespace.length + delimiter.length) };
      }
    }
  }
  return undefined;
}

function declaredNamespaces(tools) {
  const names = new Set();
  const collaborationNames = new Set();
  for (const tool of tools) {
    if (tool?.type === "namespace" && [COLLABORATION, AZURE_NAMESPACE].includes(tool.name)) {
      names.add(tool.name);
      if (tool.name === COLLABORATION) {
        for (const child of tool.tools || []) {
          if (child?.type === "function" && typeof child.name === "string") {
            collaborationNames.add(child.name);
          }
        }
      }
    }
    const identity = functionIdentity(tool);
    if (identity) {
      names.add(identity.namespace);
      if (identity.namespace === COLLABORATION) collaborationNames.add(identity.name);
    }
  }
  if (names.has(COLLABORATION) && names.has(AZURE_NAMESPACE)) {
    const error = new Error("Azure collaboration/agents namespace declaration collision.");
    error.status = 400;
    error.code = "azure_collaboration_namespace_collision";
    throw error;
  }
  return { names, collaborationNames };
}

export function azureCollaborationToolNames(tools, { providerId, route } = {}) {
  if (providerId !== AZURE_PROVIDER_ID || route !== RESPONSES_ROUTE || !Array.isArray(tools)) {
    return new Set();
  }
  return declaredNamespaces(tools).collaborationNames;
}

function translateName(name) {
  if (typeof name !== "string") return name;
  for (const delimiter of ["__", "."]) {
    if (name.startsWith(`${COLLABORATION}${delimiter}`)) {
      return `${AZURE_NAMESPACE}${name.slice(COLLABORATION.length)}`;
    }
  }
  return name;
}

function translateFunctionReference(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  if (item.namespace === COLLABORATION) {
    return { ...item, namespace: AZURE_NAMESPACE };
  }
  const name = translateName(item.name);
  return name === item.name ? item : { ...item, name };
}

function translateMessageTool(tool, name) {
  if (!MESSAGE_TOOLS.has(name)) return tool;
  const parameters = tool.parameters ?? tool.function?.parameters;
  const repaired = stripCodexEncryptedSchemaAnnotation(parameters);
  if (repaired === parameters) return tool;
  if (tool.parameters !== undefined) return { ...tool, parameters: repaired };
  return { ...tool, function: { ...tool.function, parameters: repaired } };
}

function translateTool(tool) {
  if (tool?.type === "namespace" && tool.name === COLLABORATION) {
    return {
      ...tool,
      name: AZURE_NAMESPACE,
      ...(Array.isArray(tool.tools)
        ? { tools: tool.tools.map((child) => translateMessageTool(child, child?.name)) }
        : {}),
    };
  }
  const identity = functionIdentity(tool);
  if (identity?.namespace !== COLLABORATION) return tool;
  const renamed = translateFunctionReference(tool);
  const repaired = translateMessageTool(renamed, identity.name);
  if (renamed.function?.name?.startsWith(`${COLLABORATION}__`)) {
    return { ...repaired, function: { ...repaired.function, name: translateName(repaired.function.name) } };
  }
  return repaired;
}

function translateToolChoice(choice) {
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return choice;
  if (choice.type === "allowed_tools" && Array.isArray(choice.tools)) {
    return { ...choice, tools: choice.tools.map(translateFunctionReference) };
  }
  return translateFunctionReference(choice);
}

export function normalizeAzureOpenAIResponsesRequest(payload, { providerId, route } = {}) {
  if (providerId !== AZURE_PROVIDER_ID || route !== RESPONSES_ROUTE) return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (!Array.isArray(payload.tools)) return payload;
  const { names } = declaredNamespaces(payload.tools);
  const collaborationDeclared = names.has(COLLABORATION);
  if (!collaborationDeclared && !payload.tools.some(isRemovableImageTool)) return payload;
  payload.tools = payload.tools
    .filter((tool) => !isRemovableImageTool(tool))
    .map((tool) => collaborationDeclared ? translateTool(tool) : tool);
  if (collaborationDeclared) {
    if (Array.isArray(payload.input)) {
      payload.input = payload.input.map((item) =>
        item?.type === "function_call" ? translateFunctionReference(item) : item);
    }
    if (payload.tool_choice !== undefined) {
      payload.tool_choice = translateToolChoice(payload.tool_choice);
    }
  }
  return payload;
}
