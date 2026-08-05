/**
 * The compliance gate for AI-generated video scripts.
 *
 * This used to live inline inside app/actions/video/generate-script.ts — the
 * wizard path — and nowhere else. The other three reachable script generators
 * (video-generation.ts, link-to-video.ts, lib/kernel/video.ts) produced
 * agent-facing marketing copy with no Fair Housing check, no brand voice, and
 * no compliance_events audit row. Extracting the gate here is what lets all
 * four enforce the same thing instead of one enforcing it privately.
 *
 * Three pieces, used in this order:
 *   1. loadBrandVoiceBlock + THEM_FIRST_BLOCK + FAIR_HOUSING_BLOCK
 *      — injected into the AI system prompt so the model complies proactively.
 *   2. precheckBriefForFairHousing — hard block on the human's raw brief.
 *   3. postcheckScript — advisory warnings on what the model produced.
 *
 * ── On the missing `contact` ────────────────────────────────────────────────
 * These are broadcast payloads: there is no individual recipient at script
 * time. EvaluateOutboundParams documents `contact` as optional precisely for
 * this ("Omit for broadcast campaigns — DNC/TCPA gates are skipped").
 *
 * Every call site used to pass a stub contact with `id: "broadcast"` instead.
 * contacts.id and compliance_events.entity_id are both `uuid`, so that string
 * made BOTH the contact re-fetch and the compliance_events INSERT fail with
 * 22P02 — silently, because neither destructures `error`. The gate still
 * blocked correctly, but it never left an audit row, and the
 * COMPLIANCE_VIOLATION notification is guarded by `if (complianceEvent && ...)`
 * so it never fired either. Omitting the contact is violation-identical (the
 * stub set tcpa_consent true / dnc false / no status, and no call site used
 * sms or phone, so Gates 2 and 3 produced nothing) and it makes the audit
 * write succeed.
 */

import { createClient } from "@/lib/supabase/server"
import { evaluateOutbound } from "@/lib/kernel/compliance"

/** Who is generating, for the compliance actor context. */
export interface ScriptComplianceActor {
  userId: string
  brokerageId: string
  teamId?: string
}

/**
 * Brand voice guidelines for the AI system prompt (Gate 1, proactive).
 *
 * `toneOverride` short-circuits the profile read — the wizard lets the agent
 * pick a tone per script, and that choice wins over the brokerage default.
 * Returns "" when the brokerage has no active profile, so it can be dropped
 * from the prompt with .filter(Boolean).
 */
async function loadBrandVoiceBlock(
  brokerageId: string,
  toneOverride?: string,
): Promise<string> {
  if (toneOverride) return `\nBrand voice tone: ${toneOverride}`

  const supabase = await createClient()
  const { data: bvp, error } = await supabase
    .from("brand_voice_profile")
    .select(
      "tone, formality_level, key_brand_messages, preferred_words, prohibited_words, tagline, mission_statement",
    )
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .maybeSingle()

  // A refused or failed read is not "this brokerage has no brand voice" — say
  // nothing rather than silently generating off-brand copy under a default.
  if (error || !bvp) return ""

  return `
Brand voice guidelines (Gate 1 — follow strictly):
- Tone: ${bvp.tone ?? "professional"}
- Formality: ${bvp.formality_level ?? "moderate"}
${bvp.key_brand_messages?.length ? `- Key messages to reinforce: ${bvp.key_brand_messages.join("; ")}` : ""}
${bvp.preferred_words?.length ? `- Preferred words/phrases: ${bvp.preferred_words.join(", ")}` : ""}
${bvp.prohibited_words?.length ? `- NEVER use these words/phrases: ${bvp.prohibited_words.join(", ")}` : ""}
${bvp.tagline ? `- Brand tagline (may reference): ${bvp.tagline}` : ""}
${bvp.mission_statement ? `- Mission (may reference): ${bvp.mission_statement}` : ""}`
}

