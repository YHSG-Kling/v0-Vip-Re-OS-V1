/**
 * lib/fatigue/after-hours.ts — THE after-hours-volume fatigue signal, AGENT scope of the ONE fatigue
 * calculator (lib/fatigue — one core, two scopes: the contact scope in fatigue-calculator.ts, the
 * agent's book + this agent-side signal). Wave 104, lane 104E; closes the wave-103B open item "no
 * after-hours-volume burnout signal (ninth radar sub-score)".
 *
 * WHAT IT MEASURES: the share of an agent's OUTBOUND client messages (messages.direction 'outbound' +
 * client_portal_messages.direction 'agent_to_client' — the two rows the retention radar already reads
 * for responsiveness, so no new read) sent in the agent's local after-hours window. An agent who
 * answers clients at 11pm every night is the burnout pattern the owner wants caught "before they
 * decide to leave" — the support play is a boundary conversation + cover, never a productivity demand.
 *
 * PURE and TIME-ZONE HONEST: no agent/user/brokerage row carries a time zone (schema snapshot,
 * 2026-10-05), so the zone is resolved from agents.license_state, else brokerages.state, through the
 * US state → IANA map below; with NO resolvable zone the signal is ABSENT (null) — never a UTC guess
 * dressed up as a fact (the retention scorer drops an absent sub-score and renormalises).
 *
 * READ BY: lib/recruiting/retention-radar.ts gatherFatigueSignals → lib/recruiting/retention-score.ts
 * agentFatigueSubScores key "after_hours_volume" → agent_retention_scores.signal_breakdown (m674) →
 * weakFatigueSignals → the support nudge + the save-play library (retention-intervention.ts
 * boundary_support). Proof: scripts/agent-fatigue-guard.ts.
 */

/** Local hour at/after which a send is "after hours" (8pm) … */
export const AFTER_HOURS_START_HOUR = 20
/** … and before which it still is (7am). */
export const AFTER_HOURS_END_HOUR = 7
/** Fewer outbound messages than this in the window → no signal (a share of 3 messages is noise). */
export const AFTER_HOURS_MIN_OUTBOUND = 10
/** At this after-hours share (or more) the sub-score bottoms out at 0. */
export const AFTER_HOURS_FULL_SHARE = 0.5

/** US state / territory → IANA zone (the zone most of the state keeps; split states take their majority). */
export const US_STATE_TIME_ZONE: Readonly<Record<string, string>> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago", CA: "America/Los_Angeles",
  CO: "America/Denver", CT: "America/New_York", DE: "America/New_York", DC: "America/New_York", FL: "America/New_York",
  GA: "America/New_York", HI: "Pacific/Honolulu", ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago", KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago", MS: "America/Chicago",
  MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago", NV: "America/Los_Angeles", NH: "America/New_York",
  NJ: "America/New_York", NM: "America/Denver", NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago",
  OH: "America/New_York", OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago", UT: "America/Denver",
  VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles", WV: "America/New_York", WI: "America/Chicago",
  WY: "America/Denver", PR: "America/Puerto_Rico",
}

/** PURE: the IANA zone for a two-letter state, or null when unknown / absent. */
export function timeZoneForState(state: string | null | undefined): string | null {
  const key = (state ?? "").trim().toUpperCase()
  return key ? US_STATE_TIME_ZONE[key] ?? null : null
}

/** PURE: the local wall-clock hour (0-23) of an ISO instant in `tz`; null when either is unusable. */
export function localHour(iso: string, tz: string): number | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  try {
    const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(d)
    const n = Number(h)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/** PURE: is this local hour inside the after-hours window (≥ start OR < end)? */
export function isAfterHours(hour: number): boolean {
  return hour >= AFTER_HOURS_START_HOUR || hour < AFTER_HOURS_END_HOUR
}

export interface AfterHoursVolume {
  /** Outbound sends counted (rows whose instant parsed). */
  outbound: number
  afterHours: number
  /** afterHours / outbound, or null when below AFTER_HOURS_MIN_OUTBOUND or no zone. */
  share: number | null
}

/**
 * PURE — the agent-scope rule: the after-hours share of the agent's outbound sends.
 * @proofSeam scripts/agent-fatigue-guard.ts executes this directly (no zone → null; below the floor → null;
 * a late-night sender → share; positive control: a daytime sender → 0).
 */
export function afterHoursVolume(outboundAt: ReadonlyArray<string>, tz: string | null): AfterHoursVolume {
  if (!tz) return { outbound: 0, afterHours: 0, share: null }
  let outbound = 0
  let afterHours = 0
  for (const iso of outboundAt) {
    const h = localHour(iso, tz)
    if (h === null) continue
    outbound++
    if (isAfterHours(h)) afterHours++
  }
  return { outbound, afterHours, share: outbound >= AFTER_HOURS_MIN_OUTBOUND ? afterHours / outbound : null }
}

/** PURE: the retention sub-score (1 = no after-hours pattern … 0 = half or more of sends after hours). */
export function afterHoursSubScore(afterHours: number | null | undefined, outbound: number | null | undefined): number | null {
  if (afterHours == null || outbound == null || !Number.isFinite(afterHours) || !Number.isFinite(outbound)) return null
  if (outbound < AFTER_HOURS_MIN_OUTBOUND) return null
  const share = afterHours / outbound
  return Math.min(1, Math.max(0, 1 - share / AFTER_HOURS_FULL_SHARE))
}
