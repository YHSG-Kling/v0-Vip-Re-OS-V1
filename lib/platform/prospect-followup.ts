// lib/platform/prospect-followup.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM PROSPECT FOLLOW-UP — the platform runs its OWN speed-to-lead.
//
// The growth funnel captured hand-raises (site form, phone reception, unclaimed-
// territory recruiting scrape) but nothing followed up: a 'new' prospect sat on
// the board until a marketing human noticed. The platform preaches speed-to-lead
// to its tenants — it now practices it.
//
// THE LADDER (deduped by followup_count + last_followup_at, l72-s05):
//   INTRO  — status 'new', ≥1h old (a human window to intercept), email on file
//            → the canonical composeProspectOutreach pitch → status 'contacted'
//   NUDGE  — status 'contacted', exactly one touch, ≥3 days quiet
//            → composeProspectNudge (one respectful nudge, then silence)
//   STOP   — trial / converted / lost never touched; suppressed emails skipped
//            (the platform's own suppression list is a legal boundary).
//
// HONESTY RULES: a failed send changes NOTHING (the prospect stays eligible for
// the next run — no fake 'contacted' stamps); every send is audited to
// superadmin_audit_log with actor 'system:prospect_followup'; sends are
// sentinel-friendly (counters reported, nothing silently swallowed).
//
// ── WAVE 146 (lane 146B) — OWNER RULING 7: "Yes platforms prospect funnel should be arbitrated." ──────────────
// The ladder above stays the deterministic ENVELOPE (who is eligible, when, at most one nudge, the suppression list, an
// open human handoff, a requested callback). Inside it, every released touch now goes to the arbiter
// (lib/ai-isa/followup-arbiter.ts arbitrateProspectFollowup) — platform scope, platform sales authority, platform facts
// only (no tenant data, no cross-tenant memory):
//   · a prospect who WROTE BACK after our last touch (details.last_inbound_at — lib/communications/inbound-record.ts) is
//     a person's job: platform staff are told and the ladder stands down (details.human_handoff), never an automated nudge;
//   · otherwise the model chooses SEND NOW, a bounded WAIT, or HAND TO STAFF. A wait is audited and bounded by the
//     policy's maxDeferDays (counted from this sweep's own audit rows — the ladder keeps no other state); an outage keeps
//     the ladder's send. Every decision rides the audit row (details.arbitration).

import { composeProspectOutreach, composeProspectNudge } from "@/lib/platform/growth-funnel"
import { isEmailOnSuppressionList } from "@/lib/platform/suppression-list"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"

const INTRO_MIN_AGE_MS = 60 * 60 * 1000        // 1 hour — a human can intercept first
const NUDGE_QUIET_MS = 3 * 24 * 60 * 60 * 1000 // 3 days of silence before the one nudge
const BATCH = 25                                // per-run ceiling per rung

export interface ProspectFollowupSummary {
  introsSent: number
  nudgesSent: number
  suppressedSkipped: number
  sendFailures: number
  /** Wave 146: touches the arbiter held (bounded) / handed to platform staff. */
  arbiterWaits: number
  staffHandoffs: number
}

type ProspectRow = {
  id: string; name: string | null; email: string; company?: string | null; role_interest: string | null
  source?: string | null; created_at?: string | null; last_followup_at?: string | null; followup_count?: number | null
  details?: Record<string, unknown> | null
}

export interface ProspectFollowupDeps {
  /** The arbiter seam (default: lib/ai-isa/followup-arbiter.ts arbitrateProspectFollowup). */
  arbitrate?: (a: Parameters<typeof import("@/lib/ai-isa/followup-arbiter").arbitrateProspectFollowup>[0]) => ReturnType<typeof import("@/lib/ai-isa/followup-arbiter").arbitrateProspectFollowup>
  /** Platform staff bell (default: lib/notifications/platform-staff.ts notifyPlatformStaff). */
  notifyStaff?: (n: { type: string; title: string; body: string; prospectId: string }) => Promise<number>
  now?: Date
}

const hoursBetween = (later: number, earlier: string | null | undefined): number | null =>
  earlier && !Number.isNaN(Date.parse(earlier)) ? Math.max(0, Math.round((later - Date.parse(earlier)) / 3_600_000)) : null

