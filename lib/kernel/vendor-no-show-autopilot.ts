// lib/kernel/vendor-no-show-autopilot.ts
//
// VENDOR NO-SHOW AUTOPILOT (Deal Coordinator) — the self-healing bench. vendor_bookings has a `no_show`
// status and a full transition machine, but NOTHING ever set it autonomously: a vendor that ghosted a
// booking sat 'confirmed' forever, silently dragging the deal and never denting the vendor's SLA. This
// sweeps for probable no-shows (a booked/confirmed appointment past its scheduled_date + grace, never
// completed), MARKS them no_show (the missing writer — which also feeds the SLA math), and PROPOSES a
// gated backup: the best OTHER vendor of the same category (preference-first, via the vendor_directory
// source of truth), so the agent can re-book with one tap. Nothing auto-books. No competitor's
// marketplace heals a no-show.

import { createServiceClient } from "@/lib/supabase/service"
import { rankVendors, resolvePreferredVendorIds, type BenchVendor, type DirectoryPref } from "@/lib/kernel/vendor-orchestration"

type Svc = ReturnType<typeof createServiceClient>

/** How long past the scheduled date before a still-open booking is treated as a no-show. */
export const NO_SHOW_GRACE_HOURS = 24

export interface NoShowBooking {
  id: string
  status: string
  scheduled_date: string | null
  completed_at: string | null
  vendor_id: string | null
  service_type: string | null
  contact_id: string | null
  transaction_id: string | null
}

/**
 * PURE: is this booking a probable no-show? An appointment that was booked/confirmed, is past its
 * scheduled_date by more than the grace window, and was never completed. cancelled / already-no_show /
 * completed bookings and undated bookings are never no-shows (honest — no false positives).
 */
