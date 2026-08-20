/**
 * lib/ai/generate.ts
 * Canonical AI generation helpers — pure lib layer, no app/ imports.
 * app/actions/ai-generate.ts re-exports from here for Server Action consumers.
 */

import { generateText, Output } from "ai"
import { createGateway } from "@ai-sdk/gateway"
import { resolveModel } from "@/lib/ai/resolve-model"
import { runPipelineSimple } from "@/lib/ai/pipeline"
import { modelIdentityFor, type AIModel } from "@/lib/ai/models"
import { z } from "zod"

/**
 * Wraps a resolved model string into a LanguageModel instance via the Vercel
 * AI Gateway. Requires AI_GATEWAY_API_KEY to be set in the environment.
 * Throws a clear error if the key is missing so callers get an actionable message.
 */
function resolveGatewayModel(modelStr: string) {
  const apiKey = process.env.AI_GATEWAY_API_KEY
  if (!apiKey) {
    throw new Error(
      `AI_GATEWAY_API_KEY is not configured. Cannot call model: ${modelStr}`
    )
  }
  return createGateway({ apiKey })(modelStr)
}

// ─── JSON GENERATION ─────────────────────────────────────────────────────────

export async function generateAIJSON<T = Record<string, any>>(
  prompt: string,
  options?: {
    model?: string
    maxTokens?: number
    temperature?: number
    feature?: string
  }
): Promise<{ data: T | null; error?: string }> {
  try {
    const jsonPrompt = `${prompt}\n\nIMPORTANT: Respond with ONLY valid JSON. No markdown, no code blocks, no explanation - just the raw JSON object.`

    const text = await runPipelineSimple(jsonPrompt, {
      maxTokens: options?.maxTokens,
      temperature: options?.temperature ?? 0.3,
      feature: options?.feature ?? "generate_json",
    })

    let cleaned = text.trim()
    if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7)
    if (cleaned.startsWith("```")) cleaned = cleaned.slice(3)
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3)

    const data = JSON.parse(cleaned.trim()) as T
    return { data }
  } catch (error) {
    console.error("[AI generate] generateAIJSON error:", error)
    return { data: null, error: "Failed to generate AI JSON response" }
  }
}

// ─── TEXT GENERATION ─────────────────────────────────────────────────────────

export async function generateAIText(
  prompt: string,
  options?: {
    maxTokens?: number
    temperature?: number
    feature?: string
  }
): Promise<{ text: string; error?: string }> {
  try {
    const text = await runPipelineSimple(prompt, {
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
      feature: options?.feature ?? "generate_text",
    })
    return { text }
  } catch (error) {
    console.error("[AI generate] generateAIText error:", error)
    return { text: "", error: "Failed to generate AI response" }
  }
}

// ─── CHAT RESPONSE ───────────────────────────────────────────────────────────

export async function generateChatResponse(
  userMessage: string,
  context: string
): Promise<{ text: string; error?: string }> {
  const prompt = `You are a real estate assistant chat bot following the THEM-FIRST philosophy.
                    
CONTEXT:
- User is viewing property ${context}
- User Question: "${userMessage}"

THEM-FIRST PHILOSOPHY (CRITICAL):
- Focus 80-90% on THEIR needs, not the agent/company
- Use "you" and "your" extensively
- Ask understanding questions about THEIR situation
- Show empathy for THEIR concerns
- Minimize "I", "me", "we", "our" language
- Lead with what matters to THEM, not what you offer

Provide a helpful, empathetic response that shows you understand their situation. Keep it under 2 sentences.
If they ask a question, answer it from THEIR perspective, focusing on what they gain or how it helps them.`

  return generateAIText(prompt)
}

// ─── generateObject COMPATIBILITY SHIM ───────────────────────────────────────
// AI SDK 6 deprecates generateObject — this shim keeps existing action files
// working without touching each one. All action files should import generateObject
// from "@/lib/ai/generate" instead of "ai".
//
// Usage (same API as the old SDK):
//   import { generateObject } from "@/lib/ai/generate"
//   const { object } = await generateObject({ model, schema, prompt })