export async function runProspectFollowupSweep(svc: any, deps: ProspectFollowupDeps = {}): Promise<ProspectFollowupSummary> {
  const out: ProspectFollowupSummary = { introsSent: 0, nudgesSent: 0, suppressedSkipped: 0, sendFailures: 0, arbiterWaits: 0, staffHandoffs: 0 }
  const { sendEmail } = await import("@/lib/providers/messaging")
  const { loadProductBrand } = await import("@/lib/platform/product-brand")
  const brand = await loadProductBrand(svc)
  const nowMs = (deps.now ?? new Date()).getTime()
  const nowIso = new Date(nowMs).toISOString()
  const { DEFAULT_FOLLOWUP_POLICY } = await import("@/lib/ai-isa/followup-policy")
  const policy = DEFAULT_FOLLOWUP_POLICY
  const budget = { remaining: policy.arbiter.maxDecisionsPerRun }
  const arbitrate = deps.arbitrate ?? (async (a) => (await import("@/lib/ai-isa/followup-arbiter")).arbitrateProspectFollowup(a))
  const notifyStaff = deps.notifyStaff ?? (async (n) => {
    const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
    return notifyPlatformStaff(svc, { type: n.type, title: n.title, body: n.body, entityType: "platform_prospect", entityId: n.prospectId, priority: "high" })
  })

  const audit = async (action: string, prospectId: string, details: Record<string, unknown>) => {
    // Sentinel-tracked (the ratchet caught this as a raw silencer): a lost
    // audit row is a data-flow loss the repair digest should see.
    await sentinelWrite(svc, svc.from("superadmin_audit_log").insert({
      actor_user_id: null, actor_email: "system:prospect_followup", action,
      target_type: "platform_prospect", target_id: prospectId, details,
    }), { table: "superadmin_audit_log", flow: "prospect_followup_audit" })
  }

  /** Days the arbiter already held this prospect (its own wait audit rows inside maxDeferDays). Unreadable → no more waiting. */
  const daysDeferred = async (prospectId: string): Promise<number> => {
    const since = new Date(nowMs - policy.arbiter.maxDeferDays * 86_400_000).toISOString()
    const { data, error } = await svc.from("superadmin_audit_log").select("id")
      .eq("target_type", "platform_prospect").eq("target_id", prospectId).eq("action", "platform_prospect.followup_wait").gte("created_at", since)
    if (error) return policy.arbiter.maxDeferDays
    return (data ?? []).length
  }

  /** The arbiter's say over ONE released touch. true = send it now; false = held or handed to a person (audited). */
  const arbitrated = async (p: ProspectRow, rung: "intro" | "nudge"): Promise<boolean> => {
    const details = (p.details ?? {}) as Record<string, unknown>
    const lastInbound = typeof details.last_inbound_at === "string" ? details.last_inbound_at : null
    const lastTouch = p.last_followup_at ?? p.created_at ?? null
    const wrote = !!lastInbound && (!lastTouch || Date.parse(lastInbound) > Date.parse(lastTouch))
    // Two inbound writers feed "they came back": an emailed reply (details.last_inbound_at — contract C1's platform path,
    // fed by app/api/webhooks/inbound-mail) and a CALL to the platform reception line (platform_reception_calls.prospect_id —
    // written by app/api/voice/twilio/inbound + turn). An unreadable call log is said, and the email fact still decides.
    let called = false
    if (!wrote && lastTouch) {
      const { data: calls, error: callErr } = await svc.from("platform_reception_calls").select("id")
        .eq("prospect_id", p.id).gt("started_at", lastTouch).limit(1)
      if (callErr) console.warn(`[prospect-followup] reception call log unreadable for ${p.id}: ${callErr.message}`)
      else called = (calls ?? []).length > 0
    }
    const replied = wrote || called
    const verdict = await arbitrate({
      rung, policy, budget,
      facts: {
        roleInterest: p.role_interest ?? null, source: p.source ?? null,
        hoursSinceCreated: hoursBetween(nowMs, p.created_at), hoursSinceLastFollowup: hoursBetween(nowMs, p.last_followup_at),
        followupCount: Number(p.followup_count ?? 0), repliedSinceLastTouch: replied, daysDeferred: await daysDeferred(p.id),
      },
    })
    const arbitration = verdict.decision
      ? { source: verdict.decision.source, option: verdict.decision.optionId, rationale: verdict.decision.rationale, evidence: verdict.decision.evidence, confidence: verdict.decision.confidence, fallback_reason: verdict.decision.fallbackReason }
      : { source: "deterministic", reason: verdict.skippedReason }
    if (verdict.action === "send_now") return true
    if (verdict.action === "wait") {
      await audit("platform_prospect.followup_wait", p.id, { rung, wait_hours: verdict.waitHours, arbitration })
      out.arbiterWaits++
      return false
    }
    // A PERSON takes it: platform staff are told, and the ladder stands down while the handoff is open.
    const staffNotified = await notifyStaff({
      type: "platform_prospect_handoff",
      title: replied ? "A platform prospect wrote back" : "A platform prospect needs a person",
      body: `${p.name ?? p.email}${p.company ? ` (${p.company})` : ""} — ${verdict.skippedReason ?? verdict.decision?.rationale ?? "the arbiter handed this prospect to a person"}`,
      prospectId: p.id,
    })
    const { markProspectHandoff } = await import("@/lib/platform/prospect-capture")
    await markProspectHandoff(svc, { prospectId: p.id, reason: replied ? "prospect replied — a person answers" : "arbiter handed to a person", channel: "arbiter", staffNotified })
    await audit("platform_prospect.followup_handoff", p.id, { rung, staff_notified: staffNotified, replied, arbitration })
    out.staffHandoffs++
    return false
  }

  // ── RUNG 1: INTRO for aged 'new' prospects ─────────────────────────────────
  const introCutoff = new Date(nowMs - INTRO_MIN_AGE_MS).toISOString()
  // Lane 76B — the three AI-agent exits change what "cold" means: a
  // 'demo_scheduled' row (m654) never matches either rung's status filter, and
  // an OPEN human handoff (details.human_handoff, written by
  // lib/platform/prospect-capture.ts::markProspectHandoff) is excluded in the
  // QUERY so a person who asked for a person never gets the automated ladder
  // while staff are working them.
  const { data: fresh } = await svc.from("platform_prospects")
    .select("id, name, email, company, role_interest, source, created_at, last_followup_at, followup_count, details")
    .eq("status", "new")
    .not("email", "is", null)
    .is("details->human_handoff", null)
    // Lane 79B — a prospect who asked to be called back when THEY are ready
    // (details.callback, written by prospect-agent-tools.ts::schedule_prospect_
    // callback) is scheduled, never chased: the ladder stands down for them.
    .is("details->callback", null)
    .lt("created_at", introCutoff)
    .eq("followup_count", 0)
    .order("created_at", { ascending: true })
    .limit(BATCH)

  for (const p of (fresh ?? []) as ProspectRow[]) {
    if (await isEmailOnSuppressionList(p.email)) { out.suppressedSkipped++; continue }
    if (!(await arbitrated(p, "intro"))) continue
    const draft = composeProspectOutreach({ name: p.name, roleInterest: p.role_interest, company: p.company, brandName: brand.name })
    const sent = await sendEmail({ to: p.email, subject: draft.subject, html: `<p>${draft.body.replace(/\n/g, "<br>")}</p>`, text: draft.body })
    if (!sent.success) { out.sendFailures++; continue } // stays 'new' — retried next run, never a fake stamp
    const { error: contactedStampErr } = await svc.from("platform_prospects")
      .update({ status: "contacted", contacted_at: nowIso, followup_count: 1, last_followup_at: nowIso, updated_at: nowIso })
      .eq("id", p.id)
    if (contactedStampErr) console.error(`[prospect-followup] intro sent but prospect NOT marked contacted (may be re-sent): ${contactedStampErr.message}`)
    await audit("platform_prospect.intro_sent", p.id, { subject: draft.subject, provider: sent.provider ?? null })
    out.introsSent++
  }

  // ── RUNG 2: ONE nudge after 3 quiet days ───────────────────────────────────
  const nudgeCutoff = new Date(nowMs - NUDGE_QUIET_MS).toISOString()
  const { data: quiet } = await svc.from("platform_prospects")
    .select("id, name, email, company, role_interest, source, created_at, last_followup_at, followup_count, details")
    .eq("status", "contacted")
    .eq("followup_count", 1)
    .not("email", "is", null)
    .is("details->human_handoff", null)
    .is("details->callback", null)
    .lt("last_followup_at", nudgeCutoff)
    .order("last_followup_at", { ascending: true })
    .limit(BATCH)

  for (const p of (quiet ?? []) as ProspectRow[]) {
    if (await isEmailOnSuppressionList(p.email)) { out.suppressedSkipped++; continue }
    if (!(await arbitrated(p, "nudge"))) continue
    const draft = composeProspectNudge({ name: p.name, roleInterest: p.role_interest, brandName: brand.name })
    const sent = await sendEmail({ to: p.email, subject: draft.subject, html: `<p>${draft.body.replace(/\n/g, "<br>")}</p>`, text: draft.body })
    if (!sent.success) { out.sendFailures++; continue }
    const { error: nudgeStampErr } = await svc.from("platform_prospects")
      .update({ followup_count: 2, last_followup_at: nowIso, updated_at: nowIso })
      .eq("id", p.id)
    if (nudgeStampErr) console.error(`[prospect-followup] nudge sent but NOT recorded (may be re-sent): ${nudgeStampErr.message}`)
    await audit("platform_prospect.nudge_sent", p.id, { subject: draft.subject, provider: sent.provider ?? null })
    out.nudgesSent++
  }

  return out
}
