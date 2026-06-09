// lib/communication/phone-reachability.ts
//
// Pure phone-reachability resolver. A contact often has TWO numbers and one may be on the DNC
// list / opted out while the other is reachable. Voice reachability is a property of the NUMBER
// (DNC, call-stop, line status), so when the primary line is blocked we may still legally place a
// call to a clean secondary line. (SMS opt-out is a PERSON-level revocation — a STOP applies to
// the person, not just the number — so the SMS path intentionally does NOT fall back to a 2nd
// number; only the voice path does.)
//
// No server/gateway imports — unit-testable under plain tsx.

export interface PhoneReachabilityInput {
  // Primary line
  phone?: string | null
  dnc_status?: boolean | null
  call_stop_flag?: boolean | null
  phone_opt_out?: boolean | null
  phone_status?: string | null
  // Secondary line (m202) — independently gated
  phone_secondary?: string | null
  phone_secondary_dnc_status?: boolean | null
  phone_secondary_opt_out?: boolean | null
  phone_secondary_status?: string | null
}

export interface ReachablePhone {
  /** The number to dial, or null when neither line is voice-reachable. */
  number: string | null
  /** Which column the number came from (audit / which gate to honor downstream). */
  field: 'phone' | 'phone_secondary' | null
  /** True when a primary line existed but was blocked and we fell back to the secondary. */
  usedFallback: boolean
}

// A line is voice-reachable when it exists, is not DNC/opted-out/call-stopped, and is not a
// known-bad line status (invalid / reassigned / disconnected).
const BAD_STATUSES = new Set(['invalid', 'reassigned', 'disconnected', 'unreachable'])

function lineReachable(num: string | null | undefined, dnc: unknown, optOut: unknown, status: unknown): boolean {
  if (!num || !num.toString().trim()) return false
  if (dnc === true) return false
  if (optOut === true) return false
  const s = typeof status === 'string' ? status.trim().toLowerCase() : ''
  if (s && BAD_STATUSES.has(s)) return false
  return true
}

/**
 * Pick the best voice-reachable number for a contact, preferring the primary and falling back
 * to a clean secondary line. Returns { number: null } when neither line may be called — the
 * caller must then choose a non-voice channel (or no_outreach).
 */
export function pickReachablePhone(c: PhoneReachabilityInput | null | undefined): ReachablePhone {
  if (!c) return { number: null, field: null, usedFallback: false }

  const primaryOk = lineReachable(c.phone, c.dnc_status, c.phone_opt_out ?? c.call_stop_flag, c.phone_status)
  if (primaryOk) return { number: c.phone as string, field: 'phone', usedFallback: false }

  const secondaryOk = lineReachable(
    c.phone_secondary,
    c.phone_secondary_dnc_status,
    c.phone_secondary_opt_out,
    c.phone_secondary_status,
  )
  if (secondaryOk) {
    // usedFallback only when a primary number actually existed but was blocked.
    return { number: c.phone_secondary as string, field: 'phone_secondary', usedFallback: !!(c.phone && `${c.phone}`.trim()) }
  }

  return { number: null, field: null, usedFallback: false }
}

/** Convenience boolean: can this contact be reached by VOICE on any line? */
export function hasReachablePhone(c: PhoneReachabilityInput | null | undefined): boolean {
  return pickReachablePhone(c).number !== null
}