export async function generateObject<T extends z.ZodType>({
  model,
  schema,
  prompt,
  temperature,
  system,
}: {
  model: string | any
  schema: T
  prompt?: string
  temperature?: number
  system?: string
}): Promise<{ object: z.infer<T>; usage: GeneratedUsage }> {
  // If model is already a resolved provider instance (any non-string truthy value),
  // use it directly. If it's a string, resolve it via the Vercel AI Gateway.
  const resolvedModel =
    typeof model === "string"
      ? resolveGatewayModel(resolveModel(model as Parameters<typeof resolveModel>[0]) as string)
      : model

  const promptParts = [system, prompt].filter(Boolean).join("\n\n")

  // Data Guard — strip high-confidence secrets before this raw model call (the generateObject
  // shim is a model-boundary chokepoint, like lib/ai/models.ts).
  const { redactSensitive } = await import("@/lib/data-guard")

  const promptForEstimate = promptParts

  // THE MODEL THAT SERVED THIS CALL, named before it is made.
  //
  // There is no fallback in this shim — one model instance is built above and
  // one call is made to it — so the model the caller pinned IS the model that
  // served, and this is that fact rather than a guess about it. `null` when the
  // caller handed in an already-constructed provider instance (no id to read)
  // or a string MODEL_CONFIG cannot name unambiguously.
  const servedModel = modelIdentityFor(model)

  const { experimental_output, usage } = await generateText({
    model: resolvedModel,
    prompt: redactSensitive(promptParts).text,
    temperature: temperature ?? 0.5,
    experimental_output: Output.object({ schema }),
  })

  return {
    object: experimental_output as z.infer<T>,
    usage: readUsage(usage, promptForEstimate, servedModel),
  }
}

/**
 * The REAL token counts the provider returned for one call through this shim.
 *
 * ADDITIVE — `const { object } = await generateObject(...)` is unchanged. It
 * exists because this shim is a MODEL BOUNDARY that books nothing: unlike
 * lib/ai/models.ts's routed lanes it never calls logAIUsage, so a caller that
 * needs to record its own spend previously had no honest figure to record and
 * the only alternative was to make one up.
 *
 * `estimated: true` marks the fallback path — a provider that returned no usage
 * block at all. An estimate is still measured off the real prompt and the real
 * completion; it is never a fixed number, and it says that it is an estimate.
 */
export interface GeneratedUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimated: boolean
  /**
   * THE MODEL THAT SERVED THE CALL, as the platform's own billing identity.
   *
   * Counts without a model are half a ledger row. `ai_tool_usage.model_used` is
   * what prices the tokens (calculateCost keys on it) and m508 refuses a row
   * that claims tokens without naming one — so a caller booking this usage
   * needs the model from the same source as the counts. Before this field the
   * only thing available was the model the caller BELIEVED this lane pins, and
   * app/actions/ai-tools-hub.ts was carrying exactly that: a `lane === "…"`
   * string comparison deciding what to write in a billing record.
   *
   * `null` = this shim cannot name it (a pre-built provider instance, or a
   * model string MODEL_CONFIG maps to more than one identity). Null means DO
   * NOT BOOK THE TOKENS — book zero and say why.
   */
  model: AIModel | null
}

function readUsage(usage: unknown, prompt: string, model: AIModel | null): GeneratedUsage {
  const u = (usage ?? {}) as Record<string, number | undefined>
  const input = u.inputTokens ?? u.promptTokens
  const output = u.outputTokens ?? u.completionTokens
  if (typeof input === "number" && typeof output === "number") {
    return { inputTokens: input, outputTokens: output, totalTokens: input + output, estimated: false, model }
  }
  // Same chars/4 heuristic lib/ai/cost-tracking.ts::estimateTokens uses — a
  // second estimator is how two lanes drift.
  const inputEstimate = Math.ceil(prompt.length / 4)
  return {
    inputTokens: typeof input === "number" ? input : inputEstimate,
    outputTokens: typeof output === "number" ? output : 0,
    totalTokens: (typeof input === "number" ? input : inputEstimate) + (typeof output === "number" ? output : 0),
    estimated: true,
    model,
  }
}

// ─── STRUCTURED OBJECT GENERATION ────────────────────────────────────────────
// Note: generateObject is deprecated in AI SDK 6 — use generateText + Output.object()

export async function generateAIObject<T extends z.ZodType>(
  prompt: string,
  schema: T,
  options?: {
    model?: string
    temperature?: number
  }
): Promise<{ success: boolean; object?: z.infer<T>; error?: string }> {
  try {
    const { redactSensitive } = await import("@/lib/data-guard")
    const { experimental_output: object } = await generateText({
      model: resolveGatewayModel(resolveModel((options?.model ?? "openai/gpt-4o") as Parameters<typeof resolveModel>[0]) as string),
      prompt: redactSensitive(prompt).text,
      temperature: options?.temperature ?? 0.7,
      experimental_output: Output.object({ schema }),
    })
    return { success: true, object: object as z.infer<T> | undefined }
  } catch (error: any) {
    console.error("[AI generate] generateAIObject error:", error)
    return { success: false, error: error.message ?? "Failed to generate AI object" }
  }
}
