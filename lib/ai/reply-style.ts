// lib/ai/reply-style.ts
//
// PURE resolution of an agent's AI reply style — no DB, no server-only imports,
// so it is directly testable.
//
// agent_chat_preferences has carried `preferred_model` and `tone` columns for a
// long time and NOTHING read them: the drafting prompt hardcoded its model and
// never mentioned tone, so the settings row was decorative. This module is the
// one place that turns a stored preference into something the generator uses.
//
// BOTH COLUMNS ARE FREE TEXT. A preference is data the user typed, and it ends
// up as a model id on a router call — so an unrecognised value must never be
// passed through. Everything here falls back to the default rather than
// forwarding a string that would fail every generation for that agent.

export interface ReplyStyleOption<T extends string> {
  value: T
  label: string
  description: string
}

/** Tones the drafting prompt knows how to honour. */
export const REPLY_TONES = [
  { value: "professional",  label: "Professional",  description: "Clear and businesslike — the default" },
  { value: "warm",          label: "Warm",          description: "Friendly and personal, still precise" },
  { value: "concise",       label: "Concise",       description: "Short. Gets to the point fast" },
  { value: "consultative",  label: "Consultative",  description: "Explains the why, walks through options" },
] as const satisfies readonly ReplyStyleOption<string>[]

export type ReplyTone = (typeof REPLY_TONES)[number]["value"]
export const DEFAULT_REPLY_TONE: ReplyTone = "professional"

/**
 * Models this deployment already routes to through the AI gateway.
 *
 * Deliberately a SHORT list of ids that are in use elsewhere in this repo —
 * offering an id the gateway has not been provisioned for would turn a settings
 * choice into a broken assistant for that agent, with no signal why.
 */
export const REPLY_MODELS = [
  { value: "openai/gpt-4o-mini",                 label: "Fast",     description: "Quickest drafts, lowest cost — the default" },
  { value: "openai/gpt-4o",                      label: "Balanced", description: "Better reasoning on complex threads" },
  { value: "anthropic/claude-sonnet-4-20250514", label: "Careful",  description: "Most attentive to nuance and compliance wording" },
] as const satisfies readonly ReplyStyleOption<string>[]

export type ReplyModel = (typeof REPLY_MODELS)[number]["value"]
export const DEFAULT_REPLY_MODEL: ReplyModel = "openai/gpt-4o-mini"

/** The instruction actually appended to the drafting prompt for each tone. */
const TONE_DIRECTIVE: Record<ReplyTone, string> = {
  professional: "Write in a clear, professional tone. Complete sentences, no slang, no filler.",
  warm:         "Write warmly and personally, as if to someone you know and like. Stay precise — warmth is not vagueness.",
  concise:      "Be brief. Short sentences, no preamble, no restating the question. Two or three sentences where possible.",
  consultative: "Explain your reasoning. Lay out the options and the trade-offs so they can decide, rather than telling them what to do.",
}

export function isReplyTone(v: unknown): v is ReplyTone {
  return typeof v === "string" && REPLY_TONES.some((t) => t.value === v)
}

export function isReplyModel(v: unknown): v is ReplyModel {
  return typeof v === "string" && REPLY_MODELS.some((m) => m.value === v)
}

export interface ResolvedReplyStyle {
  model: ReplyModel
  tone: ReplyTone
  /** Drop this straight into the prompt. */
  toneDirective: string
  /** True when a stored value was not recognised and the default was used. */
  usedFallback: boolean
}

/**
 * Turn a stored (or absent, or corrupted) preference row into a style the
 * generator can safely use. Never throws, never forwards an unknown id.
 */
export function resolveReplyStyle(prefs?: {
  preferred_model?: string | null
  tone?: string | null
} | null): ResolvedReplyStyle {
  const modelOk = isReplyModel(prefs?.preferred_model)
  const toneOk = isReplyTone(prefs?.tone)

  const model = modelOk ? (prefs!.preferred_model as ReplyModel) : DEFAULT_REPLY_MODEL
  const tone = toneOk ? (prefs!.tone as ReplyTone) : DEFAULT_REPLY_TONE

  // An absent preference is not a fallback — it is simply the default. A
  // fallback is a value that was STORED and could not be honoured, which is
  // worth distinguishing so a surface can say so.
  const storedModelUnusable = prefs?.preferred_model != null && !modelOk
  const storedToneUnusable = prefs?.tone != null && !toneOk

  return {
    model,
    tone,
    toneDirective: TONE_DIRECTIVE[tone],
    usedFallback: storedModelUnusable || storedToneUnusable,
  }
}