export function isNoShow(b: NoShowBooking, now: Date, graceHours: number = NO_SHOW_GRACE_HOURS): boolean {
  if (b.status !== "booked" && b.status !== "confirmed") return false
  if (b.completed_at) return false
  if (!b.scheduled_date) return false
  const due = Date.parse(`${b.scheduled_date.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(due)) return false
  return due + graceHours * 3_600_000 < now.getTime()
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase()

/**
 * PURE: pick the best BACKUP vendor for a no-show — a DIFFERENT vendor in the same category, ranked
 * preference-first (broker's preferred wins over rating) via the shared rankVendors. Returns null when
 * the bench has no other vendor of that category (honest — the agent is told there's no backup).
 */
export function pickBackupVendor(
  bench: BenchVendor[],
  failedVendorId: string | null,
  category: string | null,
  preferredVendorIds: Set<string>,
): BenchVendor | null {
  const pool = bench.filter((v) => v.id !== failedVendorId && (!category || norm(v.category) === norm(category)))
  if (pool.length === 0) return null
  return rankVendors(pool, { preferredVendorIds })[0] ?? null
}

export interface NoShowAutopilotResult { scanned: number; markedNoShow: number; backupsProposed: number }

/**
 * Sweep a brokerage's open vendor bookings, mark no-shows, and propose a gated backup for each. Idempotent
 * (marking → no_show is terminal, so a re-run skips it; the backup proposal dedupes per booking).
 * Best-effort; never throws into the caller.
 */
export async function runVendorNoShowAutopilot(
  svc: Svc,
  params: { brokerageId: string; now?: Date; graceHours?: number },
): Promise<NoShowAutopilotResult> {
  const out: NoShowAutopilotResult = { scanned: 0, markedNoShow: 0, backupsProposed: 0 }
  const now = params.now ?? new Date()

  const { data: bookings } = await svc
    .from("vendor_bookings")
    .select("id, status, scheduled_date, completed_at, vendor_id, service_type, contact_id, transaction_id, booked_by")
    .eq("brokerage_id", params.brokerageId)
    .in("status", ["booked", "confirmed"])
    .not("scheduled_date", "is", null)
    .limit(500)

  const noShows = ((bookings ?? []) as any[]).filter((b) => isNoShow(b, now, params.graceHours))
  if (noShows.length === 0) return out
  out.scanned = noShows.length

  // Bench + preference source of truth (vendor_directory), loaded once for backup ranking.
  const { data: benchRows } = await svc.from("vendors").select("id, name, category, email, rating").eq("brokerage_id", params.brokerageId).limit(500)
  const bench: BenchVendor[] = (benchRows ?? []) as BenchVendor[]
  const { data: dirRows } = await svc.from("vendor_directory").select("name, category, preferred").eq("brokerage_id", params.brokerageId).eq("preferred", true).limit(500)
  const preferredVendorIds = resolvePreferredVendorIds(bench, (dirRows ?? []) as DirectoryPref[])
  const vendorById = new Map(bench.map((v) => [v.id, v]))

  for (const b of noShows) {
    // 1) Mark the no-show (the missing autonomous writer). Uses the enforced transition machine.
    try {
      const { updateVendorBookingStatus } = await import("@/lib/kernel/vendors")
      const r = await updateVendorBookingStatus({
        bookingId: b.id, brokerageId: params.brokerageId, agentUserId: b.booked_by ?? null,
        toStatus: "no_show", notes: "Auto-marked by the no-show autopilot — past scheduled date + grace, never completed.",
      } as any)
      if ((r as any)?.success) out.markedNoShow++
    } catch { /* best-effort — still try the backup proposal */ }

    // 2) Propose a gated backup: a different same-category vendor, preference-first.
    const failed = b.vendor_id ? vendorById.get(b.vendor_id) : null
    const backup = pickBackupVendor(bench, b.vendor_id, failed?.category ?? null, preferredVendorIds)
    if (!backup) continue

    const dedupeTag = `VENDOR NO-SHOW BACKUP — booking:${b.id}`
    const { data: prior } = await svc
      .from("agent_client_messages")
      .select("id")
      .eq("brokerage_id", params.brokerageId).eq("entity_type", "vendor_booking").eq("entity_id", b.id)
      .eq("agent_kind", "deal_coordinator").ilike("rationale", `${dedupeTag}%`)
      .limit(1).maybeSingle()
    if (prior) continue

    const svcLabel = (b.service_type || failed?.category || "service").toString()
    try {
      const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
      const res = await proposeClientMessage({
        brokerageId: params.brokerageId, agentKind: "deal_coordinator", entityType: "vendor_booking", entityId: b.id,
        recipientContactId: null, audience: "agent",
        subject: `${failed?.name ?? "Your vendor"} missed the ${svcLabel} appointment — backup ready`,
        body: [
          `The ${svcLabel} booking with ${failed?.name ?? "the vendor"} passed its scheduled date without being completed, so I marked it a no-show (it now counts against their reliability).`,
          `Recommended backup: ${backup.name}${backup.rating != null ? ` (rated ${backup.rating}/5)` : ""} — same category, ready to go.`,
          `Want me to send them a quote-and-availability request to re-book?`,
        ].join("\n\n"),
        rationale: `${dedupeTag} — recommend backup ${backup.name}; review before it goes out.`,
        channel: "portal",
      }, svc)
      if (res.ok) out.backupsProposed++
    } catch { /* best-effort */ }
  }
  return out
}

/** Autonomous: sweep every brokerage (rides the daily vendor-orchestration cron). */
export async function runVendorNoShowAutopilotAll(svc: Svc, now?: Date): Promise<{ brokerages: number; markedNoShow: number; backupsProposed: number }> {
  const out = { brokerages: 0, markedNoShow: 0, backupsProposed: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try {
      const r = await runVendorNoShowAutopilot(svc, { brokerageId: b.id, now })
      out.markedNoShow += r.markedNoShow; out.backupsProposed += r.backupsProposed
    } catch { /* keep sweeping */ }
  }
  return out
}
