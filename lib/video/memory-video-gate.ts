/**
 * lib/video/memory-video-gate.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE — decides whether a seller-side deal warrants a "memory video"
 * recommendation (app/api/ai/video-recommendations/route.ts).
 *
 * WHERE THE PERSONA ACTUALLY LIVES
 * public.leads has a `persona` column but no age column, and — verified against
 * pg_constraint — there is no foreign key joining transactions and leads in
 * either direction, so a deal cannot reach a lead at all. The client of a deal
 * is a CONTACT (transactions.contact_id / seller_contact_id / buyer_contact_id
 * all FK contacts.id), and public.contacts is where contact_persona lives. That
 * is the column this gate reads.
 *
 * WHY THERE IS NO AGE TEST
 * contacts.age_range exists, but gating a marketing recommendation on the
 * client's age is protected-class targeting — the same reason the re-engagement
 * copy in lib/ai-isa/adaptive-reengagement.ts keeps age to tone and never to
 * eligibility. The qualifying signal here is the client's own SITUATION
 * (downsizing, senior-move), which contact_persona states directly and which a
 * person chooses rather than has. Age is deliberately not an input.
 *
 * The raw column is free text that has already drifted, so it is normalised
 * through the one canonical normaliser (lib/campaigns/contact-sources.ts:
 * normalizeContactPersona) rather than compared against a hand-rolled spelling.
 */
import { normalizeContactPersona, type CampaignPersona } from "@/lib/campaigns/contact-sources"

/**
 * Canonical personas that mean "long-time homeowner closing a chapter" — the
 * situation a memory video is for. Both are members of CAMPAIGN_PERSONAS, so a
 * drifted spelling such as `downsizer` / `downsizing` normalises into this set.
 */
export const MEMORY_VIDEO_PERSONAS: readonly CampaignPersona[] = ["downsize", "senior"]

/**
 * PURE — does this contact_persona warrant a memory-video recommendation?
 * Unknown, empty and non-qualifying personas all return false; nothing is
 * inferred from the absence of a persona.
 */
export function qualifiesForMemoryVideo(rawPersona: string | null | undefined): boolean {
  const persona = normalizeContactPersona(rawPersona)
  return persona !== null && MEMORY_VIDEO_PERSONAS.includes(persona)
}
