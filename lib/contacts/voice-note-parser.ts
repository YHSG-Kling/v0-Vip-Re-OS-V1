/**
 * lib/contacts/voice-note-parser.ts
 *
 * Parses an agent's free-form dictation into structured CRM updates:
 *   • a clean note body to append to the contact's notes
 *   • zero or more follow-up tasks with due dates
 *   • optional sentiment / next-step hint
 *
 * The parser is provider-pluggable — it tries OpenAI first (since the codebase
 * already depends on the openai SDK), and falls back to a deterministic
 * rule-based extractor if the API key isn't set. That guarantees the feature
 * always works on the client, and degrades gracefully without it.
 */

import "server-only"
import { openai } from "@ai-sdk/openai"
import { generateObject } from "ai"
import { z } from "zod"

const ParsedNoteSchema = z.object({
  noteBody: z.string().min(1).max(2000),
  tasks: z.array(
    z.object({
      title: z.string().min(1).max(160),
      dueInDays: z.number().int().min(0).max(180).nullable(),
      priority: z.enum(["low", "normal", "high"]).default("normal"),
    }),
  ).max(5).default([]),
  sentiment: z.enum(["positive", "neutral", "negative"]).default("neutral"),
  nextStep: z.string().max(160).nullable().default(null),
})

export type ParsedNote = z.infer<typeof ParsedNoteSchema>

export async function parseVoiceNote(transcript: string, opts?: {
  contactName?: string
  contactType?: string | null
}): Promise<ParsedNote> {
  const trimmed = transcript.trim()
  if (!trimmed) {
    return { noteBody: "", tasks: [], sentiment: "neutral", nextStep: null }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const { object } = await generateObject({
        model: openai("gpt-4o-mini"),
        schema: ParsedNoteSchema,
        system:
          "You convert a real-estate agent's spoken note about a contact into a structured CRM update. " +
          "The noteBody is a third-person summary of what was discussed/observed (NOT the raw transcript). " +
          "Extract follow-up tasks ONLY when the agent explicitly mentions an action they will take (call, send, schedule). " +
          "Keep tasks concise and use natural relative dates (e.g. dueInDays=1 for tomorrow). " +
          "Never invent tasks the agent didn't mention.",
        prompt: [
          opts?.contactName ? `Contact: ${opts.contactName}` : "",
          opts?.contactType ? `Contact type: ${opts.contactType}` : "",
          "",
          "Transcript:",
          trimmed,
        ]
          .filter(Boolean)
          .join("\n"),
      })
      return object
    } catch (err) {
      console.warn("[voice-note-parser] LLM extraction failed, falling back:", err)
    }
  }

  // ─── Deterministic fallback ─────────────────────────────────────────────
  // Splits on simple action verbs and emits at most one follow-up task. This
  // keeps the feature usable when no LLM is configured and gives sensible
  // defaults under heavy load.
  const sentences = trimmed.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/)
  const taskMatch = sentences.find((s) =>
    /\b(call|text|email|send|schedule|follow up|remind|share)\b/i.test(s),
  )
  const dayMatch = trimmed.match(/in (\d{1,3}) (day|days|week|weeks|month|months)/i)
  const dueInDays = dayMatch
    ? Number(dayMatch[1]) *
      (/week/i.test(dayMatch[2]) ? 7 : /month/i.test(dayMatch[2]) ? 30 : 1)
    : /tomorrow/i.test(trimmed)
      ? 1
      : /next week/i.test(trimmed)
        ? 7
        : null

  const sentiment: ParsedNote["sentiment"] =
    /\b(great|excited|loved|happy|ready|enthusiastic)\b/i.test(trimmed)
      ? "positive"
      : /\b(unhappy|frustrated|angry|cold feet|withdrawing|no thanks|not interested)\b/i.test(trimmed)
        ? "negative"
        : "neutral"

  return {
    noteBody: trimmed,
    tasks: taskMatch
      ? [{ title: taskMatch.slice(0, 160), dueInDays, priority: "normal" }]
      : [],
    sentiment,
    nextStep: taskMatch ? taskMatch.slice(0, 160) : null,
  }
}
