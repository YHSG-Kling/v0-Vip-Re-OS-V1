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

export const REMINDER_WINDOWS = [60, 30, 7] as const
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

/** PURE: days between now and an ISO date (negative when past). Null when no/invalid date. */
export function daysUntil(expiry: string | null | undefined, now: Date): number | null {
  if (!expiry) return null
  const t = Date.parse(expiry)
  if (Number.isNaN(t)) return null
  return Math.floor((t - now.getTime()) / 86_400_000)
}

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
      await svc.from("vendors").update({ status: "inactive", verification_flags: [...flags, `suspended:${reason}`], updated_at: new Date().toISOString() }).eq("id", v.id)
      out.suspended += 1
    } else if (evalResult.shouldSoftFlag) {
      const flags: string[] = Array.isArray(v.verification_flags) ? v.verification_flags : []
      const flagText = `license_grace:${week}`
      if (!flags.includes(flagText)) {
        await svc.from("vendors").update({ verification_flags: [...flags, flagText], updated_at: new Date().toISOString() }).eq("id", v.id)
        out.flagged += 1
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
