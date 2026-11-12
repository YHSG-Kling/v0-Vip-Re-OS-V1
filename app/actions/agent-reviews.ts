"use server"

// app/actions/agent-reviews.ts
//
// OWNER DECISION (2026-09-07): "complete the building and editing for owner
// decisions … owners decision is build and fix." The recorded ruling in
// lib/kernel/reputation.ts (~line 295-330) established that `agent_reviews.source_url`
// is READ by the public profile (app/p/[agentSlug]/page.tsx) and the reputation
// surfaces, and WRITTEN BY NOBODY, because every review this OS holds is
// first-party — collected through our own portal, where there was never an
// external URL to record. THE MISSING HALF IS A FEATURE, NOT A WIRE:
// `source_url` is where a review lives on the platform it came FROM (Google /
// Zillow / Realtor.com / …), so a card can link out to the original. This file
// is that writer.
//
// GATE PATTERN copied from app/actions/multi-persona.ts:createTeam — a session
// client resolves the caller's identity (`supabase.auth.getUser()`), and the
// tenant is resolved FROM THAT SESSION, never from the request body (§4). Two
// admission classes are checked independently, per the owner's instruction:
//
//   1. TENANT ADMIN of the review's own brokerage — TENANT_ADMIN_USER_TYPES
//      via requireBrokerageAdmin (lib/auth/require-brokerage-admin.ts).
//   2. THE REVIEW'S OWN AGENT — agents.id and users.id are DISJOINT (§3), so
//      the caller's users.id is resolved to an agents.id through the one
//      canonical resolver, lib/kernel/agent-identity-resolver.ts, and compared
//      against the review's agent_id. Never compared directly.
//
// Neither check is short-circuited by the other succeeding for a DIFFERENT
// brokerage — both are evaluated and either admits.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireBrokerageAdmin, type BrokerageAdminContext } from "@/lib/auth/require-brokerage-admin"
import { resolveUserIdToAgentRecord } from "@/lib/kernel/agent-identity-resolver"
import { isValidUUID } from "@/lib/validations"

// ── THE ALLOW-LIST ───────────────────────────────────────────────────────────
// A review's `source_url` links OUT to the platform it actually came from.
// Restricted to https and to the handful of review platforms this product
// integrates with elsewhere (REVIEW_PLATFORMS in ReputationPanel.tsx /
// agent_reviews_platform_check: google | zillow | realtor_com | facebook |
// yelp), plus the two domains Google itself uses for a review's share link
// (maps.google.com, g.page). A bare match OR a subdomain of one of these is
// admitted (e.g. "www.google.com", "search.google.com").
const ALLOWED_SOURCE_HOSTS = new Set([
  "google.com",
  "maps.google.com",
  "g.page",
  "zillow.com",
  "realtor.com",
  "yelp.com",
  "facebook.com",
])

function isAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  for (const allowed of ALLOWED_SOURCE_HOSTS) {
    if (host === allowed || host.endsWith(`.${allowed}`)) return true
  }
  return false
}

/**
 * Validate and normalize a candidate source URL.
 * Returns `{ ok: true, value }` on success (value is `null` when the input
 * clears the field), or `{ ok: false, error }` on a refusal.
 */
function normalizeSourceUrl(sourceUrl: string | null): { ok: true; value: string | null } | { ok: false; error: string } {
  if (sourceUrl === null) return { ok: true, value: null }
  const trimmed = sourceUrl.trim()
  if (trimmed.length === 0) return { ok: true, value: null }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: "That is not a valid URL." }
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Only https:// links are allowed." }
  }
  if (!isAllowedHost(parsed.hostname)) {
    return {
      ok: false,
      error: `That host isn't on the allowed list (${Array.from(ALLOWED_SOURCE_HOSTS).join(", ")}).`,
    }
  }
  return { ok: true, value: trimmed }
}

export type AttachReviewSourceUrlResult = { ok: boolean; error?: string }

/**
 * Attach (or clear, with `sourceUrl: null`) the URL where a review lives on
 * the platform it came from.
 *
 * Authorization (both checked, either admits — see the file header):
 *   - the review must belong to the ACTOR's brokerage, resolved from the
 *     session, never from an argument; AND
 *   - the actor is either the review's own agent, or a tenant admin of that
 *     same brokerage.
 *
 * `.select("id")` + a length check on the final UPDATE (§3): a no-match write
 * resolves clean, and a wrong-tenant/wrong-agent write must not report success.
 */
export async function attachReviewSourceUrlAction(
  reviewId: string,
  sourceUrl: string | null,
): Promise<AttachReviewSourceUrlResult> {
  if (!isValidUUID(reviewId)) return { ok: false, error: "Invalid review id." }

  const normalized = normalizeSourceUrl(sourceUrl)
  if (!normalized.ok) return { ok: false, error: normalized.error }

  const supabase = await createClient()
  const { data: authData, error: authError } = await supabase.auth.getUser()
  if (authError) return { ok: false, error: `Could not verify your session: ${authError.message}` }
  const user = authData?.user
  if (!user) return { ok: false, error: "You must be signed in." }

  const service = createServiceClient()
  const { data: review, error: reviewErr } = await service
    .from("agent_reviews")
    .select("id, agent_id, brokerage_id")
    .eq("id", reviewId)
    .maybeSingle()
  if (reviewErr) return { ok: false, error: `Could not verify that review: ${reviewErr.message}` }
  if (!review) return { ok: false, error: "Review not found." }
  const reviewRow = review as { id: string; agent_id: string | null; brokerage_id: string }

  // ── CHECK 1: tenant admin of THIS review's brokerage ──────────────────────
  // requireBrokerageAdmin THROWS on refusal — a plain agent throws here too,
  // which is expected and falls through to check 2 rather than failing outright.
  let adminCtx: BrokerageAdminContext | null = null
  try {
    adminCtx = await requireBrokerageAdmin(supabase, user.id)
  } catch {
    adminCtx = null
  }
  const isTenantAdminOfThisBrokerage = adminCtx?.brokerageId === reviewRow.brokerage_id

  // ── CHECK 2: the review's own agent ────────────────────────────────────────
  // agents.id and users.id are DISJOINT (§3) — resolved through the canonical
  // helper, never compared directly, and scoped to the REVIEW's brokerage (not
  // whatever brokerage the admin check above may have resolved) so a caller who
  // is an agent in one tenant cannot claim a review filed under another.
  const agentRecordId = await resolveUserIdToAgentRecord(user.id, reviewRow.brokerage_id)
  const isReviewsOwnAgent = !!agentRecordId && !!reviewRow.agent_id && agentRecordId === reviewRow.agent_id

  if (!isTenantAdminOfThisBrokerage && !isReviewsOwnAgent) {
    return { ok: false, error: "That review is not yours to edit." }
  }

  const { data: updated, error: updateErr } = await service
    .from("agent_reviews")
    .update({ source_url: normalized.value, updated_at: new Date().toISOString() })
    .eq("id", reviewId)
    .eq("brokerage_id", reviewRow.brokerage_id)
    .select("id")

  if (updateErr) return { ok: false, error: updateErr.message }
  if ((updated ?? []).length === 0) {
    return { ok: false, error: "That review could not be updated — it may no longer exist." }
  }

  return { ok: true }
}
