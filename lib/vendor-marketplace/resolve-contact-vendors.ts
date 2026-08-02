/**
 * Resolve the curated vendor list a specific contact should see in their
 * portal — persona-aware, lifecycle-aware, team-aware.
 *
 * The vendors table carries the curation columns (m355 — they used to live on a
 * separate vendor_directory table) and entries are scoped by:
 *   • brokerage_id (always set)
 *   • team_id (optional — when set, the entry is a team-curated pick)
 *   • audience_tags text[] (intersects contact persona / contact_type)
 *   • stage_tags text[]    (intersects current lifecycle stage)
 *   • visible_in_portal bool
 *   • display_priority int
 *
 * This function composes the right filter for the contact and returns
 * the rows in display order. UI then groups by category for rendering.
 *
 * Audience intersection rules:
 *   - empty audience_tags  → show to everyone
 *   - non-empty            → at least one of the contact's audience
 *                            descriptors must intersect (persona,
 *                            contact_type, contact_persona,
 *                            buyer_stage)
 * Stage intersection rules:
 *   - empty stage_tags     → show on every stage
 *   - non-empty            → contact's current stage must intersect
 *
 * Returns the union of brokerage-level entries + team-level entries
 * (when the contact's agent is on a team).
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

// ─── Types ───────────────────────────────────────────────────────────────

export interface VendorDirectoryEntry {
  id:               string
  name:             string | null
  category:         string | null
  phone:            string | null
  email:            string | null
  website:          string | null
  rating:           number | null
  notes:            string | null
  preferred:        boolean | null
  brokerage_id:     string | null
  team_id:          string | null
  audience_tags:    string[]
  stage_tags:       string[]
  display_priority: number | null
  visible_in_portal: boolean | null
}

export interface ContactVendorContext {
  contactId:       string
  brokerageId:     string | null
  teamId:          string | null
  /** Lifecycle tag derived from contact + transaction state (one of
   *  pre_listing | under_contract | closing_prep | closed | forever). */
  stage:           string | null
  /** Tags we'll OR-match against vendors.audience_tags. */
  audienceTags:    string[]
}

// ─── Resolver ────────────────────────────────────────────────────────────

export async function resolveContactVendors(
  supabase: SupabaseClient,
  ctx:      ContactVendorContext,
): Promise<VendorDirectoryEntry[]> {
  if (!ctx.brokerageId) return []

  // ONE VENDOR SYSTEM (m355). This used to fork: a "curated" branch reading
  // vendor_directory with a vendors!inner embed, and an "uncurated" fallback
  // reading vendors and hardcoding the five curation fields. Both branches
  // collapse into this single query, because placement now lives on the vendor
  // row — there is no second table to have or not have an entry in.
  //
  // BEHAVIOURAL DELTA, stated rather than buried: the old fallback branch
  // ignored visible_in_portal (it had no row to read it from, so it hardcoded
  // `true`). There is no fork now, so a vendor hidden from the portal is hidden
  // — always, for every brokerage. That is the intended semantics and the point
  // of the fix, but it IS a change: a brokerage that had never curated used to
  // show every approved vendor to every contact regardless of the flag.
  //
  // The returned `id` is a vendors.id — which is now the only vendor id there
  // is. Portal bookings FK to vendors(id) and the AfBA config matches on it.
  const { data, error } = await supabase
    .from("vendors")
    .select("id, name, category, phone, email, website, rating, notes, brokerage_id, team_id, preferred, audience_tags, stage_tags, display_priority, visible_in_portal")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("status", "active")
    .neq("visible_in_portal", false)

  if (error || !data) return []

  const rows: VendorDirectoryEntry[] = (data as Array<Record<string, any>>).map((r): VendorDirectoryEntry => ({
    id:       r.id as string,
    name:     r.name as string | null,
    category: r.category as string | null,
    phone:    r.phone as string | null,
    email:    r.email as string | null,
    website:  r.website as string | null,
    rating:   r.rating as number | null,
    notes:    r.notes as string | null,
    brokerage_id: r.brokerage_id as string | null,
    // curation — columns on the vendor row since m355
    team_id:           r.team_id as string | null,
    preferred:         r.preferred as boolean | null,
    audience_tags:     Array.isArray(r.audience_tags) ? r.audience_tags : [],
    stage_tags:        Array.isArray(r.stage_tags) ? r.stage_tags : [],
    display_priority:  r.display_priority as number | null,
    visible_in_portal: r.visible_in_portal as boolean | null,
  }))

  const audienceSet = new Set(ctx.audienceTags.filter(Boolean))
  const stageTag    = ctx.stage ?? null

  const matched = rows.filter((r) => {
    const audienceOk =
      !r.audience_tags || r.audience_tags.length === 0
        ? true
        : r.audience_tags.some((t) => audienceSet.has(t))
    const stageOk =
      !r.stage_tags || r.stage_tags.length === 0
        ? true
        : stageTag != null && r.stage_tags.includes(stageTag)
    return audienceOk && stageOk
  })

  // Sort: preferred + higher display_priority first, then alpha by category
  // for stable grouping in the UI.
  matched.sort((a, b) => {
    const pa = a.preferred ? 1 : 0
    const pb = b.preferred ? 1 : 0
    if (pa !== pb) return pb - pa
    const da = a.display_priority ?? 0
    const db = b.display_priority ?? 0
    if (da !== db) return db - da
    return (a.category ?? "").localeCompare(b.category ?? "")
  })

  return matched
}

// ─── Helpers used by callers to assemble audience tags for a contact ──────

/**
 * Derive the audience tags + stage to feed into resolveContactVendors().
 * Reads contact + agent + active transaction shape.
 *
 * Stage derivation is intentionally simple — broader semantic stages live
 * in lib/portal/resolve-education-context, but vendor surfacing needs only
 * coarse buckets so brokers can tag once.
 */
export function buildVendorAudienceTags(input: {
  contactType?:    string | null
  contactPersona?: string | null
  buyerStage?:     string | null
  portalView?:     "buyer" | "seller" | "lifetime" | string | null
  transactionStatus?: string | null
  closeDate?:      string | null
}): { audienceTags: string[]; stage: string | null } {
  const audienceTags: string[] = []

  if (input.contactType)    audienceTags.push(input.contactType)         // 'buyer' / 'seller' / 'past_client'
  if (input.contactPersona) audienceTags.push(input.contactPersona)      // 'first_time_buyer' / 'investor' / etc.
  if (input.buyerStage)     audienceTags.push(input.buyerStage)
  if (input.portalView === "lifetime") audienceTags.push("lifetime_customer")
  if (input.portalView === "seller")   audienceTags.push("seller")
  if (input.portalView === "buyer")    audienceTags.push("buyer")

  // Stage derivation
  let stage: string | null = null
  if (input.portalView === "lifetime") {
    stage = "forever"
  } else if (input.portalView === "seller") {
    stage = "pre_listing"
  } else if (input.transactionStatus) {
    if (["closed"].includes(input.transactionStatus))                          stage = "closed"
    else if (["pending","closing_prep","clear_to_close"].includes(input.transactionStatus)) stage = "closing_prep"
    else if (["under_contract","inspection","appraisal","financing"].includes(input.transactionStatus)) stage = "under_contract"
  }

  return { audienceTags, stage }
}
