// lib/compliance/license-readiness.ts
//
// AGENT LICENSE / CE / ETHICS READINESS — the SINGLE source of truth for "is this agent legally clear
// to transact." Real-estate license currency, continuing-education (CE) hours, and NAR ethics training
// are all regulatory prerequisites: an agent who is expired, CE-short past their cycle, or ethics-overdue
// cannot legally list, write offers, or close. The app already TRACKS all of this (agents.license_expiry
// / ce_hours_required / ce_hours_completed / ce_cycle_end_date / ethics_due_date) and DISPLAYS it — but
// it was never ENFORCED as a unit: the offer-time check only blocked an already-expired license and
// ignored CE + ethics entirely, and nothing warned the agent BEFORE a lapse. This pure evaluator is the
// canonical readiness verdict shared by the offer-time gate (proactive-checks) and the autonomous
// readiness sweep, so the control and the reminder can't drift. Missing data → no issue (never fabricated).

export interface LicenseStatus {
  licenseExpiry: string | null      // agents.license_expiry (ISO date)
  ceHoursRequired: number | null    // agents.ce_hours_required
  ceHoursCompleted: number | null   // agents.ce_hours_completed
  ceCycleEndDate: string | null     // agents.ce_cycle_end_date (ISO date)
  ethicsDueDate: string | null      // agents.ethics_due_date (ISO date)
}

export type ReadinessCode = "license_expired" | "license_expiring" | "ce_incomplete_cycle_ended" | "ce_incomplete_cycle_ending" | "ce_incomplete" | "ethics_overdue" | "ethics_due_soon"
export type ReadinessSeverity = "blocker" | "warning"

export interface ReadinessIssue {
  code: ReadinessCode
  severity: ReadinessSeverity
  title: string
  detail: string
}

export interface LicenseReadiness {
  /** No blockers — the agent is legally clear to transact. */
  ready: boolean
  blockers: ReadinessIssue[]
  warnings: ReadinessIssue[]
  daysToLicenseExpiry: number | null
}

/** How many days out a lapse becomes a proactive warning (before it's a hard blocker). */
export const READINESS_WARN_DAYS = 45

function daysUntil(iso: string | null, now: Date): number | null {
  if (!iso) return null
  const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(t)) return null
  const ref = Date.parse(now.toISOString().slice(0, 10) + "T00:00:00Z")
  return Math.round((t - ref) / 86_400_000)
}

/**
 * PURE: evaluate an agent's regulatory readiness. Blockers (legally can't transact): expired license,
 * CE hours short with the cycle already ended, ethics overdue. Warnings (act now, not yet blocking):
 * license/CE-cycle/ethics due within READINESS_WARN_DAYS, or CE short with no cycle date on file.
 * Honest: a field that isn't tracked yields no issue — never a fabricated blocker.
 */
export function evaluateLicenseReadiness(status: LicenseStatus, now: Date = new Date()): LicenseReadiness {
  const blockers: ReadinessIssue[] = []
  const warnings: ReadinessIssue[] = []

  const licDays = daysUntil(status.licenseExpiry, now)
  if (licDays !== null) {
    if (licDays < 0) {
      blockers.push({ code: "license_expired", severity: "blocker", title: "Real estate license expired", detail: `Your license expired ${Math.abs(licDays)} day${Math.abs(licDays) === 1 ? "" : "s"} ago (${status.licenseExpiry}). You cannot legally list, write offers, or close until it's renewed.` })
    } else if (licDays <= READINESS_WARN_DAYS) {
      warnings.push({ code: "license_expiring", severity: "warning", title: "License expiring soon", detail: `Your license expires in ${licDays} day${licDays === 1 ? "" : "s"} (${status.licenseExpiry}). Renew now to avoid a gap in your ability to transact.` })
    }
  }

  const required = status.ceHoursRequired ?? 0
  const completed = status.ceHoursCompleted ?? 0
  if (required > 0 && completed < required) {
    const short = required - completed
    const cycleDays = daysUntil(status.ceCycleEndDate, now)
    if (cycleDays !== null && cycleDays < 0) {
      blockers.push({ code: "ce_incomplete_cycle_ended", severity: "blocker", title: "CE hours incomplete — cycle ended", detail: `You're ${short} continuing-education hour${short === 1 ? "" : "s"} short (${completed}/${required}) and your CE cycle ended ${Math.abs(cycleDays)} day${Math.abs(cycleDays) === 1 ? "" : "s"} ago. This can suspend your license — complete CE immediately.` })
    } else if (cycleDays !== null && cycleDays <= READINESS_WARN_DAYS) {
      warnings.push({ code: "ce_incomplete_cycle_ending", severity: "warning", title: "CE hours due soon", detail: `You're ${short} CE hour${short === 1 ? "" : "s"} short (${completed}/${required}) and your cycle ends in ${cycleDays} day${cycleDays === 1 ? "" : "s"}.` })
    } else {
      warnings.push({ code: "ce_incomplete", severity: "warning", title: "CE hours incomplete", detail: `You've completed ${completed} of ${required} required continuing-education hours.` })
    }
  }

  const ethicsDays = daysUntil(status.ethicsDueDate, now)
  if (ethicsDays !== null) {
    if (ethicsDays < 0) {
      blockers.push({ code: "ethics_overdue", severity: "blocker", title: "NAR ethics training overdue", detail: `Your required ethics training was due ${Math.abs(ethicsDays)} day${Math.abs(ethicsDays) === 1 ? "" : "s"} ago (${status.ethicsDueDate}). Overdue ethics can suspend your MLS access.` })
    } else if (ethicsDays <= READINESS_WARN_DAYS) {
      warnings.push({ code: "ethics_due_soon", severity: "warning", title: "Ethics training due soon", detail: `Your ethics training is due in ${ethicsDays} day${ethicsDays === 1 ? "" : "s"} (${status.ethicsDueDate}).` })
    }
  }

  return { ready: blockers.length === 0, blockers, warnings, daysToLicenseExpiry: licDays }
}

/** A stable idempotency window key for a reminder — the issue codes present, so a NEW issue re-notifies
 *  but the same standing set doesn't spam. */
export function readinessIssueKey(r: LicenseReadiness): string {
  return [...r.blockers, ...r.warnings].map((i) => i.code).sort().join(",")
}