/** ThemFirst philosophy for the AI system prompt (Gate 5, proactive). */
const THEM_FIRST_BLOCK = `
ThemFirst communication philosophy (Gate 5 — apply throughout):
- Use "you" and "your" language at least 60% of the time relative to "I/me/my/we/our".
- Focus every sentence on what the CLIENT experiences, benefits from, or discovers.
- Avoid ego-driven phrases: "I'm the best agent", "trust me", "you'd be crazy not to".
- Avoid false urgency: "limited time offer", "this won't last long", "don't miss out", "you need to act fast".
- Avoid investment advice claims: "guaranteed to appreciate", "you'll make money", "great investment".
- Frame the agent's expertise as a resource FOR the client, not a credential about the agent.`

/** Fair Housing directive for the AI system prompt (Gate 4, proactive). */
const FAIR_HOUSING_BLOCK = `
Fair Housing compliance (Gate 4 — mandatory):
- NEVER reference or imply race, color, religion, sex, national origin, disability, or familial status.
- NEVER use neighborhood steering language (e.g., "great schools", "safe area", "quiet neighborhood" as dog-whistles).
- Describe properties by features, square footage, layout, and price — not by the demographics of residents.
- Keep all language neutral and inclusive.`

/**
 * All three proactive blocks, ready to splice into a system prompt.
 * Callers .filter(Boolean).join("\n\n") them with their own type/tone context.
 */
export async function buildComplianceSystemBlocks(
  brokerageId: string,
  toneOverride?: string,
): Promise<string[]> {
  const brandVoiceBlock = await loadBrandVoiceBlock(brokerageId, toneOverride)
  return [brandVoiceBlock, THEM_FIRST_BLOCK, FAIR_HOUSING_BLOCK].filter(Boolean)
}

export interface BriefPrecheckResult {
  /** True when the brief must not be sent to the model at all. */
  blocked: boolean
  /** The first Fair Housing violation, phrased for the agent. */
  reason?: string
}

/**
 * Hard block on the agent's raw brief — Fair Housing only.
 *
 * ThemFirst and Brand Voice deliberately do NOT block here: they govern
 * outbound copy, not the shorthand an agent types into a form. A brief reading
 * "my listing, I need a punchy intro" is agent-centric by nature and must not
 * be refused for it.
 *
 * A gate that throws must not silently become a gate that passes, but it also
 * must not strand the agent — an infrastructure failure is reported as
 * unblocked, matching how the wizard has always behaved.
 */
export async function precheckBriefForFairHousing(
  actor: ScriptComplianceActor,
  brief: string,
  journeyType: "buyer" | "seller",
): Promise<BriefPrecheckResult> {
  try {
    const preCheck = await evaluateOutbound({
      actorContext: { userId: actor.userId, role: "agent", brokerageId: actor.brokerageId, teamId: actor.teamId },
      journeyType,
      persona: "first_time",
      messageType: "social",
      content: brief,
    })
    const fairHousingViolations = (preCheck.violations ?? []).filter((v) =>
      v.startsWith("FairHousing:"),
    )
    if (fairHousingViolations.length > 0) {
      return { blocked: true, reason: fairHousingViolations[0] }
    }
    return { blocked: false }
  } catch {
    return { blocked: false }
  }
}

/**
 * Advisory check on the generated script — every gate, warnings only.
 *
 * The script was produced under a system prompt that already carried brand
 * voice, ThemFirst, and Fair Housing, so anything left is a model slip worth
 * showing the agent next to a Regenerate button — not a reason to throw away
 * a render they are waiting on. Returns undefined when clean.
 */
export async function postcheckScript(
  actor: ScriptComplianceActor,
  script: string,
  journeyType: "buyer" | "seller",
): Promise<string[] | undefined> {
  try {
    const postCheck = await evaluateOutbound({
      actorContext: { userId: actor.userId, role: "agent", brokerageId: actor.brokerageId, teamId: actor.teamId },
      journeyType,
      persona: "first_time",
      messageType: "social",
      content: script,
    })
    if (!postCheck.allowed && postCheck.violations?.length) {
      return postCheck.violations
    }
    return undefined
  } catch {
    return undefined
  }
}
