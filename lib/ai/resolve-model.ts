// lib/ai/resolve-model.ts
// Maps string model IDs to Vercel AI Gateway models.
//
// Uses the Vercel AI Gateway which provides zero-config access to multiple providers
// when AI_GATEWAY_API_KEY is configured. The gateway automatically routes requests
// to the correct provider (OpenAI, Anthropic, Google, etc.) based on the model string.
//
// Usage:
//   import { resolveModel } from "@/lib/ai/resolve-model"
//   const model = resolveModel("openai/gpt-4o-mini")
//   await generateText({ model, prompt })
//
// When a model string is already a resolved provider instance (from a previous
// call), it is returned unchanged so double-resolution is safe.

import { customProvider } from "@ai-sdk/provider"
import { createOpenAI } from "@ai-sdk/openai"

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

// Create Vercel AI Gateway provider instance
// The gateway uses AI_GATEWAY_API_KEY and routes to multiple providers
const gateway = createOpenAI({
  baseURL: "https://gateway.ai.vercel.app/v1",
  apiKey: process.env.AI_GATEWAY_API_KEY,
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProviderModel = any

/**
 * Resolves a string model ID to a Vercel AI Gateway model.
 *
 * The gateway automatically routes requests to the correct provider based on
 * the model prefix (openai/, anthropic/, google/, etc.)
 *
 * Accepts:
 *   - "openai/gpt-4o-mini"                    → gateway('openai/gpt-4o-mini')
 *   - "anthropic/claude-sonnet-4-20250514"    → gateway('anthropic/claude-sonnet-4-20250514')
 *   - Short aliases: "gpt-4o-mini"            → gateway('openai/gpt-4o-mini')
 *   - Already-resolved provider instances are returned unchanged.
 */
export function resolveModel(modelOrId: ModelString | ProviderModel): ProviderModel {
  // Already resolved (provider instance object — not a string)
  if (typeof modelOrId !== "string") {
    return modelOrId
  }

  const id = modelOrId.trim().toLowerCase()

  // ── Short-form aliases → full provider/model format ─────────────────────────
  const ALIASES: Record<string, string> = {
    // OpenAI
    "gpt-4o-mini":         "openai/gpt-4o-mini",
    "gpt-4o":              "openai/gpt-4o",
    "gpt-4-turbo":         "openai/gpt-4-turbo",
    "gpt-4":               "openai/gpt-4",
    "gpt-3.5-turbo":       "openai/gpt-3.5-turbo",
    // Anthropic
    "claude-haiku":        "anthropic/claude-haiku-3-5",
    "claude-haiku-3":      "anthropic/claude-3-haiku-20240307",
    "claude-sonnet":       "anthropic/claude-sonnet-4-20250514",
    "claude-sonnet-3-5":   "anthropic/claude-3-5-sonnet-20241022",
    "claude-opus":         "anthropic/claude-opus-4-5",
    "claude-opus-3":       "anthropic/claude-3-opus-20240229",
  }

  // Resolve alias to full format
  const modelString = ALIASES[id] || id

  // ── Heuristic fallback for unrecognized models ──────────────────────────────
  // If it doesn't have a provider prefix, try to guess
  if (!modelString.includes("/")) {
    if (modelString.includes("claude")) {
      return gateway(`anthropic/${modelString}`)
    }
    if (modelString.includes("gpt") || modelString.includes("openai")) {
      return gateway(`openai/${modelString}`)
    }
    // Default to OpenAI for unknown models
    return gateway(`openai/${modelString}`)
  }

  // Use the gateway with the full provider/model string
  return gateway(modelString)
}
