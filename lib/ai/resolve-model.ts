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
//
// SLUGS BELOW ARE THE VERIFIED VERCEL AI GATEWAY CATALOG (checked 2026-09-12
// against @ai-sdk/gateway's own GatewayModelId union — see
// node_modules/@ai-sdk/gateway/dist/index.d.ts — and vercel.com/ai-gateway/models;
// docs/ai-agent-surfaces-2026-09.md §2). Every AIModel billing identity
// (lib/ai/cost-tracking.ts) that lib/ai/models.ts's MODEL_CONFIG used to spell
// out a SECOND time now resolves through THIS table instead (CLAUDE.md §6 — one
// vocabulary, not two that can drift). Never write a dated snapshot id here
// (`-20250514` etc.) or a retired preview id (`gemini-2.0-flash-exp`) — that was
// the wave-59 defect this table fixes.

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
  | "anthropic/claude-haiku-4.5"
  | "anthropic/claude-sonnet-3-5"
  | "anthropic/claude-sonnet-4"
  | "anthropic/claude-sonnet-4.6"
  | "anthropic/claude-opus-4"
  | "anthropic/claude-opus-4-5"
  | "anthropic/claude-opus-4.6"
  | "anthropic/claude-3-5-sonnet-20241022"
  // Google / Perplexity
  | "google/gemini-2.5-flash"
  | "google/gemini-2.5-pro"
  | "perplexity/sonar"
  | "perplexity/sonar-pro"
  // Short-form aliases
  | "gpt-4o-mini"
  | "gpt-4o"
  | "gpt-4-turbo"
  | "gpt-4"
  | "gpt-3.5-turbo"
  | "gpt-5-mini"
  | "claude-haiku"
  | "claude-sonnet"
  | "claude-opus"
  | "gemini-pro"
  | "gemini-flash"
  | "perplexity-sonar"
  | "perplexity-sonar-pro"

// Short-form aliases → canonical Vercel AI Gateway model string.
// Verified against @ai-sdk/gateway's GatewayModelId union 2026-09-12 (see file
// header). This is the ONLY table AIModel billing identities resolve through —
// lib/ai/models.ts's MODEL_CONFIG derives from it rather than repeating it.
const ALIASES: Record<string, string> = {
  // OpenAI short forms
  "gpt-4o-mini":       "openai/gpt-4o-mini",
  "gpt-4o":            "openai/gpt-4o",
  "gpt-4-turbo":       "openai/gpt-4-turbo",
  "gpt-4":             "openai/gpt-4",
  "gpt-3.5-turbo":     "openai/gpt-3.5-turbo",
  "gpt-5-mini":        "openai/gpt-5-mini",
  // Anthropic short forms
  "claude-haiku":      "anthropic/claude-haiku-4.5",
  "claude-haiku-3":    "anthropic/claude-3-haiku-20240307",
  "claude-sonnet":     "anthropic/claude-sonnet-4.6",
  "claude-sonnet-3-5": "anthropic/claude-3-5-sonnet-20241022",
  // "claude-opus" already used elsewhere in the repo as both
  // "anthropic/claude-opus-4-5" and "anthropic/claude-opus-4.6" (grepped
  // 2026-09-12: app/actions/buyer-coaching.ts, app/actions/buyer-fatigue.ts).
  // Kept to the dot-form because it is the one that actually appears in the
  // gateway's GatewayModelId union (the hyphen form does not) — not invented,
  // picked from what the repo already had.
  "claude-opus":       "anthropic/claude-opus-4.6",
  "claude-opus-3":     "anthropic/claude-3-opus-20240229",
  // Google / Perplexity short forms
  "gemini-pro":          "google/gemini-2.5-pro",
  "gemini-flash":        "google/gemini-2.5-flash",
  "perplexity-sonar":     "perplexity/sonar",
  "perplexity-sonar-pro": "perplexity/sonar-pro",
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
