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

  // vendors replaced vendor_directory — vendor_directory was a writer-less legacy twin (burn-down round 4 repoint).
  // vendors has no preferred/team_id/audience_tags/stage_tags/display_priority/visible_in_portal columns;
  // broker approval (status='active', the closest real portal-visibility flag) gates surfacing, and the
  // missing curation columns are filled with their "show to everyone" defaults below.
  const query = supabase
    .from("vendors")
    .select("id, name, category, phone, email, website, rating, notes, brokerage_id")
    .eq("status", "active")
    .eq("brokerage_id", ctx.brokerageId)

  const { data, error } = await query
  if (error || !data) return []

  // In-process audience + stage filter. Empty arrays = show-to-everyone.
  const rows = (data as Array<Omit<VendorDirectoryEntry, "preferred" | "team_id" | "audience_tags" | "stage_tags" | "display_priority" | "visible_in_portal">>).map(
    (r): VendorDirectoryEntry => ({
      ...r,
      preferred: null,
      team_id: null,
      audience_tags: [],
      stage_tags: [],
      display_priority: null,
      visible_in_portal: true,
    }),
  )
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
