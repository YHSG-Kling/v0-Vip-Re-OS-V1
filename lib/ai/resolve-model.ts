// lib/ai/resolve-model.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE PLACE A MODEL ALIAS BECOMES A MODEL STRING.
//
// Resolves short aliases ("claude-sonnet") and bare ids ("gpt-4o") into the
// canonical `provider/model` strings the Vercel AI Gateway understands
// ("anthropic/claude-sonnet-4-20250514", "openai/gpt-4o"). AI SDK 6 takes those
// strings directly, and the gateway — authenticated with AI_GATEWAY_API_KEY —
// routes them to the underlying provider (OpenAI, Anthropic, Google, Perplexity,
// xAI, …). No provider client is constructed here, and none should be: a
// provider SDK imported anywhere in production code is a second lane, off the
// gateway's single key, single bill and single egress.
//
// This function does NOT talk to the network. It returns a string; the caller
// hands that string to `generateText` (which resolves it through the gateway
// automatically) or wraps it with `createGateway({ apiKey })(...)` when it wants
// the key checked explicitly — see lib/ai/models.ts:toGatewayModel and
// lib/ai/generate.ts:resolveGatewayModel.
//
// Usage:
//   import { generateText } from "ai"
//   import { resolveModel } from "@/lib/ai/resolve-model"
//   await generateText({ model: resolveModel("claude-sonnet"), prompt })
//
// An already-resolved provider instance (a non-string) is returned unchanged, so
// double-resolution is safe.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProviderModel = any

// Union of all model string IDs the platform may use
export type ModelString =
  // OpenAI
  | "openai/gpt-4o-mini"
  | "openai/gpt-4o"
  | "openai/gpt-4-turbo"
  | "openai/gpt-4"
  | "openai/gpt-3.5-turbo"
  | "openai/gpt-5-mini"
  // Anthropic
  | "anthropic/claude-haiku-3-5"
  | "anthropic/claude-haiku-3"
  | "anthropic/claude-sonnet-3-5"
  | "anthropic/claude-sonnet-4"
  | "anthropic/claude-sonnet-4-20250514"
  | "anthropic/claude-opus-4"
  | "anthropic/claude-opus-4-5"
  | "anthropic/claude-opus-4.6"
  | "anthropic/claude-3-5-sonnet-20241022"
  // Short-form aliases
  | "gpt-4o-mini"
  | "gpt-4o"
  | "gpt-4-turbo"
  | "gpt-4"
  | "gpt-3.5-turbo"
  | "claude-haiku"
  | "claude-sonnet"
  | "claude-opus"

// Short-form aliases → canonical Vercel AI Gateway model string
const ALIASES: Record<string, string> = {
  // OpenAI short forms
  "gpt-4o-mini":       "openai/gpt-4o-mini",
  "gpt-4o":            "openai/gpt-4o",
  "gpt-4-turbo":       "openai/gpt-4-turbo",
  "gpt-4":             "openai/gpt-4",
  "gpt-3.5-turbo":     "openai/gpt-3.5-turbo",
  // Anthropic short forms
  "claude-haiku":      "anthropic/claude-haiku-3-5",
  "claude-haiku-3":    "anthropic/claude-3-haiku-20240307",
  "claude-sonnet":     "anthropic/claude-sonnet-4-20250514",
  "claude-sonnet-3-5": "anthropic/claude-3-5-sonnet-20241022",
  "claude-opus":       "anthropic/claude-opus-4-5",
  "claude-opus-3":     "anthropic/claude-3-opus-20240229",
}

/**
 * Resolves a model alias or full model string for use with AI SDK 6.
 *
 * AI SDK 6 accepts plain model strings directly — just return the canonical
 * provider/model string and the SDK routes it through the gateway.
 *
 * Already-resolved provider instances (objects) are returned unchanged.
 */
export function resolveModel(modelOrId: ModelString | ProviderModel): string | ProviderModel {
  // Already a resolved provider instance — pass through unchanged
  if (typeof modelOrId !== "string") {
    return modelOrId
  }

  const id = modelOrId.trim().toLowerCase()
  const resolved = ALIASES[id] ?? id

  // Heuristic: if no provider prefix, add one
  if (!resolved.includes("/")) {
    if (resolved.includes("claude")) return `anthropic/${resolved}`
    return `openai/${resolved}`
  }

  return resolved
}
