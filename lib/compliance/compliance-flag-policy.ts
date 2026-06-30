// ─── COMPLIANCE-FLAG SLA POLICY (Compliance Officer reaper) ──────────────────
// Pure, import-free policy for the Compliance Officer's "a raised flag sat
// unreviewed" failure: a compliance_flags row in the 'flagged' state (detected by
// the Fair-Housing / consent / content gates but never reviewed) that has aged
// past a SEVERITY-WEIGHTED SLA. Fair-Housing and consent issues are the highest-
// stakes thing the OS can drop on the floor, so the net must guarantee a human
// looks. Pure → unit-testable (scripts/compliance-flag-reaper-simulator.ts).

// compliance_flags.status CHECK = flagged | reviewed | resolved | overridden.
// Only 'flagged' is genuinely stuck — nobody has looked yet. 'reviewed' means a
// human is on it; resolved/overridden are terminal.
const UNREVIEWED_STATUS = "flagged"

// Hours a flag may sit unreviewed before escalation, by severity. Higher stakes →
// shorter fuse. Unknown severity defaults to the 'medium' fuse (never ignored).
export const COMPLIANCE_SLA_HOURS: Record<string, number> = {
  critical: 4,
  blocker: 4,
  high: 12,
  medium: 48,
  warning: 48,
  low: 120,
}
export const DEFAULT_COMPLIANCE_SLA_HOURS = 48

export type ComplianceFlagAction = "keep" | "escalate"

export interface ComplianceFlagInput {
  status: string | null | undefined
  severity: string | null | undefined
  /** detected_at (preferred) or created_at. */
  detectedAt: string | null | undefined
  /** Caller passes "now" so the policy stays deterministic/testable. */
  now: Date
}

export function slaHoursForSeverity(severity: string | null | undefined): number {
  const s = (severity ?? "").toLowerCase().trim()
  return COMPLIANCE_SLA_HOURS[s] ?? DEFAULT_COMPLIANCE_SLA_HOURS
}

export function classifyStuckComplianceFlag(input: ComplianceFlagInput): ComplianceFlagAction {
  const status = (input.status ?? "").toLowerCase().trim()
  if (status !== UNREVIEWED_STATUS) return "keep" // reviewed / resolved / overridden → handled
  if (!input.detectedAt) return "keep"

  const detected = Date.parse(input.detectedAt)
  if (Number.isNaN(detected)) return "keep"

  const ageHours = (input.now.getTime() - detected) / (60 * 60 * 1000)
  return ageHours >= slaHoursForSeverity(input.severity) ? "escalate" : "keep"
}
