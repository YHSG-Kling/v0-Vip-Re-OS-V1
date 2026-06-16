// lib/compliance/phone-scrub.ts
//
// PHONE SCRUB + CLEAN-PRIMARY ELECTION — the pure engine (no I/O).
//
// THE GAP: enrichment (PeopleData) routinely returns MULTIPLE phones and stores phones[0] as the
// primary `phone` and phones[1] as `phone_secondary` — but in ARBITRARY order, never scrubbed.
// contacts.dnc_status / phone_status are never populated at ingest; they only get set later by
// manual suppression. So a brand-new contact can have a DNC'd or TCPA-litigator number sitting in
// the PRIMARY slot, and the outbound gates only catch it after the fact. The multi-line resolver
// (pickReachablePhone, m202) already falls back to a clean secondary AT SEND TIME — but the FIRST
// number a human sees and the system reaches for should already be the clean one.
//
// This engine takes the candidate numbers with their BatchData dispositions (DNC, TCPA-litigator,
// reachability) and ELECTS an ordering: the clean, contactable line becomes the PRIMARY, the rest
// cascade by quality, and each line's persisted gate columns (dnc_status / phone_status /
// phone_verified) are derived so the EXISTING gates enforce them. A TCPA-litigator number is
// suppressed exactly like a DNC number (dnc_status=true) — you never want to dial someone who
// sues over TCPA; the human-readable reason is kept in phone_status.
//
// HONEST: a number we couldn't scrub (provider deferred / unknown) is ranked below known-clean but
// ABOVE known-bad, and is never asserted verified — we don't fabricate a disposition.

export type PhoneDisposition = "clean" | "unknown" | "unreachable" | "dnc" | "tcpa_litigator"

/** A candidate number with its scrub results. null = "not known" (unscrubbed / provider deferred). */
export interface ScrubCandidate {
  number: string
  dnc?: boolean | null
  tcpaLitigator?: boolean | null
  reachable?: boolean | null
}

/** One elected line with the column values to persist (drives the existing outbound gates). */
export interface ElectedLine {
  number: string
  disposition: PhoneDisposition
  /** dnc || tcpaLitigator — the actual "do not contact this number" lever the gates read. */
  suppressed: boolean
  // persisted column values
  dnc_status: boolean
  phone_status: PhoneDisposition
  phone_verified: boolean
}

export interface PhoneElection {
  primary: ElectedLine | null
  secondary: ElectedLine | null
  /** extra clean/known lines beyond the two persisted slots (audit only) */
  dropped: ElectedLine[]
  /** true when election changed the caller's input order (a cleaner line was promoted) */
  reordered: boolean
}

function normalize(num: string): string {
  return (num ?? "").replace(/[^\d]/g, "")
}

/** Reduce any number to the unformatted 10-digit form BatchData expects (drops a leading US 1). */
export function toTenDigits(num: string | null | undefined): string | null {
  const d = normalize(num ?? "")
  if (d.length === 11 && d.startsWith("1")) return d.slice(1)
  return d.length === 10 ? d : null
}

/** Classify one candidate's disposition. Suppression (dnc/litigator) dominates; then line status. */
export function dispositionOf(c: ScrubCandidate): PhoneDisposition {
  if (c.dnc === true) return "dnc"
  if (c.tcpaLitigator === true) return "tcpa_litigator"
  if (c.reachable === true) return "clean"
  if (c.reachable === false) return "unreachable"
  return "unknown" // not scrubbed / reachability unknown but not known-bad
}

// Best (0) → worst (3). Clean first, then unknown, then unreachable, then suppressed.
const RANK: Record<PhoneDisposition, number> = { clean: 0, unknown: 1, unreachable: 2, dnc: 3, tcpa_litigator: 3 }

function toLine(c: ScrubCandidate): ElectedLine {
  const disposition = dispositionOf(c)
  const suppressed = disposition === "dnc" || disposition === "tcpa_litigator"
  return {
    number: c.number,
    disposition,
    suppressed,
    dnc_status: suppressed,              // litigator suppressed via the existing DNC lever
    phone_status: disposition,           // human-readable reason (valid statuses recognized by the resolver)
    phone_verified: c.reachable === true,
  }
}

/**
 * Elect a clean-first ordering across candidate numbers. Pure + stable: equal-quality lines keep
 * their input order, so a clean line is only promoted ahead of another clean line if it was already
 * first. De-dupes by normalized digits (PeopleData often repeats a number across slots).
 */
export function electScrubbedPhones(candidates: ScrubCandidate[]): PhoneElection {
  const seen = new Set<string>()
  const deduped: ScrubCandidate[] = []
  for (const c of candidates ?? []) {
    const key = normalize(c.number)
    if (!key || seen.has(key)) continue
    seen.add(key)
    deduped.push(c)
  }

  const indexed = deduped.map((c, i) => ({ line: toLine(c), i }))
  const ordered = [...indexed].sort((a, b) => {
    const r = RANK[a.line.disposition] - RANK[b.line.disposition]
    return r !== 0 ? r : a.i - b.i // stable within a rank
  })

  const lines = ordered.map((o) => o.line)
  const primary = lines[0] ?? null
  const secondary = lines[1] ?? null
  const dropped = lines.slice(2)
  // reordered = the best line wasn't already the caller's first input
  const reordered = ordered.length > 0 && ordered[0].i !== 0

  return { primary, secondary, dropped, reordered }
}

/** Build the contacts/leads column patch from an election. Only writes the slots we have. */
export function electionToColumnPatch(e: PhoneElection): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (e.primary) {
    patch.phone = e.primary.number
    patch.dnc_status = e.primary.dnc_status
    patch.phone_status = e.primary.phone_status
    patch.phone_verified = e.primary.phone_verified
  }
  if (e.secondary) {
    patch.phone_secondary = e.secondary.number
    patch.phone_secondary_dnc_status = e.secondary.dnc_status
    patch.phone_secondary_status = e.secondary.phone_status
    patch.phone_secondary_verified = e.secondary.phone_verified
  } else {
    // No second line survived — clear a stale secondary so a bad number can't linger as fallback.
    patch.phone_secondary = null
  }
  return patch
}
