"use server"

import { generateTextRouted as generateText } from "@/lib/ai/models"
// THE SPEND ACTOR. Every export in this "use server" file is a public HTTP
// endpoint, so the AI cost ledger's tenant can only come from the SESSION
// (CLAUDE.md §4) — never from an id the caller supplied.
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { getBrandVoiceProfile } from "@/app/actions/ai-content-generation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { guardComingSoonCreativeText, resolveComingSoonCreativeAddress } from "@/lib/marketing/listing-public-address"

/**
 * AI social + email teaser for a Coming Soon listing.
 *
 * Wave 145 (lane 145Z, owner ruling 1 — lane 145B Outside-lane 1): the listing is read with the SESSION client pinned
 * to the session's brokerage (never an address the caller typed), the prompt is given ONLY the line public Coming Soon
 * creative may print (`resolveComingSoonCreativeAddress` — "City, ST" unless the seller AND the attested MLS rule
 * permit the street), and both drafts pass the street-address scrubber in REDACT mode (AI copy) before the person sees
 * them. Owner ruling 2: the launch date the copy names is the seller-agreed MLS live date (`listings.go_live_date`,
 * written from the executed listing agreement), not the card's slider — the slider is used only when no date is recorded.
 */
export async function generateComingSoonContent(params: {
  /** @deprecated ignored for the spend actor — the session decides. Still used for the agent's brand voice. */
  agentId: string
  listingId: string
  /** @deprecated ignored — the address line is resolved from the listing under the Coming Soon address rule. */
  listingAddress?: string
  daysUntilLaunch: number
  launchDateStr: string
}): Promise<{ success: boolean; socialPost?: string; emailBody?: string; error?: string }> {
  const { agentId, listingId } = params

  // Tenant for the AI cost ledger — SESSION, never `params.agentId` (§4).
  const spendActor = await getAgentContext()
  if (!spendActor.brokerageId) return { success: false, error: "Not signed in to a brokerage" }
  return ledgered(spendActor, { action: "marketing.coming_soon_content.generate", subject: { type: "listing", id: listingId || null }, riskClass: "LOW_RISK_WRITE" }, async () => {
  if (!listingId) return { success: false, error: "listingId is required" }

  const supabase = await createClient()
  const { data: row, error: readErr } = await supabase
    .from("listings")
    .select("id, brokerage_id, address, city, state, zip, go_live_date")
    .eq("id", listingId)
    .eq("brokerage_id", spendActor.brokerageId)
    .maybeSingle()
  if (readErr) return { success: false, error: `The listing could not be read (${readErr.message})` }
  if (!row) return { success: false, error: "That listing is not in your brokerage" }
  const listing = row as { id: string; brokerage_id: string; address: string | null; city: string | null; state: string | null; zip: string | null; go_live_date: string | null }

  // The address rule (fail closed inside: an unreadable policy or agreement withholds the street).
  const svc = createServiceClient()
  const resolved = await resolveComingSoonCreativeAddress({ policyClient: svc as any, termsClient: svc as any, listing })

  // The agreed date, when recorded (ruling 2) — otherwise the person's slider.
  let daysUntilLaunch = params.daysUntilLaunch
  let launchDateStr = params.launchDateStr
  if (listing.go_live_date) {
    const agreed = new Date(`${String(listing.go_live_date).slice(0, 10)}T12:00:00`)
    if (!Number.isNaN(agreed.getTime())) {
      daysUntilLaunch = Math.max(0, Math.ceil((agreed.getTime() - Date.now()) / 86_400_000))
      launchDateStr = agreed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    }
  }

  const brandVoice = await getBrandVoiceProfile(agentId).catch(() => null)
  const tone = (brandVoice as any)?.tone ?? "exciting and professional"

  try {
    const { text } = await generateText({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
      model: "openai/gpt-4o-mini",
      prompt: `Write a coming soon real estate listing announcement.
Property location: ${resolved.addressLine}.${resolved.decision.disclose ? "" : " Do NOT include a street address — name only the location above."}
Going live in ${daysUntilLaunch} days (${launchDateStr}).
Tone: ${tone}.
Generate two versions separated by "---EMAIL---":
1. Social post (2-3 sentences, engaging, includes CTA to request a showing)
2. Email teaser (4-5 sentences, builds anticipation, includes showing request CTA)
Format: social content first, then ---EMAIL--- then email content.`,
    })

    const parts = text.split("---EMAIL---")
    const social = guardComingSoonCreativeText((parts[0] ?? "").trim(), listing, resolved, "redact")
    const email = guardComingSoonCreativeText((parts[1] ?? "").trim(), listing, resolved, "redact")

    // THE FINAL PERSONALIZATION PHASE (owner ruling 20 / contract C4 — wave 145, lane 145Z; lane 145G Outside-lane 3 + lane 145B
    // Outside-lane 19): both drafts pass finalizeForDistribution (assetKind listing_creative — machine phrasing removed, facts kept,
    // the brand's tagline appended) AFTER the address guard, and the guard runs AGAIN on the final so humanization can never put
    // the street back. The person reviews this final in the card and their reviewed copy is what activation checks and posts.
    const { finalizeForDistribution, resolveTenantBrandForFinal } = await import("@/lib/marketing/humanize-final")
    const brand = await resolveTenantBrandForFinal(svc as any, { brokerageId: listing.brokerage_id, agentUserId: spendActor.userId || null }).catch(() => ({ brand: null as any, error: "brand unreadable" }))
    const finalOf = async (draft: string): Promise<string> => {
      if (!draft) return draft
      const final = await finalizeForDistribution({ assetKind: "listing_creative", text: draft, tenantBrand: brand.brand ?? null })
      return guardComingSoonCreativeText(final.text, listing, resolved, "redact").text
    }
    return {
      success: true,
      socialPost: await finalOf(social.text),
      emailBody: await finalOf(email.text),
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "AI generation failed",
    }
  }
  })
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
