// Azure OpenAI Responses compatibility normalizer.
//
// Scoped narrowly to the Kotak Azure OpenAI provider on the Responses route.
// Any other provider or route is returned byte-identical (same reference, no
// mutation) so native/personal OpenAI traffic can never be affected.
//
// Removes only the image-generation tool representations that Azure's
// Responses surface rejects:
//   1. { type: "image_generation" }
//   2. { type: "namespace", name: "image_gen" }
//   3. function tool named "image_gen.imagegen"
//   4. function tool named "image_gen__imagegen"
// Every other tool -- collaboration, other namespaces, shell tools, normal
// function tools, Codex app/thread tools -- is preserved verbatim.

const AZURE_PROVIDER_ID = "azure-kmamc";
const RESPONSES_ROUTE = "/responses";

const REMOVED_FUNCTION_NAMES = new Set(["image_gen.imagegen", "image_gen__imagegen"]);

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

export function normalizeAzureOpenAIResponsesRequest(payload, { providerId, route } = {}) {
  if (providerId !== AZURE_PROVIDER_ID || route !== RESPONSES_ROUTE) return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (!Array.isArray(payload.tools)) return payload;
  if (!payload.tools.some(isRemovableImageTool)) return payload;
  payload.tools = payload.tools.filter((tool) => !isRemovableImageTool(tool));
  return payload;
}
