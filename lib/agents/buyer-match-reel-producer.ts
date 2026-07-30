/**
 * lib/agents/buyer-match-reel-producer.ts
 *
 * Wave 59 — buyer-side AUTO-handoff (VIDEO): when a buyer gets fresh high-score
 * property matches, auto-produce a personalized "homes matching your search" reel —
 * zero agent effort. It reuses the AffordabilitySnapshotReel composition (3 listing
 * cards) fed with the buyer's TOP matches and enqueues a render through the canonical
 * deliverable-gated render queue (remotion_composition_renders). The finished reel is
 * captured to the marketing library (existing render-coordinator flow) for the agent
 * to send. NO new composition — reuse, not duplicate. Idempotent (one reel per buyer
 * per week). Fair-Housing safe (only the home facts + market, no demographics).
 */
import { createServiceClient } from "@/lib/supabase/service"
import { sanitizeProperNoun } from "@/lib/compliance/client-text-guard"
import type { PropertyFacts } from "@/lib/property/resolve-property-facts"

export interface BuyerMatchReelResult { queued: boolean; renderId?: string; reason?: string }

const COMPOSITION_ID = "AffordabilitySnapshotReel"
const REEL_COOLDOWN_DAYS = 7
const MATCH_SCORE_THRESHOLD = 85
const MAX_CARDS = 3

/** Pure: build the AffordabilitySnapshotReel inputProps from resolved property facts
 *  (works whether the match is our listing OR an external MLS/RentCast/IDX property). */
export function buildBuyerMatchReelProps(
  facts: PropertyFacts[],
  ctx: { agentName: string; agentPhone: string; brokerageName: string },
): Record<string, unknown> | null {
  const examples = facts
    .filter((f) => f && (f.address || f.city))
    .slice(0, MAX_CARDS)
    .map((f) => ({
      address:   sanitizeProperNoun(f.address, 60) ?? "Address on request",
      cityState: [sanitizeProperNoun(f.city, 40), f.state].filter(Boolean).join(", ") || "Your area",
      price:     typeof f.price === "number" ? `$${Math.round(f.price).toLocaleString()}` : "Ask",
      bedrooms:  f.bedrooms != null ? String(f.bedrooms) : "—",
      bathrooms: f.bathrooms != null ? String(f.bathrooms) : "—",
      photoUrl:  f.photoUrl ?? null,
    }))
  if (examples.length === 0) return null
  const areaName = (examples[0].cityState.split(",")[0] || "your area").trim()
  return {
    monthlyHeadline: "Fresh homes matching your search",
    areaName,
    period:          "This week",
    examples,
    ratesAssumption: "New matches based on your saved search · ask your agent for the full list",
    ctaLabel:        "See your full list",
    agentName:       ctx.agentName,
    agentPhone:      ctx.agentPhone,
    brand: { primaryColor: "#0F172A", accentColor: "#F59E0B", brokerageName: ctx.brokerageName, showEhoMark: true },
  }
}

/**
 * THE FACTS this reel asserts — read-only (no QR minting, no writes), so the
 * living-video sweep can re-derive them cheaply and tell whether the reel has
 * started showing homes that are gone.
 *
 * Availability is the point. saved_properties (the external/MLS snapshot cache)
 * has no status column, so third-party matches are counted as UNVERIFIABLE
 * rather than assumed available — we do not invent bad news about a listing we
 * cannot see.
 */
export async function buyerMatchFacts(
  supabase: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  contactId: string,
): Promise<import("@/lib/video/living-video").LivingFacts | null> {
  const { data: c } = await supabase
    .from("contacts").select("id, brokerage_id, agent_id").eq("id", contactId).maybeSingle()
  const contact = c as { brokerage_id: string | null; agent_id: string | null } | null
  if (!contact || contact.brokerage_id !== brokerageId) return null

  const { data: pm } = await supabase.from("property_matches")
    .select("property_id, match_score")
    .eq("brokerage_id", brokerageId).eq("contact_id", contactId)
    .gte("match_score", MATCH_SCORE_THRESHOLD)
    .order("match_score", { ascending: false }).limit(MAX_CARDS)
  const propertyIds = ((pm ?? []) as Array<{ property_id: string | null }>)
    .map((r) => r.property_id).filter(Boolean) as string[]

  const { resolvePropertyFacts, isUnavailableStatus } = await import("@/lib/property/resolve-property-facts")
  const factsMap = await resolvePropertyFacts(supabase, brokerageId, propertyIds)
  const shown = propertyIds.map((id) => factsMap.get(id)).filter(Boolean) as PropertyFacts[]

  let agentName = "Your Agent"
  if (contact.agent_id) {
    const { data: a } = await supabase.from("agents").select("user_id").eq("id", contact.agent_id).maybeSingle()
    const uid = (a as { user_id: string | null } | null)?.user_id ?? null
    if (uid) {
      const { data: u } = await supabase.from("users").select("first_name, last_name").eq("id", uid).maybeSingle()
      const full = [(u as any)?.first_name, (u as any)?.last_name].filter(Boolean).join(" ").trim()
      if (full) agentName = full
    }
  }

  return {
    shownCount: shown.length,
    unavailableCount: shown.filter((f) => isUnavailableStatus(f.status)).length,
    unverifiableCount: shown.filter((f) => f.status === null).length,
    // Order matters — the cards are ordered by match score, so a re-order IS a
    // different reel. Joined rather than hashed so a human can read the diff.
    priceSignature: shown.map((f) => (f.price == null ? "?" : String(Math.round(f.price)))).join("|"),
    matchSetSignature: shown.map((f) => f.id).join("|"),
    agentName,
  }
}

