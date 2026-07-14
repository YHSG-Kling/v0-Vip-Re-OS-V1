// lib/kernel/ai-copy.ts
//
// PERSONA-AWARE COPY — the team never sends boilerplate. Every contact is a different
// person; a "just sold near you" note to a long-tenure empty-nester reads nothing like
// one to a young investor. So play copy is GENERATED per persona + the real facts, not
// hardcoded. The hardcoded strings the plays carry become the deterministic FALLBACK
// (used when the gateway is unavailable or in tests) — still real, safe defaults, never
// a stub.
//
// The generator is an injectable seam (like every other vendor boundary) so tests don't
// spend tokens; production routes through the AI gateway. The system prompt enforces the
// non-negotiables: Fair Housing safety, ONLY the facts provided (no fabrication), and the
// persona's tone. NOT server-only (simulator-driven).

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface CopyPersona {
  name?: string | null
  /** buyer | seller | lead | past_client | investor | neighbor | agent | "audience". */
  audience?: string | null
  /** lifecycle / stage hint (e.g. "first-time buyer", "long-tenure homeowner"). */
  situation?: string | null
  /** the agent's brand-voice tone, if configured. */
  tone?: string | null
}

export interface CopyRequest {
  /** What we're writing (e.g. "a 'just sold near you' farm postcard"). */
  goal: string
  /** The ONLY facts the copy may use — no fabrication beyond these. */
  facts: string[]
  channel: string
  persona: CopyPersona
  /** ~ target length in words. */
  words?: number
}

export interface CopyDraft { subject?: string; body: string }

/** Injectable seam: produce persona-tailored copy, or null to fall back. */
export type CopyGenerator = (req: CopyRequest) => Promise<CopyDraft | null>

/** The real generator — routes through the AI gateway. Returns null on any failure so
 *  the caller's deterministic fallback takes over (the play always produces copy). */
export const realCopyGenerator: CopyGenerator = async (req) => {
  const { gatewayChat } = await import("@/lib/ai/gateway-chat")
  const persona = [
    req.persona.name ? `Name: ${req.persona.name}` : null,
    req.persona.audience ? `Audience: ${req.persona.audience}` : null,
    req.persona.situation ? `Situation: ${req.persona.situation}` : null,
    req.persona.tone ? `Brand tone to match: ${req.persona.tone}` : null,
  ].filter(Boolean).join("\n")
  const { SCRIPT_QUALITY_CHARTER } = await import("@/lib/ai/script-standards")
  const sys = [
    "You write real-estate marketing copy for a specific person. Rules you must NEVER break:",
    "1. FAIR HOUSING: never reference or imply race, religion, national origin, family status, disability, sex, or use steering language ('safe neighborhood', 'perfect for families', 'great for retirees').",
    "2. Use ONLY the facts provided — invent nothing (no prices, dates, names, or claims not given).",
    "3. Write to THIS persona's situation and tone; make it feel one-to-one, not a blast.",
    `4. Keep it ~${req.words ?? 60} words, warm, no pressure.`,
    SCRIPT_QUALITY_CHARTER,
    `Return STRICT JSON: {"subject": "<short subject or empty>", "body": "<the copy>"}.`,
  ].join("\n")
  const usr = `Write ${req.goal} for the ${req.channel} channel.\n\nPersona:\n${persona || "(general audience)"}\n\nFacts you may use:\n${req.facts.map((f) => `- ${f}`).join("\n")}`
  const res = await gatewayChat({ model: "openai/gpt-4o-mini", messages: [{ role: "system", content: sys }, { role: "user", content: usr }], maxTokens: 400, temperature: 0.7 })
  if (!res.ok || !res.content) return null
  try {
    const m = res.content.match(/\{[\s\S]*\}/)
    if (!m) return { body: res.content.trim() }
    const j = JSON.parse(m[0]) as { subject?: string; body?: string }
    if (!j.body) return null
    return { subject: j.subject || undefined, body: j.body }
  } catch { return { body: res.content.trim() } }
}

/**
 * Generate persona-aware copy, falling back to the play's deterministic default. The
 * fallback guarantees a play ALWAYS produces real copy; the generator makes it personal.
 */
export async function generatePersonaCopy(
  req: CopyRequest, fallback: CopyDraft, opts: { generator?: CopyGenerator } = {},
): Promise<CopyDraft> {
  const generator = opts.generator ?? realCopyGenerator
  const out = await generator(req).catch(() => null)
  return out ?? fallback
}

/** Pull a contact's persona for copy from the live row (best-effort). */
export async function loadContactPersona(supabase: Svc, contactId: string): Promise<CopyPersona> {
  const { data: c } = await supabase.from("contacts")
    .select("first_name, last_name, contact_type, buyer_stage").eq("id", contactId).maybeSingle()
  if (!c) return { audience: "audience" }
  return {
    name: [(c as any).first_name, (c as any).last_name].filter(Boolean).join(" ").trim() || null,
    audience: (c as any).contact_type ?? "audience",
    situation: (c as any).buyer_stage ?? null,
  }
}
