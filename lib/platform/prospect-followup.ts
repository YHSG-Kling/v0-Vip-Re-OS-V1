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
}

export async function runProspectFollowupSweep(svc: any): Promise<ProspectFollowupSummary> {
  const out: ProspectFollowupSummary = { introsSent: 0, nudgesSent: 0, suppressedSkipped: 0, sendFailures: 0 }
  const { sendEmail } = await import("@/lib/providers/messaging")
  const { loadProductBrand } = await import("@/lib/platform/product-brand")
  const brand = await loadProductBrand(svc)
  const nowIso = new Date().toISOString()

  const audit = async (action: string, prospectId: string, details: Record<string, unknown>) => {
    // Sentinel-tracked (the ratchet caught this as a raw silencer): a lost
    // audit row is a data-flow loss the repair digest should see.
    await sentinelWrite(svc, svc.from("superadmin_audit_log").insert({
      actor_user_id: null, actor_email: "system:prospect_followup", action,
      target_type: "platform_prospect", target_id: prospectId, details,
    }), { table: "superadmin_audit_log", flow: "prospect_followup_audit" })
  }

  // ── RUNG 1: INTRO for aged 'new' prospects ─────────────────────────────────
  const introCutoff = new Date(Date.now() - INTRO_MIN_AGE_MS).toISOString()
  const { data: fresh } = await svc.from("platform_prospects")
    .select("id, name, email, company, role_interest")
    .eq("status", "new")
    .not("email", "is", null)
    .lt("created_at", introCutoff)
    .eq("followup_count", 0)
    .order("created_at", { ascending: true })
    .limit(BATCH)

  for (const p of fresh ?? []) {
    if (await isEmailOnSuppressionList(p.email)) { out.suppressedSkipped++; continue }
    const draft = composeProspectOutreach({ name: p.name, roleInterest: p.role_interest, company: p.company, brandName: brand.name })
    const sent = await sendEmail({ to: p.email, subject: draft.subject, html: `<p>${draft.body.replace(/\n/g, "<br>")}</p>`, text: draft.body })
    if (!sent.success) { out.sendFailures++; continue } // stays 'new' — retried next run, never a fake stamp
    await svc.from("platform_prospects")
      .update({ status: "contacted", contacted_at: nowIso, followup_count: 1, last_followup_at: nowIso, updated_at: nowIso })
      .eq("id", p.id)
    await audit("platform_prospect.intro_sent", p.id, { subject: draft.subject, provider: sent.provider ?? null })
    out.introsSent++
  }

  // ── RUNG 2: ONE nudge after 3 quiet days ───────────────────────────────────
  const nudgeCutoff = new Date(Date.now() - NUDGE_QUIET_MS).toISOString()
  const { data: quiet } = await svc.from("platform_prospects")
    .select("id, name, email, role_interest")
    .eq("status", "contacted")
    .eq("followup_count", 1)
    .not("email", "is", null)
    .lt("last_followup_at", nudgeCutoff)
    .order("last_followup_at", { ascending: true })
    .limit(BATCH)

  for (const p of quiet ?? []) {
    if (await isEmailOnSuppressionList(p.email)) { out.suppressedSkipped++; continue }
    const draft = composeProspectNudge({ name: p.name, roleInterest: p.role_interest, brandName: brand.name })
    const sent = await sendEmail({ to: p.email, subject: draft.subject, html: `<p>${draft.body.replace(/\n/g, "<br>")}</p>`, text: draft.body })
    if (!sent.success) { out.sendFailures++; continue }
    await svc.from("platform_prospects")
      .update({ followup_count: 2, last_followup_at: nowIso, updated_at: nowIso })
      .eq("id", p.id)
    await audit("platform_prospect.nudge_sent", p.id, { subject: draft.subject, provider: sent.provider ?? null })
    out.nudgesSent++
  }

  return out
}