/**
 * Enqueue a personalized buyer property-match reel render (deliverable-gated).
 *
 * Idempotent — at most one reel per buyer per REEL_COOLDOWN_DAYS. `force` is the
 * LIVING refresh: the cooldown is a spam guard against the cadence cron, not a
 * rule that a buyer must keep being shown a home that went under contract on
 * Tuesday.
 */
export async function produceBuyerMatchReel(
  brokerageId: string, contactId: string, client?: ReturnType<typeof createServiceClient>,
  opts: { force?: boolean; refreshedFromRenderId?: string | null } = {},
): Promise<BuyerMatchReelResult> {
  const supabase = client ?? createServiceClient()
  if (!brokerageId || !contactId) return { queued: false, reason: "missing ids" }

  const { data: c } = await supabase
    .from("contacts").select("id, brokerage_id, agent_id").eq("id", contactId).maybeSingle()
  const contact = c as { id: string; brokerage_id: string | null; agent_id: string | null } | null
  if (!contact || contact.brokerage_id !== brokerageId) return { queued: false, reason: "contact not in brokerage" }

  // Idempotent — skip if a reel for this buyer was queued/rendered within the cooldown.
  const sinceIso = new Date(Date.now() - REEL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const { data: recent } = await supabase.from("remotion_composition_renders")
    .select("id").eq("brokerage_id", brokerageId).eq("composition_id", COMPOSITION_ID)
    .eq("entity_type", "contact").eq("entity_id", contactId)
    .gte("created_at", sinceIso).limit(1).maybeSingle()
  if (recent && !opts.force) return { queued: false, reason: "reel already produced this week" }

  // Top high-score matches → resolve facts from EITHER our listings OR the external/MLS
  // cache (RentCast / IDX), via the unified resolver. property_matches.property_id is a
  // uuid (listings.id or saved_properties.id); never relies on a PostgREST embed.
  const { data: pm } = await supabase.from("property_matches")
    .select("property_id, match_score")
    .eq("brokerage_id", brokerageId).eq("contact_id", contactId)
    .gte("match_score", MATCH_SCORE_THRESHOLD)
    .order("match_score", { ascending: false }).limit(MAX_CARDS)
  const pmRows = (pm ?? []) as Array<{ property_id: string | null; match_score: number | null }>
  const propertyIds = pmRows.map((r) => r.property_id).filter(Boolean) as string[]
  if (propertyIds.length === 0) return { queued: false, reason: "no high-score matches" }

  const { resolvePropertyFacts } = await import("@/lib/property/resolve-property-facts")
  const factsMap = await resolvePropertyFacts(supabase, brokerageId, propertyIds)
  // Preserve match order (highest score first); keep only resolvable properties.
  const facts = propertyIds.map((id) => factsMap.get(id)).filter(Boolean) as PropertyFacts[]
  if (facts.length === 0) return { queued: false, reason: "no renderable properties for matches" }

  // Agent display name + phone for the card footer.
  let agentName = "Your Agent"; let agentPhone = ""; let agentUserId: string | null = null
  if (contact.agent_id) {
    const { data: a } = await supabase.from("agents").select("user_id").eq("id", contact.agent_id).maybeSingle()
    agentUserId = (a as { user_id: string | null } | null)?.user_id ?? null
    if (agentUserId) {
      const { data: u } = await supabase.from("users").select("first_name, last_name, phone").eq("id", agentUserId).maybeSingle()
      const full = [(u as any)?.first_name, (u as any)?.last_name].filter(Boolean).join(" ").trim()
      if (full) agentName = full
      if ((u as any)?.phone) agentPhone = String((u as any).phone)
    }
  }
  let brokerageName = "Your Brokerage"
  const { data: b } = await supabase.from("brokerages").select("name").eq("id", brokerageId).maybeSingle()
  if ((b as { name?: string } | null)?.name) brokerageName = String((b as { name: string }).name)

  const inputProps = buildBuyerMatchReelProps(facts, { agentName, agentPhone, brokerageName })
  if (!inputProps) return { queued: false, reason: "no renderable matches" }

  // TRACKED QR on the outro (owner rule: QR on every non-selfie video) — the
  // buyer scans to book; idempotent per contact via the shared tracked-QR core.
  try {
    if (agentUserId) {
      const { mintVideoQr } = await import("@/lib/video/video-qr")
      const minted = await mintVideoQr({ brokerageId, agentUserId, kind: "explainer", contactId }, supabase)
      if (minted) {
        ;(inputProps as Record<string, unknown>).qrCodeDataUrl = minted.qrCodeDataUrl
        ;(inputProps as Record<string, unknown>).qrCaption = "Scan to book a tour"
      }
    }
  } catch { /* QR is additive */ }

  // The LIVING identity — what this reel asserts, so the sweep can re-derive it.
  const { computeFactsKey } = await import("@/lib/video/living-video")
  const livingFacts = await buyerMatchFacts(supabase, brokerageId, contactId)

  const { recordRenderQueued } = await import("@/lib/remotion/registry")
  const r = await recordRenderQueued({
    brokerageId, compositionId: COMPOSITION_ID, agentUserId,
    entityType: "contact", entityId: contactId,
    inputProps, scopeType: "brokerage", scopeId: brokerageId, requestedVia: "cron",
    livingKind: livingFacts ? "buyer_match_reel" : null,
    factsKey: livingFacts ? computeFactsKey("buyer_match_reel", livingFacts) : null,
    facts: livingFacts ?? null,
    refreshedFromRenderId: opts.refreshedFromRenderId ?? null,
  })
  return r.ok ? { queued: true, renderId: r.renderId } : { queued: false, reason: r.error }
}
