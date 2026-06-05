"use server"

/**
 * app/actions/ai-generate.ts — Server Action wrappers.
 *
 * All implementation lives in lib/ai/generate.ts (canonical location).
 * Next.js requires "use server" files to export only async functions —
 * re-export syntax is not permitted, so each function is explicitly wrapped.
 *
 * IMPORT RULES (Next 16 / Turbopack):
 *   · Server-side callers (app/actions/*, other lib/* files, route handlers,
 *     RSCs): import from "@/lib/ai/generate" directly — no Server Action
 *     overhead, no per-call POST round-trip.
 *   · Client components ("use client"): import from this file. Importing
 *     "@/lib/ai/generate" directly causes Turbopack to walk the transitive
 *     graph into Node-only modules (e.g. @ai-sdk/gateway, runPipelineSimple
 *     → DB writes) and the client bundle fails.
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
