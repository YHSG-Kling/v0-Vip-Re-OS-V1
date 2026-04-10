/**
 * lib/ai/generate.ts
 * Canonical AI generation helpers — pure lib layer, no app/ imports.
 * app/actions/ai-generate.ts re-exports from here for Server Action consumers.
 */

import { generateText, Output } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { runPipelineSimple } from "@/lib/ai/pipeline"
import { z } from "zod"

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
}): Promise<{ object: z.infer<T> }> {
  // If model is already a resolved provider instance (any non-string truthy value),
  // use it directly. If it's a string, resolve it via the gateway helper.
  const resolvedModel =
    typeof model === "string"
      ? resolveModel(model as Parameters<typeof resolveModel>[0])
      : model

  const promptParts = [system, prompt].filter(Boolean).join("\n\n")

  const { experimental_output } = await generateText({
    model: resolvedModel,
    prompt: promptParts,
    temperature: temperature ?? 0.5,
    experimental_output: Output.object({ schema }),
  })

  return { object: experimental_output as z.infer<T> }
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
    const { experimental_output: object } = await generateText({
      model: resolveModel((options?.model ?? "openai/gpt-4o") as Parameters<typeof resolveModel>[0]),
      prompt,
      temperature: options?.temperature ?? 0.7,
      experimental_output: Output.object({ schema }),
    })
    return { success: true, object }
  } catch (error: any) {
    console.error("[AI generate] generateAIObject error:", error)
    return { success: false, error: error.message ?? "Failed to generate AI object" }
  }
}
