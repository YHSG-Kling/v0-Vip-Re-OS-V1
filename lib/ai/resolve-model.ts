// lib/ai/resolve-model.ts
// Maps string model IDs to their correct AI SDK v6 provider instances.
//
// Required by rule 9 of the architecture documents:
//   "All AI generation calls must use the correct provider format:
//    openai('gpt-4o-mini') or anthropic('claude-sonnet-4-20250514')
//    — never string model IDs like 'openai/gpt-4o-mini'."
//
// Usage:
//   import { resolveModel } from "@/lib/ai/resolve-model"
//   const model = resolveModel("openai/gpt-4o-mini")
//   await generateText({ model, prompt })
//
// When a model string is already a resolved provider instance (from a previous
// call), it is returned unchanged so double-resolution is safe.

import { openai }    from "@ai-sdk/openai"
import { anthropic } from "@ai-sdk/anthropic"

// Union of all provider-specific model IDs the platform may use.
export type ModelString =
  // OpenAI
  | "openai/gpt-4o-mini"
  | "openai/gpt-4o"
  | "openai/gpt-4-turbo"
  | "openai/gpt-4"
  | "openai/gpt-3.5-turbo"
  | "openai/gpt-4o-mini-2024-07-18"
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
  | "anthropic/claude-opus-3"
  | "anthropic/claude-3-5-sonnet-20241022"
  // Short-form aliases (also supported in resolveModel)
  | "gpt-4o-mini"
  | "gpt-4o"
  | "gpt-4-turbo"
  | "gpt-4"
  | "gpt-3.5-turbo"
  | "claude-haiku"
  | "claude-sonnet"
  | "claude-opus"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProviderModel = ReturnType<typeof openai> | ReturnType<typeof anthropic> | any

/**
 * Resolves a string model ID to its AI SDK v6 provider model instance.
 *
 * Accepts:
 *   - "openai/gpt-4o-mini"              → openai('gpt-4o-mini')
 *   - "anthropic/claude-sonnet-4-20250514" → anthropic('claude-sonnet-4-20250514')
 *   - Short aliases: "gpt-4o-mini"      → openai('gpt-4o-mini')
 *   - Already-resolved provider instances are returned unchanged.
 */
export function resolveModel(modelOrId: ModelString | ProviderModel): ProviderModel {
  // Already resolved (provider instance object — not a string)
  if (typeof modelOrId !== "string") {
    return modelOrId
  }

  const id = modelOrId.trim().toLowerCase()

  // ── Namespaced IDs: "provider/model-id" ─────────────────────────────────────
  if (id.startsWith("openai/")) {
    return openai(id.slice("openai/".length))
  }
  if (id.startsWith("anthropic/")) {
    return anthropic(id.slice("anthropic/".length))
  }

  // ── Short-form aliases ───────────────────────────────────────────────────────
  const ALIASES: Record<string, ProviderModel> = {
    // OpenAI
    "gpt-4o-mini":         openai("gpt-4o-mini"),
    "gpt-4o":              openai("gpt-4o"),
    "gpt-4-turbo":         openai("gpt-4-turbo"),
    "gpt-4":               openai("gpt-4"),
    "gpt-3.5-turbo":       openai("gpt-3.5-turbo"),
    // Anthropic
    "claude-haiku":        anthropic("claude-haiku-3-5"),
    "claude-haiku-3":      anthropic("claude-3-haiku-20240307"),
    "claude-sonnet":       anthropic("claude-sonnet-4-20250514"),
    "claude-sonnet-3-5":   anthropic("claude-3-5-sonnet-20241022"),
    "claude-opus":         anthropic("claude-opus-4-5"),
    "claude-opus-3":       anthropic("claude-3-opus-20240229"),
  }

  if (id in ALIASES) {
    return ALIASES[id]
  }

  // ── Heuristic fallback: if it looks like a Claude model, use anthropic ───────
  if (id.includes("claude")) {
    return anthropic(modelOrId as string)
  }

  // ── Default fallback: assume OpenAI ──────────────────────────────────────────
  return openai(modelOrId as string)
}
