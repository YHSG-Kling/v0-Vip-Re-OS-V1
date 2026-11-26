// ============================================================
// SYSTEM: L11-S02 — Brand Sample Generation API Route
// VIP Real Estate AI OS — Layer 11
// ============================================================
// POST: Generates a sample email using the brand voice configuration
// Uses Vercel AI SDK with streaming response

import { streamTextRouted, AIFairUseError } from "@/lib/ai/models"
import { createClient } from "@/lib/supabase/server"
import { normalizeFormalityLevel } from "@/lib/branding/formality"

// TOMBSTONE — this handler took the framework's Request object and read NOTHING
// from it: no query string, no body, no header. Every input it uses comes from the
// SESSION (CLAUDE.md §4 — the tenant is never a request field). A route handler
// may be declared with no parameters at all, and leaving an unread `request` in the
// signature advertises a filter this endpoint does not honour.
export async function POST() {
  try {
    const supabase = await createClient()

    // Verify session
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Get user's brokerage
    const { data: userData } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .single()

    if (!userData?.brokerage_id) {
      return new Response(JSON.stringify({ error: "Brokerage not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    }

    const brokerageId = userData.brokerage_id

    // Get brand voice profile
    const { data: brandVoice } = await supabase
      .from("brand_voice_profile")
      .select("tone, formality_level, prohibited_words, preferred_words, tagline, mission_statement")
      .eq("brokerage_id", brokerageId)
      .is("agent_id", null)
      .is("team_id", null)
      .maybeSingle()

    // Build system prompt from brand voice
    const systemPrompt = buildBrandVoiceSystemPrompt(brandVoice)

    // Routed streaming entry — routing table model, fair-use cap checked
    // BEFORE streaming, cost ledger written on finish. Identity resolved from
    // the session above, never from the request body.
    const result = await ledgered({ userId: user.id, brokerageId }, { action: "marketing.brand_voice_sample.generate", subject: { type: "brokerage", id: brokerageId }, riskClass: "LOW_RISK_WRITE" }, async () => streamTextRouted({
      feature: "brand_voice_sample",
      system: systemPrompt,
      prompt: "Write a 3-sentence follow-up email to a new real estate lead who recently inquired about buying a home. The email should feel warm and personal while maintaining professionalism. Include a soft call-to-action.",
      maxTokens: 500,
      temperature: 0.7,
      userId: user.id,
      brokerageId,
    }))

    return result.toTextStreamResponse()
  } catch (error) {
    // The cap refusal fires pre-stream — a 429 the wizard can explain, not a 500.
    if (error instanceof AIFairUseError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    }
    console.error("[L11-Brand] Generate sample error:", error)
    return new Response(JSON.stringify({ error: "Failed to generate sample" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
}

// Build system prompt from brand voice profile
function buildBrandVoiceSystemPrompt(brandVoice: {
  tone: string | null
  formality_level: string | null
  prohibited_words: string[] | null
  preferred_words: string[] | null
  tagline: string | null
  mission_statement: string | null
} | null): string {
  const parts: string[] = [
    "You are a professional real estate agent writing a follow-up email to a new lead.",
    "Your communication should be helpful, genuine, and build trust.",
  ]

  if (brandVoice) {
    if (brandVoice.tone) {
      parts.push(`Tone: Write in a ${brandVoice.tone} manner.`)
    }

    if (brandVoice.formality_level) {
      const formalityGuide: Record<string, string> = {
        formal: "Use formal, professional language. Avoid contractions and casual phrases.",
        semi_formal: "Use professional language but with a warm, approachable feel. Some contractions are acceptable.",
        casual: "Use conversational, friendly language. Contractions and casual phrases are encouraged.",
      }
      // One vocabulary (lib/branding/formality.ts) — the key was "semi-formal", which the CHECK never stores.
      parts.push(formalityGuide[normalizeFormalityLevel(brandVoice.formality_level) ?? ""] || "")
    }

    if (brandVoice.prohibited_words && brandVoice.prohibited_words.length > 0) {
      parts.push(`NEVER use these words or phrases: ${brandVoice.prohibited_words.join(", ")}`)
    }

    if (brandVoice.preferred_words && brandVoice.preferred_words.length > 0) {
      parts.push(`Try to naturally incorporate these signature phrases: ${brandVoice.preferred_words.join(", ")}`)
    }

    if (brandVoice.tagline) {
      parts.push(`Brand tagline (can reference if appropriate): "${brandVoice.tagline}"`)
    }

    if (brandVoice.mission_statement) {
      parts.push(`Brand mission (inform your approach): ${brandVoice.mission_statement}`)
    }
  }

  parts.push(
    "Keep the email concise (3 sentences) and focused on building a relationship.",
    "Do not include placeholder text like [Name] - write it as if speaking to a real person."
  )

  return parts.join("\n\n")
}

/**
 * WAVE 155 (lane 155R9, G12): ONE agent_action_ledger receipt per session write — ledgerSessionAction
 * (lib/kernel/action-ledger.ts) does the claim → run → settle. Who and which tenant come from the SESSION (CLAUDE.md §4);
 * "session" resolves them through getAgentContext. NO idempotency key: a person's second save runs again and leaves a
 * second receipt. The export's value comes back unchanged; a refused claim (only a malformed action name, caught by
 * test:action-ledger §14) throws instead of returning a value of another shape. No session tenant → the write runs exactly
 * as before, unrecorded (agent_action_ledger.brokerage_id is NOT NULL — there is no valid row to write).
 * @proofSeam scripts/ledger-receipts-transaction2-guard.ts
 */
async function ledgered<T>(
  who: { userId?: string | null; brokerageId?: string | null; agentId?: string | null } | null | undefined | "session",
  what: { action: string; subject: { type: string; id?: string | null; ref?: string | null }; riskClass: string; detail?: Record<string, unknown> },
  run: () => Promise<T>,
): Promise<T> {
  const seat = who === "session" ? await (await import("@/lib/identity/get-agent-context")).getAgentContext() : who
  if (!seat?.userId || !seat.brokerageId) return run()
  const id = what.subject.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(what.subject.id) ? what.subject.id : null
  const subject = { type: what.subject.type, id, ref: id ? what.subject.ref ?? null : what.subject.ref ?? what.subject.id ?? null }
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  let ran = false
  const r = await ledgerSessionAction({ brokerageId: seat.brokerageId, action: what.action, actor: { type: "user", userId: seat.userId, agentId: seat.agentId ?? null }, subject, riskClass: what.riskClass, reasonCode: "HUMAN_REQUESTED", detail: what.detail ?? null }, async () => { ran = true; return run() })
  if (!ran) throw new Error((r as { error?: string }).error ?? "action ledger refused the claim")
  return r as T
}
