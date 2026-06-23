// lib/lead-pipeline/ai-intent-classifier.ts
//
// AI INTENT AT INGEST — the lead-quality multiplier. Until now the scrape pipeline scored a
// raw record purely from its SOURCE (a fixed per-source baseline + keyword signals). A
// Facebook post that says "NEED to sell ASAP, job transfer out of state" scored the same as
// any other Facebook post. This reads the actual CONTENT with the LLM (analyzeLead) during
// the enrichment phase and FUSES that intent into the record's existing lead fields —
// lifting lead_score (which cascades to urgency_level/temperature) and filling lead_type when
// the source is ambiguous (social/search). No new columns: it enriches lead_score / lead_type
// / motivation_confidence that promotion already writes (verified vs the live `leads` schema).
//
// All scoring math is PURE + unit-tested; the LLM call is behind an injectable seam so the
// pipeline never breaks on a model hiccup (best-effort: returns null → source score stands)
// and tests run with NO model spend.

import type { IntentType } from "./source-intent-map"

/** The model's raw analysis shape (analyzeLead's return). */
export interface RawLeadAnalysis {
  intent: string
  urgencyScore: number // 1–5
  confidence: number // 0–1
  summary?: string
  timeline?: string
  location?: string
}

/** Normalized, pipeline-ready intent. */
export interface AiIntent {
  intentType: IntentType // buyer | seller | unknown
  score: number // 0–100 (intent strength)
  confidence: number // 0–1
  urgency: number // 1–5
  summary: string
}

/** The injectable analyzer (defaults to analyzeLead in production; deterministic in tests). */
export type LeadAnalyzer = (params: { content: string; authorName?: string }) => Promise<RawLeadAnalysis>

const SELLER_INTENTS = new Set(["selling", "sell", "distress", "fsbo", "motivated_seller", "expired", "foreclosure"])
const BUYER_INTENTS = new Set(["buying", "buy", "relocating", "relocation", "purchase"])

/** PURE: map the model's free-text intent to the canonical buyer|seller|unknown lead type. */
export function intentToType(intent: string): IntentType {
  const i = (intent ?? "").toLowerCase().trim()
  if (SELLER_INTENTS.has(i)) return "seller"
  if (BUYER_INTENTS.has(i)) return "buyer"
  return "unknown"
}

/** PURE: a 1–5 urgency + 0–1 confidence → a 0–100 intent-strength score. */
export function aiIntentScore(urgency1to5: number, confidence0to1: number): number {
  const u = Math.max(1, Math.min(5, Number.isFinite(urgency1to5) ? urgency1to5 : 3))
  const c = Math.max(0, Math.min(1, Number.isFinite(confidence0to1) ? confidence0to1 : 0.5))
  // Urgency drives the band (1→20 … 5→100); confidence pulls an uncertain read toward neutral 50.
  const urgencyScore = (u / 5) * 100
  return Math.round(urgencyScore * c + 50 * (1 - c))
}

/** PURE: normalize a raw analysis into pipeline-ready intent. */
export function normalizeAiIntent(raw: RawLeadAnalysis): AiIntent {
  const confidence = Math.max(0, Math.min(1, Number.isFinite(raw.confidence) ? raw.confidence : 0.5))
  return {
    intentType: intentToType(raw.intent),
    score: aiIntentScore(raw.urgencyScore, confidence),
    confidence,
    urgency: Math.max(1, Math.min(5, Number.isFinite(raw.urgencyScore) ? raw.urgencyScore : 3)),
    summary: (raw.summary ?? "").slice(0, 280),
  }
}

/** How much the AI read is allowed to move the source score, at full confidence. */
export const MAX_AI_WEIGHT = 0.5

/**
 * PURE: fuse the deterministic source score with the AI intent score, weighting the AI read
 * by its confidence (capped at MAX_AI_WEIGHT). A confident high-intent read lifts a generic
 * source baseline; a low-confidence read barely moves it. Result clamped 0–100.
 */
export function fuseLeadScore(sourceScore: number, ai: { score: number; confidence: number } | null): number {
  const base = Math.max(0, Math.min(100, Math.round(sourceScore)))
  if (!ai) return base
  const w = Math.max(0, Math.min(1, ai.confidence)) * MAX_AI_WEIGHT
  const fused = base * (1 - w) + Math.max(0, Math.min(100, ai.score)) * w
  return Math.round(Math.max(0, Math.min(100, fused)))
}

/**
 * PURE: refine the lead type — keep the source's call when it knows (seller/buyer), otherwise
 * defer to the AI read (which is exactly the value-add on ambiguous social/search sources).
 */
export function resolveLeadType(sourceLeadType: IntentType, aiIntentType: IntentType): IntentType {
  return sourceLeadType !== "unknown" ? sourceLeadType : aiIntentType
}

/** Below this many characters there's nothing for the model to read — skip the spend. */
export const MIN_CONTENT_CHARS = 24

/**
 * Best-effort: assemble content from a raw record and classify its intent with the LLM. Returns
 * null when there's no meaningful content (structured sources like BatchData) or on any failure,
 * so the deterministic source score always stands as the floor.
 */
export async function classifyRawRecordIntent(
  params: { content: string; authorName?: string },
  analyzer: LeadAnalyzer,
): Promise<AiIntent | null> {
  const content = (params.content ?? "").trim()
  if (content.length < MIN_CONTENT_CHARS) return null
  try {
    const raw = await analyzer({ content, authorName: params.authorName })
    return normalizeAiIntent(raw)
  } catch {
    return null
  }
}

/** Assemble the readable content from a raw record's text-bearing fields (pure, no I/O). */
export function assembleRecordContent(rec: {
  raw_data?: Record<string, unknown> | null
  normalized_preview?: Record<string, unknown> | null
}): string {
  const rd = rec.raw_data ?? {}
  const np = rec.normalized_preview ?? {}
  const parts = [
    rd.content, rd.text, rd.post_content, rd.body, rd.message, rd.description,
    rd.search_query, rd.title, np.summary,
    Array.isArray(np.intentSignals) ? (np.intentSignals as unknown[]).join(", ") : null,
  ]
  return parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0).join(" · ").slice(0, 2000)
}
