/**
 * lib/ai/generate.ts
 * Canonical AI generation helpers — pure lib layer, no app/ imports.
 * app/actions/ai-generate.ts re-exports from here for Server Action consumers.
 */

import { generateObject } from "ai"
import { runPipelineSimple } from "@/lib/ai/pipeline"
import { z } from "zod"

// ─── JSON GENERATION ─────────────────────────────────────────────────────────

export async function generateAIJSON<T = Record<string, unknown>>(
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

// ─── STRUCTURED OBJECT GENERATION ────────────────────────────────────────────

export async function generateAIObject<T extends z.ZodType>(
  prompt: string,
  schema: T,
  options?: {
    model?: string
    temperature?: number
  }
): Promise<{ success: boolean; object?: z.infer<T>; error?: string }> {
  try {
    const { object } = await generateObject({
      model: (options?.model ?? "openai/gpt-4o") as any,
      prompt,
      schema,
      temperature: options?.temperature ?? 0.7,
    })
    return { success: true, object }
  } catch (error: any) {
    console.error("[AI generate] generateAIObject error:", error)
    return { success: false, error: error.message ?? "Failed to generate AI object" }
  }
}
