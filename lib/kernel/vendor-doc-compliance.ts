// lib/kernel/vendor-doc-compliance.ts
//
// VENDOR DOCUMENT-EXPIRY COMPLIANCE (compliance_officer) — the other half of the VendorComplianceManager.
// A vendor's license / certificate-of-insurance goes stale; if the marketplace keeps recommending an
// uninsured vendor, the brokerage carries the liability. This monitors each vendor's compliance
// credentials (stored as a jsonb bag on the vendor — NO parallel table) and acts on the spec's rules:
//   · 60 / 30 / 7 days out → a gated renewal reminder to the vendor's brokerage.
//   · INSURANCE expired → HARD SUSPEND (vendor → inactive, off the bench immediately) — the liability rule.
//   · LICENSE expired → SOFT FLAG with a 14-day grace; only past grace does it suspend.
// Pure evaluator (testable); the runner applies the effects + proposes the gated reminders.

import type { createServiceClient } from "@/lib/supabase/service"
type Svc = ReturnType<typeof createServiceClient>

// The insurance vocabulary + its PURE calculator live in a client-safe module
// (no server-only in its graph) because both vendor surfaces render the
// posture. Re-exported here so server callers keep importing it from the
// kernel and there is still exactly ONE definition of each.
export {
  REMINDER_WINDOWS,
  daysUntil,
  INSURANCE_EXPIRING_DAYS,
  readVendorInsurance,
  type InsurancePosture,
  type InsuranceRecord,
  type InsuranceStatus,
} from "@/lib/vendors/insurance-posture"
import { REMINDER_WINDOWS, daysUntil } from "@/lib/vendors/insurance-posture"

export const LICENSE_GRACE_DAYS = 14

export type CredentialType = "license" | "insurance" | "certification" | "bond"
export type ExpiryWindow = "ok" | "60" | "30" | "7" | "expired"
export type ComplianceAction = "none" | "remind" | "soft_flag" | "suspend"

export interface CredentialInput { type: CredentialType | string; expiry: string | null | undefined; url?: string | null }

export interface CredentialEvaluation {
  type: string
  expiry: string | null
  daysOut: number | null
  window: ExpiryWindow
  action: ComplianceAction
  reason: string
}

const HARD_SUSPEND_TYPES = new Set(["insurance"])

/**
 * PURE: evaluate a single credential. A missing expiry is 'ok'/'none' (honest — nothing to act on, never a
 * fabricated lapse). Insurance is the hard-liability credential: the moment it expires the vendor is
 * suspended. A license gets a 14-day grace as a soft flag before it suspends.
 */
