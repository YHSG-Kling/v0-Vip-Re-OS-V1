// lib/kernel/vendor-verification.ts
//
// VENDOR VERIFICATION + APPROVAL GATE (compliance_officer) — the VendorVerificationManager concept. Today
// a vendor is created or invited and is immediately usable; nothing VETS them before the marketplace puts
// them in front of an agent or client. This adds the gate: a pure application SCORE + an admin approval
// queue, and NO vendor self-activates (only an admin/broker transitions a vendor to active).
//
// HONEST framing: the score is a COMPLETENESS + RISK heuristic over the signals the app actually has
// (contact reachability, a valid service category, a real service area/turnaround, and duplicate
// detection) — it is NOT a fabricated background check or license lookup (the app has no such data source
// for service vendors). A high score means "clean, complete, non-duplicate application, safe to fast-track
// a human approval"; a low score means "an admin should look closely." The human still approves.
//
// Pure core (testable); the service actions (submit/approve/reject) live in app/actions/vendor-verification.

import { VENDOR_CATEGORIES } from "@/lib/kernel/vendor-categories"

export const AUTO_OK_THRESHOLD = 70
export const REJECT_HINT_THRESHOLD = 40

export type VerificationRecommendation = "auto_ok" | "review" | "reject_recommended"

/** The allowed service categories for the operational bench (mirrors the vendors.category CHECK). */
const VALID_CATEGORIES = new Set<string>(VENDOR_CATEGORIES)

export interface VendorApplicationSignals {
  name: string | null | undefined
  email: string | null | undefined
  phone: string | null | undefined
  website: string | null | undefined
  category: string | null | undefined
  /** Days to complete a job — a real operational detail an established vendor can state. */
  estimatedTurnaroundDays?: number | null
  /** Set when another active vendor in the brokerage shares this (name, category) — a likely duplicate. */
  isDuplicate?: boolean
}

