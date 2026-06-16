// lib/intelligence/open-house-lead-routing.ts
//
// OPEN-HOUSE LEAD ROUTING (pure) — the cross-manager bridge from a SELLER event to the BUYER
// pipeline. An open house is the Listing Concierge's; the hot buyers who walk through it are the
// Shopping Agent / AI ISA's. Today those attendees get scored and bucketed into a COUNT and then
// vanish. This selects the hot buyer leads worth handing to the AI ISA to qualify — so a great
// Saturday open house turns into Monday's worked buyer pipeline, instead of a number on a dashboard.
// Pure (no I/O), unit-tested directly; the runner publishes the handoff over the bus.

export interface OpenHouseAttendeeLite {
  id: string
  /** the precomputed attendee lead score (open_house_attendees.ai_lead_score). */
  ai_lead_score?: number | null
  interest_level?: string | null
  name?: string | null
  email?: string | null
  phone?: string | null
  /** linked CRM contact, when the attendee is already in the system. */
  contact_id?: string | null
  /** has their own agent already? (don't poach represented buyers). */
  has_agent?: boolean | null
}

export interface OpenHouseHandoff {
  attendeeId: string
  score: number
  reason: string
  contactId: string | null
  name: string | null
}

const HOT_INTEREST = new Set(["ready_to_offer", "very_interested"])
const DEFAULT_MIN_SCORE = 70

/**
 * Select the hot, UNREPRESENTED open-house attendees worth handing to the AI ISA. Pure.
 * Hot = score ≥ minScore OR a hot interest level. Represented buyers (has_agent) are excluded —
 * we don't hand the ISA someone who already has an agent.
 */
export function selectOpenHouseHandoffs(
  attendees: OpenHouseAttendeeLite[],
  opts: { minScore?: number } = {},
): OpenHouseHandoff[] {
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE
  const out: OpenHouseHandoff[] = []
  for (const a of attendees ?? []) {
    if (a.has_agent) continue // represented — not ours to pursue
    const score = a.ai_lead_score ?? 0
    const hotInterest = HOT_INTEREST.has((a.interest_level ?? "").toLowerCase())
    if (score < minScore && !hotInterest) continue
    const reason = hotInterest
      ? `hot interest at the open house (${a.interest_level})`
      : `high attendee lead score (${score})`
    out.push({ attendeeId: a.id, score, reason, contactId: a.contact_id ?? null, name: a.name ?? null })
  }
  // Strongest first.
  return out.sort((x, y) => y.score - x.score)
}
