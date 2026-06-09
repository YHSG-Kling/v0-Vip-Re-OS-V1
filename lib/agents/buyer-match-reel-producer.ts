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

export interface BuyerMatchReelResult { queued: boolean; renderId?: string; reason?: string }

const COMPOSITION_ID = "AffordabilitySnapshotReel"
const REEL_COOLDOWN_DAYS = 7
const MATCH_SCORE_THRESHOLD = 85
const MAX_CARDS = 3

interface MatchRow {
  property_id: string | null
  match_score: number | null
  listings: {
    address?: string | null; city?: string | null; state?: string | null
    list_price?: number | null; bedrooms?: number | null; bathrooms?: number | null
  } | null
}

/** Pure: build the AffordabilitySnapshotReel inputProps from the buyer's matches. */
export function buildBuyerMatchReelProps(
  matches: MatchRow[],
  ctx: { agentName: string; agentPhone: string; brokerageName: string },
): Record<string, unknown> | null {
  const examples = matches
    .filter((m) => m.listings && (m.listings.address || m.listings.city))
    .slice(0, MAX_CARDS)
    .map((m) => {
      const l = m.listings!
      return {
        address:   sanitizeProperNoun(l.address, 60) ?? "Address on request",
        cityState: [sanitizeProperNoun(l.city, 40), l.state].filter(Boolean).join(", ") || "Your area",
        price:     typeof l.list_price === "number" ? `$${Math.round(l.list_price).toLocaleString()}` : "Ask",
        bedrooms:  l.bedrooms != null ? String(l.bedrooms) : "—",
        bathrooms: l.bathrooms != null ? String(l.bathrooms) : "—",
        photoUrl:  null,
      }
    })
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
 * Enqueue a personalized buyer property-match reel render (deliverable-gated).
 * Idempotent — at most one reel per buyer per REEL_COOLDOWN_DAYS.
 */
export async function produceBuyerMatchReel(
  brokerageId: string, contactId: string, client?: ReturnType<typeof createServiceClient>,
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
  if (recent) return { queued: false, reason: "reel already produced this week" }

  // Top high-score matches, then resolve their listing facts. property_matches.property_id
  // references listings.id by convention (no FK), so load + join in JS — never rely on a
  // PostgREST embed that can't resolve without the relationship.
  const { data: pm } = await supabase.from("property_matches")
    .select("property_id, match_score")
    .eq("brokerage_id", brokerageId).eq("contact_id", contactId)
    .gte("match_score", MATCH_SCORE_THRESHOLD)
    .order("match_score", { ascending: false }).limit(MAX_CARDS)
  const pmRows = (pm ?? []) as Array<{ property_id: string | null; match_score: number | null }>
  const propertyIds = pmRows.map((r) => r.property_id).filter(Boolean) as string[]
  if (propertyIds.length === 0) return { queued: false, reason: "no high-score matches" }

  const { data: ls } = await supabase.from("listings")
    .select("id, address, city, state, list_price, bedrooms, bathrooms")
    .eq("brokerage_id", brokerageId).in("id", propertyIds)
  const byId = new Map((ls ?? []).map((l: any) => [l.id as string, l]))
  const matches: MatchRow[] = pmRows.map((r) => ({
    property_id: r.property_id, match_score: r.match_score,
    listings: r.property_id ? (byId.get(r.property_id) ?? null) : null,
  }))
  if (!matches.some((m) => m.listings)) return { queued: false, reason: "no renderable listings for matches" }

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

  const inputProps = buildBuyerMatchReelProps(matches, { agentName, agentPhone, brokerageName })
  if (!inputProps) return { queued: false, reason: "no renderable matches" }

  const { recordRenderQueued } = await import("@/lib/remotion/registry")
  const r = await recordRenderQueued({
    brokerageId, compositionId: COMPOSITION_ID, agentUserId,
    entityType: "contact", entityId: contactId,
    inputProps, scopeType: "brokerage", scopeId: brokerageId, requestedVia: "cron",
  })
  return r.ok ? { queued: true, renderId: r.renderId } : { queued: false, reason: r.error }
}
