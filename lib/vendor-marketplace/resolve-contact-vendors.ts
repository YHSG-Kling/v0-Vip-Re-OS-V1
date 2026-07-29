/**
 * Resolve the curated vendor list a specific contact should see in their
 * portal — persona-aware, lifecycle-aware, team-aware.
 *
 * The vendor_directory table holds entries scoped by:
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
  /** Tags we'll OR-match against vendor_directory.audience_tags. */
  audienceTags:    string[]
}

// ─── Resolver ────────────────────────────────────────────────────────────

export async function resolveContactVendors(
  supabase: SupabaseClient,
  ctx:      ContactVendorContext,
): Promise<VendorDirectoryEntry[]> {
  if (!ctx.brokerageId) return []

  // CURATION LIVES IN vendor_directory; IDENTITY LIVES IN vendors.
  // This used to read `vendors` and hardcode preferred/audience_tags/stage_tags/
  // display_priority/visible_in_portal to null-or-empty, while the docstring
  // above kept describing the vendor_directory model in full. Everything that
  // docstring promises was therefore off: every contact saw every vendor
  // (empty tag arrays match all), nothing could be hidden from the portal, paid
  // placement never surfaced, and resolveVendorDisclosure() — which decides the
  // RESPA notice from `preferred` — could never reach its preferred_general
  // branch. m303 added vendor_directory.vendor_id so the two can be joined for
  // real instead of guessed at by name.
  //
  // The returned `id` is deliberately the VENDORS id, not the directory row id:
  // portal bookings FK to vendors(id) and the AfBA config matches on it, so a
  // directory id here would break booking. The directory supplies curation only.
  const { data: curated, error: curatedErr } = await supabase
    .from("vendor_directory")
    .select("id, vendor_id, name, category, phone, email, website, rating, notes, brokerage_id, team_id, preferred, audience_tags, stage_tags, display_priority, visible_in_portal, vendors!inner(id, name, category, phone, email, website, rating, notes, status)")
    .eq("brokerage_id", ctx.brokerageId)
    .not("vendor_id", "is", null)
    .neq("visible_in_portal", false)
    .eq("vendors.status", "active")

  let rows: VendorDirectoryEntry[]

  if (!curatedErr && curated && curated.length > 0) {
    rows = (curated as Array<Record<string, any>>).map((d): VendorDirectoryEntry => {
      const v = d.vendors as Record<string, any>
      return {
        // vendors is canonical for identity + contact; the directory may carry
        // its own copies, so prefer the bench and fall back to the curated row.
        id:       v.id as string,
        name:     (v.name ?? d.name) as string | null,
        category: (v.category ?? d.category) as string | null,
        phone:    (v.phone ?? d.phone) as string | null,
        email:    (v.email ?? d.email) as string | null,
        website:  (v.website ?? d.website) as string | null,
        rating:   (v.rating ?? d.rating) as number | null,
        notes:    (d.notes ?? v.notes) as string | null,
        brokerage_id: d.brokerage_id as string | null,
        // curation — the whole reason this table exists
        team_id:           d.team_id as string | null,
        preferred:         d.preferred as boolean | null,
        audience_tags:     Array.isArray(d.audience_tags) ? d.audience_tags : [],
        stage_tags:        Array.isArray(d.stage_tags) ? d.stage_tags : [],
        display_priority:  d.display_priority as number | null,
        visible_in_portal: d.visible_in_portal as boolean | null,
      }
    })
  } else {
    // UNCURATED BROKERAGE — an honest fallback, not a silent equivalence.
    // A tenant that has never curated its directory still gets a working portal
    // from the approved bench. The curation fields are null/empty because they
    // genuinely are not set, NOT because the columns were unreachable: with no
    // directory row there is no `preferred` to surface, so resolveVendorDisclosure
    // correctly returns no preferred_general notice. Broker approval
    // (status='active') is the only gate that exists in this state.
    const { data, error } = await supabase
      .from("vendors")
      .select("id, name, category, phone, email, website, rating, notes, brokerage_id")
      .eq("status", "active")
      .eq("brokerage_id", ctx.brokerageId)
    if (error || !data) return []
    rows = (data as Array<Record<string, any>>).map((r): VendorDirectoryEntry => ({
      id: r.id, name: r.name, category: r.category, phone: r.phone, email: r.email,
      website: r.website, rating: r.rating, notes: r.notes, brokerage_id: r.brokerage_id,
      team_id: null,
      preferred: null,
      audience_tags: [],
      stage_tags: [],
      display_priority: null,
      visible_in_portal: true,
    }))
  }

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
