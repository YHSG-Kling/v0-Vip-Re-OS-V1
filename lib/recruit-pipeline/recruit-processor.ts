// lib/recruit-pipeline/recruit-processor.ts
// Recruiting sourcing pipeline — the recruiting analogue of
// lib/lead-pipeline/pipeline-processor.ts. Promotes a platform-owned
// raw_recruit_prospects row (an agent/team showing intent to switch brokerages,
// scraped from social/forum or job-board/review sources) into the
// brokerage-owned `recruits` table.
//
// Like the lead pipeline: raw records are platform-owned (brokerage_id NULL)
// and carry market_id (the active-subscriber territory). The owning brokerage is
// resolved from the market at promotion — brokerages never see raw prospects.

import { createClient } from "@/lib/supabase/server"

type RecruitProcessingStatus =
  | "pending"
  | "processing"
  | "territory_mismatch"
  | "insufficient_identity"
  | "duplicate"
  | "unassigned_no_market"
  | "promoted"
  | "error"

export interface RecruitPipelineResult {
  success: boolean
  action: "created" | "skipped" | "error"
  recruitId?: string
  reason: string
  stage: string
}

interface RawRecruitPreview {
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  phone?: string | null
  licenseState?: string | null
  currentBrokerage?: string | null
  yearsExperience?: number | null
  annualVolume?: number | null
  city?: string | null
  state?: string | null
}

async function setStatus(
  supabase: Awaited<ReturnType<typeof createClient>>,
  id: string,
  status: RecruitProcessingStatus,
) {
  await supabase
    .from("raw_recruit_prospects")
    .update({
      processing_status: status,
      ...(status === "promoted" || status === "error" ? { processed_at: new Date().toISOString() } : {}),
    })
    .eq("id", id)
}

/**
 * Promote one raw recruiting prospect into `recruits`.
 * @param brokerageId optional — falls back to the scraped market's brokerage
 *   (platform-scraped prospects leave raw_recruit_prospects.brokerage_id NULL).
 */
export async function processRawRecruit(
  rawId: string,
  brokerageId?: string | null,
): Promise<RecruitPipelineResult> {
  const supabase = await createClient()

  await setStatus(supabase, rawId, "processing")

  const { data: raw, error: fetchError } = await supabase
    .from("raw_recruit_prospects")
    .select("*")
    .eq("id", rawId)
    .single()

  if (fetchError || !raw) {
    return { success: false, action: "skipped", reason: "Raw recruit prospect not found", stage: "fetch" }
  }

  const preview = (raw.normalized_preview ?? {}) as RawRecruitPreview
  const firstName = (preview.firstName ?? "").trim()
  const lastName = (preview.lastName ?? "").trim()
  const email = preview.email?.trim() || null

  // ── Territory gate + brokerage resolution ──────────────────────────────────
  let marketBrokerageId: string | null = null
  if (raw.market_id) {
    const { data: market } = await supabase
      .from("lead_scraping_markets")
      .select("state, brokerage_id")
      .eq("id", raw.market_id)
      .single()
    if (market) {
      marketBrokerageId = (market as { brokerage_id?: string | null }).brokerage_id ?? null
      // Recruiting territory is license-state based: the prospect's license_state
      // (or geo state) must match the market's state when both are known.
      const recruitState = (preview.licenseState ?? preview.state ?? "").trim().toUpperCase()
      const marketState = ((market as { state?: string | null }).state ?? "").trim().toUpperCase()
      if (recruitState && marketState && recruitState !== marketState) {
        await setStatus(supabase, rawId, "territory_mismatch")
        return {
          success: false,
          action: "skipped",
          reason: `Territory mismatch: ${recruitState} not in market state ${marketState}`,
          stage: "territory_gate",
        }
      }
    }
  }

  const effectiveBrokerageId = brokerageId ?? marketBrokerageId
  if (!effectiveBrokerageId) {
    // PLATFORM PROSPECT CAPTURE (2026-07 growth directive) — a switch-intent
    // agent in a territory NO subscriber owns isn't waste: nobody can recruit
    // them in-app, which makes them OUR prospect (a solo-tier OS customer).
    // Idempotent by email (the growth funnel's own upsert key); platform
    // staff work the funnel — nothing auto-sends to the prospect.
    const fullName = [firstName, lastName].filter(Boolean).join(" ").trim()
    if (email && fullName) {
      try {
        await supabase.from("platform_prospects").upsert({
          name: fullName,
          email,
          company: preview.currentBrokerage ?? null,
          role_interest: "solo_agent",
          source: "recruit_scrape_unclaimed_territory",
          interest_note: `Switch-intent signal scraped in an unclaimed territory${preview.licenseState ? ` (${preview.licenseState})` : ""} — no subscribing brokerage can work them; a direct solo-tier OS prospect.`,
          updated_at: new Date().toISOString(),
        }, { onConflict: "email" })
      } catch { /* capture is additive — the recruit pipeline verdict stands */ }
    }
    await setStatus(supabase, rawId, "unassigned_no_market")
    return {
      success: false,
      action: "skipped",
      reason: "Cannot resolve owning brokerage (no brokerageId and no market territory)" + (email && fullName ? " — captured as a PLATFORM prospect (solo-tier)" : ""),
      stage: "brokerage_resolution",
    }
  }

  // ── Identity gate — need a full name plus one anchor (email or current brokerage) ──
  const hasAnchor = !!email || !!preview.currentBrokerage
  if (!firstName || !lastName || !hasAnchor) {
    await setStatus(supabase, rawId, "insufficient_identity")
    return {
      success: false,
      action: "skipped",
      reason: "Requires full name + (email or current brokerage) to promote a recruit",
      stage: "identity_gate",
    }
  }

  // ── Dedup against existing recruits in the owning brokerage ─────────────────
  let dupQuery = supabase
    .from("recruits")
    .select("id")
    .eq("brokerage_id", effectiveBrokerageId)
  dupQuery = email
    ? dupQuery.eq("email", email)
    : dupQuery.ilike("first_name", firstName).ilike("last_name", lastName)
  const { data: existing } = await dupQuery.limit(1).maybeSingle()

  if (existing?.id) {
    await supabase
      .from("raw_recruit_prospects")
      .update({ recruit_id: existing.id, processing_status: "duplicate", processed_at: new Date().toISOString() })
      .eq("id", rawId)
    return { success: true, action: "skipped", recruitId: existing.id, reason: "Duplicate of existing recruit", stage: "dedup" }
  }

  // ── Promote → recruits (brokerage-owned) ────────────────────────────────────
  const { data: recruit, error: createError } = await supabase
    .from("recruits")
    .insert({
      brokerage_id:     effectiveBrokerageId,
      first_name:       firstName,
      last_name:        lastName,
      email,
      phone:            preview.phone ?? null,
      license_state:    preview.licenseState ?? null,
      current_brokerage: preview.currentBrokerage ?? null,
      years_experience: preview.yearsExperience ?? null,
      annual_volume:    preview.annualVolume ?? null,
      status:           "prospect",
      referral_source:  raw.source,
    })
    .select("id")
    .single()

  if (createError || !recruit) {
    await setStatus(supabase, rawId, "error")
    return { success: false, action: "error", reason: `Failed to create recruit: ${createError?.message}`, stage: "promotion" }
  }

  await supabase
    .from("raw_recruit_prospects")
    .update({ recruit_id: recruit.id, processing_status: "promoted", processed_at: new Date().toISOString() })
    .eq("id", rawId)

  return { success: true, action: "created", recruitId: recruit.id, reason: "New recruit created", stage: "promotion" }
}
