"use server"

/**
 * app/actions/ai-generate.ts — Server Action wrappers.
 *
 * All implementation lives in lib/ai/generate.ts (canonical location).
 * Next.js requires "use server" files to export only async functions —
 * re-export syntax is not permitted, so each function is explicitly wrapped.
 *
 * UI components should import directly from "@/lib/ai/generate" instead.
 */

import {
  generateAIText as _generateAIText,
  generateAIJSON as _generateAIJSON,
  generateAIObject as _generateAIObject,
  generateChatResponse as _generateChatResponse,
} from "@/lib/ai/generate"
import type { z } from "zod"

export async function generateAIText(
  prompt: string,
  options?: { maxTokens?: number; temperature?: number; feature?: string }
): Promise<{ text: string; error?: string }> {
  return _generateAIText(prompt, options)
}

export async function generateAIJSON<T = Record<string, unknown>>(
  prompt: string,
  options?: { model?: string; maxTokens?: number; temperature?: number; feature?: string }
): Promise<{ data: T | null; error?: string }> {
  return _generateAIJSON<T>(prompt, options)
}

export async function generateAIObject<T extends z.ZodType>(
  prompt: string,
  schema: T,
  options?: { model?: string; temperature?: number }
): Promise<{ success: boolean; object?: z.infer<T>; error?: string }> {
  return _generateAIObject<T>(prompt, schema, options)
}

export async function generateChatResponse(
  userMessage: string,
  context: string
): Promise<{ text: string; error?: string }> {
  return _generateChatResponse(userMessage, context)
}