export function evaluateCredential(cred: CredentialInput, now: Date): CredentialEvaluation {
  const type = String(cred.type)
  const daysOut = daysUntil(cred.expiry, now)
  if (daysOut == null) {
    return { type, expiry: cred.expiry ?? null, daysOut: null, window: "ok", action: "none", reason: "no expiry on file" }
  }
  if (daysOut < 0) {
    const past = Math.abs(daysOut)
    if (HARD_SUSPEND_TYPES.has(type)) {
      return { type, expiry: cred.expiry!, daysOut, window: "expired", action: "suspend", reason: `${type} expired ${past}d ago — coverage lapsed, vendor suspended` }
    }
    // license / other: soft flag within grace, suspend past grace.
    if (past <= LICENSE_GRACE_DAYS) {
      return { type, expiry: cred.expiry!, daysOut, window: "expired", action: "soft_flag", reason: `${type} expired ${past}d ago — within ${LICENSE_GRACE_DAYS}d grace` }
    }
    return { type, expiry: cred.expiry!, daysOut, window: "expired", action: "suspend", reason: `${type} expired ${past}d ago — past ${LICENSE_GRACE_DAYS}d grace` }
  }
  // Upcoming reminder windows (smallest window that applies).
  for (const w of [...REMINDER_WINDOWS].sort((a, b) => a - b)) {
    if (daysOut <= w) return { type, expiry: cred.expiry!, daysOut, window: String(w) as ExpiryWindow, action: "remind", reason: `${type} expires in ${daysOut}d` }
  }
  return { type, expiry: cred.expiry!, daysOut, window: "ok", action: "none", reason: `${type} valid (${daysOut}d out)` }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CERTIFICATE OF INSURANCE, AS A READABLE POSTURE (m376)
//
// evaluateCredential above answers "what should the AUTOMATION do tonight". It
// deliberately says nothing a human can scan, and it collapses the two states a
// broker most needs told apart: a vendor with NO certificate on file and a
// vendor whose certificate is current both come back action:'none'. On a
// referral screen those are opposite facts — one is "safe to send to a client",
// the other is "we have never checked".
//
// So the posture below is derived from the SAME stored expiry, never asserted,
// and it keeps every honest gap visible as its own state instead of rounding it
// to a verdict. Nothing here decides anything; the suspend/flag decisions stay
// with evaluateCredential.

export interface VendorComplianceEvaluation {
  credentials: CredentialEvaluation[]
  shouldSuspend: boolean
  shouldSoftFlag: boolean
  reminders: CredentialEvaluation[]
}

/** PURE: evaluate a vendor's whole credential bag → the overall disposition. */
export function evaluateVendorCompliance(credentials: Record<string, { expiry?: string | null; url?: string | null }> | null | undefined, now: Date): VendorComplianceEvaluation {
  const out: VendorComplianceEvaluation = { credentials: [], shouldSuspend: false, shouldSoftFlag: false, reminders: [] }
  if (!credentials || typeof credentials !== "object") return out
  for (const [type, v] of Object.entries(credentials)) {
    const ev = evaluateCredential({ type, expiry: v?.expiry ?? null, url: v?.url ?? null }, now)
    out.credentials.push(ev)
    if (ev.action === "suspend") out.shouldSuspend = true
    if (ev.action === "soft_flag") out.shouldSoftFlag = true
    if (ev.action === "remind") out.reminders.push(ev)
  }
  return out
}

export interface DocComplianceResult { scanned: number; suspended: number; flagged: number; remindersProposed: number }

/**
 * Scan a brokerage's vendors for credential expiry, apply the effects (insurance-lapse suspend / license
 * soft-flag), and propose gated renewal reminders. Idempotent: suspension only fires on a still-active
 * vendor; reminders dedupe per (vendor, credential, window, ISO week). Best-effort.
 */
export async function runVendorDocCompliance(svc: Svc, params: { brokerageId: string; now?: Date }): Promise<DocComplianceResult> {
  const out: DocComplianceResult = { scanned: 0, suspended: 0, flagged: 0, remindersProposed: 0 }
  const now = params.now ?? new Date()

  const { data: vendors } = await svc.from("vendors")
    .select("id, name, status, verification_flags, compliance_credentials")
    .eq("brokerage_id", params.brokerageId).not("compliance_credentials", "is", null).limit(2000)
  const rows = (vendors ?? []) as any[]

  const { isoWeekKey } = await import("@/lib/recruiting/switch-propensity-scout")
  const week = isoWeekKey(now)

  for (const v of rows) {
    out.scanned += 1
    const evalResult = evaluateVendorCompliance(v.compliance_credentials, now)

    // HARD/soft effects first.
    if (evalResult.shouldSuspend && v.status === "active") {
      const flags = Array.isArray(v.verification_flags) ? v.verification_flags : []
      const reason = evalResult.credentials.find((c) => c.action === "suspend")?.reason ?? "credential expired"
      // THE SUSPENSION. status='inactive' is what stops a vendor with an expired
      // insurance certificate being booked or shown to a client. `out.suspended`
      // was incremented unconditionally, so a refused write reported a
      // suspension that never happened — the run's own summary said the vendor
      // was pulled while they stayed bookable.
      const { error: suspendError } = await svc.from("vendors").update({ status: "inactive", verification_flags: [...flags, `suspended:${reason}`], updated_at: new Date().toISOString() }).eq("id", v.id)
      if (suspendError) {
        console.error(
          `[vendor-doc-compliance] vendors suspension REFUSED for vendor ${v.id} (${reason}) — the vendor is STILL ACTIVE and bookable:`,
          suspendError.message,
        )
      } else {
        out.suspended += 1
      }
    } else if (evalResult.shouldSoftFlag) {
      const flags: string[] = Array.isArray(v.verification_flags) ? v.verification_flags : []
      const flagText = `license_grace:${week}`
      if (!flags.includes(flagText)) {
        // The grace flag is the compliance record that this vendor's licence is
        // lapsing. `out.flagged` was incremented regardless of the outcome.
        const { error: flagError } = await svc.from("vendors").update({ verification_flags: [...flags, flagText], updated_at: new Date().toISOString() }).eq("id", v.id)
        if (flagError) {
          console.error(
            `[vendor-doc-compliance] vendors grace-flag write REFUSED for vendor ${v.id} — ${flagText} is UNRECORDED:`,
            flagError.message,
          )
        } else {
          out.flagged += 1
        }
      }
    }

    // Reminders for upcoming windows (gated, deduped per vendor+credential+window+week).
    for (const rem of evalResult.reminders) {
      const dedupeTag = `VENDOR DOC EXPIRY — ${v.id} ${rem.type} ${rem.window} ${week}`
      const { data: prior } = await svc.from("agent_client_messages").select("id")
        .eq("brokerage_id", params.brokerageId).eq("entity_type", "vendor").eq("entity_id", v.id)
        .eq("agent_kind", "compliance_officer").ilike("rationale", `${dedupeTag}%`).limit(1).maybeSingle()
      if (prior) continue
      try {
        const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
        const res = await proposeClientMessage({
          brokerageId: params.brokerageId, agentKind: "compliance_officer", entityType: "vendor", entityId: v.id,
          recipientContactId: null, audience: "agent",
          subject: `${v.name ?? "A vendor"}: ${rem.type} expires in ${rem.daysOut}d`,
          body: `${v.name ?? "A vendor"}'s ${rem.type} ${rem.reason}. Ask them to renew and re-upload before it lapses — an expired insurance certificate suspends them from the marketplace automatically.`,
          rationale: `${dedupeTag} — gated renewal reminder.`,
          channel: "portal",
        }, svc)
        if (res.ok) out.remindersProposed += 1
      } catch { /* best-effort */ }
    }
  }
  return out
}

/** Autonomous: run document-expiry compliance for every brokerage (rides the daily vendor cron). */
export async function runVendorDocComplianceAll(svc: Svc, now?: Date): Promise<{ brokerages: number; suspended: number; reminders: number }> {
  const out = { brokerages: 0, suspended: 0, reminders: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await runVendorDocCompliance(svc, { brokerageId: b.id, now }); out.suspended += r.suspended; out.reminders += r.remindersProposed } catch { /* keep going */ }
  }
  return out
}