export interface VerificationResult {
  score: number
  flags: string[]
  recommendation: VerificationRecommendation
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /\d{3}.*\d{3}.*\d{4}/

/**
 * PURE: score a vendor application 0..100 from completeness + risk signals, and recommend a disposition.
 * Weights (documented, honest): reachable contact (email 20 + phone 15), a real web presence (15), a
 * valid service category (25), a stated turnaround (10), and a non-duplicate application (15). A duplicate
 * both zeroes its 15 AND caps the recommendation at reject (a dupe is the strongest bad signal). Missing
 * pieces are NAMED as flags so the admin sees exactly what's thin — nothing is invented.
 */
export function scoreVendorApplication(input: VendorApplicationSignals): VerificationResult {
  const flags: string[] = []
  let score = 0

  const email = (input.email ?? "").trim()
  if (EMAIL_RE.test(email)) score += 20
  else flags.push("no_valid_email")

  const phone = (input.phone ?? "").trim()
  if (PHONE_RE.test(phone)) score += 15
  else flags.push("no_valid_phone")

  const website = (input.website ?? "").trim()
  if (website.length > 3) score += 15
  else flags.push("no_website")

  const category = (input.category ?? "").trim()
  if (VALID_CATEGORIES.has(category)) score += 25
  else flags.push("invalid_or_missing_category")

  if (typeof input.estimatedTurnaroundDays === "number" && input.estimatedTurnaroundDays > 0) score += 10
  else flags.push("no_stated_turnaround")

  if (!(input.name ?? "").trim()) flags.push("no_name")

  if (input.isDuplicate) {
    flags.push("duplicate_of_existing_vendor")
  } else {
    score += 15
  }

  score = Math.max(0, Math.min(100, score))

  let recommendation: VerificationRecommendation
  if (input.isDuplicate || score < REJECT_HINT_THRESHOLD) recommendation = "reject_recommended"
  else if (score >= AUTO_OK_THRESHOLD) recommendation = "auto_ok"
  else recommendation = "review"

  return { score, flags, recommendation }
}

// ─── Status state machine (no self-activate) ───────────────────────────────────
export type VendorStatus = "pending" | "active" | "inactive" | "archived"

/** The statuses a vendor may hold that make it eligible to be surfaced/auto-picked. Null (legacy rows) is
 *  treated as active for backward-compatibility; explicit pending/inactive/archived are NOT surfaced. */
export const SURFACEABLE_STATUSES = new Set(["active"])
export const NON_SURFACEABLE_STATUSES = ["pending", "inactive", "archived"]

/** PURE: is this transition allowed? Only an admin path reaches 'active' (enforced by the action's role
 *  gate); a vendor can never move itself to active. */
export function canTransition(from: VendorStatus | null, to: VendorStatus): boolean {
  const f = from ?? "active"
  if (f === "archived") return false            // terminal
  if (to === from) return false
  const allowed: Record<string, VendorStatus[]> = {
    pending: ["active", "inactive", "archived"],
    active: ["inactive", "archived"],
    inactive: ["active", "archived"],
  }
  return (allowed[f] ?? []).includes(to)
}

// ─── The approval queue (gated admin brief; rides the vendor cron) ─────────────
import type { createServiceClient } from "@/lib/supabase/service"
type Svc = ReturnType<typeof createServiceClient>

export interface ApprovalQueueResult { pending: number; briefProposed: boolean }

/**
 * Score any un-scored pending vendors and propose ONE gated approval-queue brief to the broker/admins
 * naming the vendors awaiting approval + their AI verification score + recommendation. Deduped per
 * (brokerage, ISO week). Nothing auto-approves — a human clears the queue via approveVendor.
 */
export async function runVendorApprovalQueue(svc: Svc, params: { brokerageId: string; now?: Date }): Promise<ApprovalQueueResult> {
  const out: ApprovalQueueResult = { pending: 0, briefProposed: false }
  const now = params.now ?? new Date()

  const { data: pendingRows } = await svc.from("vendors")
    .select("id, name, category, email, phone, website, estimated_turnaround_days, ai_verification_score")
    .eq("brokerage_id", params.brokerageId).eq("status", "pending").limit(500)
  const pending = (pendingRows ?? []) as any[]
  out.pending = pending.length
  if (pending.length === 0) return out

  // Score any that haven't been scored yet, and detect duplicates against active vendors.
  const { data: activeRows } = await svc.from("vendors").select("name, category").eq("brokerage_id", params.brokerageId).eq("status", "active").limit(2000)
  const activeKeys = new Set(((activeRows ?? []) as any[]).map((v) => `${(v.name ?? "").trim().toLowerCase()}|${(v.category ?? "").trim().toLowerCase()}`))
  const scored: Array<{ id: string; name: string; score: number; rec: string }> = []
  for (const v of pending) {
    const isDuplicate = activeKeys.has(`${(v.name ?? "").trim().toLowerCase()}|${(v.category ?? "").trim().toLowerCase()}`)
    const result = scoreVendorApplication({ name: v.name, email: v.email, phone: v.phone, website: v.website, category: v.category, estimatedTurnaroundDays: v.estimated_turnaround_days, isDuplicate })
    if (v.ai_verification_score == null) {
      await svc.from("vendors").update({ ai_verification_score: result.score, verification_flags: result.flags }).eq("id", v.id)
    }
    scored.push({ id: v.id, name: v.name ?? "A vendor", score: v.ai_verification_score ?? result.score, rec: result.recommendation })
  }

  const { isoWeekKey } = await import("@/lib/recruiting/switch-propensity-scout")
  const dedupeTag = `VENDOR APPROVALS — ${isoWeekKey(now)}`
  const { data: prior } = await svc.from("agent_client_messages").select("id")
    .eq("brokerage_id", params.brokerageId).eq("entity_type", "brokerage").eq("entity_id", params.brokerageId)
    .eq("agent_kind", "compliance_officer").ilike("rationale", `${dedupeTag}%`).limit(1).maybeSingle()
  if (prior) return out

  scored.sort((a, b) => b.score - a.score)
  const lines = [
    `${pending.length} vendor${pending.length === 1 ? "" : "s"} awaiting your approval before they can be recommended to agents or clients:`,
    ...scored.slice(0, 10).map((s) => `• ${s.name} — verification ${s.score}/100 (${s.rec === "auto_ok" ? "clean, safe to fast-track" : s.rec === "reject_recommended" ? "thin/duplicate — look closely" : "review"}).`),
    `No vendor is active until you approve it — nothing self-activates.`,
  ]
  try {
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId: params.brokerageId, agentKind: "compliance_officer", entityType: "brokerage", entityId: params.brokerageId,
      recipientContactId: null, audience: "agent",
      subject: `${pending.length} vendor${pending.length === 1 ? "" : "s"} awaiting approval`,
      body: lines.join("\n\n"),
      rationale: `${dedupeTag} — ${pending.length} pending; review before it reaches the broker.`,
      channel: "portal",
    }, svc)
    out.briefProposed = res.ok
  } catch { /* best-effort */ }
  return out
}

/** Autonomous: run the approval queue for every brokerage (rides the daily vendor-orchestration cron). */
export async function runVendorApprovalQueueAll(svc: Svc, now?: Date): Promise<{ brokerages: number; pending: number; briefs: number }> {
  const out = { brokerages: 0, pending: 0, briefs: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await runVendorApprovalQueue(svc, { brokerageId: b.id, now }); out.pending += r.pending; if (r.briefProposed) out.briefs++ } catch { /* keep going */ }
  }
  return out
}
