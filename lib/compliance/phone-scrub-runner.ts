// lib/compliance/phone-scrub-runner.ts
//
// Live side of PHONE SCRUB — calls BatchData (DNC + TCPA-litigator) for each candidate number and
// elects the clean line as primary. PROVIDER-GATED: when the BatchData MCP connector is
// unconfigured (BATCHDATA_MCP_URL unset) or out of balance, it DEFERS honestly — the caller keeps
// the un-scrubbed ordering rather than asserting a fabricated disposition. Never throws.
//
// Scope: scrubs the two suppression signals the business cares about at ingest — DNC registry and
// TCPA-litigator status. Reachability is left unknown here (a separate verify pass owns line
// status); an unscrubbed/unknown number still ranks ABOVE a known-bad one in the election.

import "server-only"
import { callBatchDataMcp } from "@/lib/external/batchdata-mcp"
import {
  electScrubbedPhones, electionToColumnPatch, toTenDigits, dispositionOf,
  type ScrubCandidate, type PhoneElection, type PhoneDisposition,
} from "./phone-scrub"

export { toTenDigits }

export interface PhoneScrubResult {
  /** provider unavailable → caller keeps existing ordering (no columns written) */
  deferred: boolean
  election: PhoneElection | null
  /** how many numbers were actually checked against BatchData */
  scrubbed: number
  /** Per-number verdict in the caller's input order — WHY each line ranked where it did
   *  (clean / unknown / unreachable / dnc / tcpa_litigator). The election above says what
   *  was promoted; this says what was found. Empty when nothing was scrubbed. */
  dispositions: Array<{ number: string; disposition: PhoneDisposition }>
}

/** Tolerant boolean read across the field names BatchData variants use. null when unparseable. */
function readFlag(data: unknown, keys: string[]): boolean | null {
  if (!data || typeof data !== "object") return null
  const obj = data as Record<string, unknown>
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === "boolean") return v
    if (typeof v === "string") {
      const s = v.trim().toLowerCase()
      if (["true", "yes", "listed", "dnc", "litigator"].includes(s)) return true
      if (["false", "no", "clean", "none", "not_listed"].includes(s)) return false
    }
  }
  return null
}

/**
 * Scrub candidate numbers against BatchData and elect a clean-first ordering. Returns deferred:true
 * (no columns written) the moment the provider is unconfigured. Best-effort per number — a failed
 * single check leaves that number's signals unknown, never throwing.
 */
export async function scrubAndElectPhones(numbers: Array<string | null | undefined>): Promise<PhoneScrubResult> {
  const tens = numbers.map((n) => ({ raw: n, ten: toTenDigits(n) })).filter((x) => !!x.raw && !!x.ten) as Array<{ raw: string; ten: string }>
  if (tens.length === 0) return { deferred: false, election: null, scrubbed: 0, dispositions: [] }

  const candidates: ScrubCandidate[] = []
  let scrubbed = 0
  for (const { raw, ten } of tens) {
    const dncRes = await callBatchDataMcp<unknown>("check_dnc_status", { phone_number: ten })
    if (dncRes.unconfigured) return { deferred: true, election: null, scrubbed, dispositions: [] } // provider off — bail before more calls
    const tcpaRes = await callBatchDataMcp<unknown>("check_tcpa_status", { phone_number: ten })

    const dnc = dncRes.ok ? readFlag(dncRes.data, ["dnc", "is_dnc", "isDnc", "dnc_status", "onDnc", "listed", "result"]) : null
    const tcpaLitigator = tcpaRes.ok ? readFlag(tcpaRes.data, ["tcpa", "litigator", "is_litigator", "isLitigator", "tcpaLitigator", "tcpa_litigator", "listed", "result"]) : null
    if (dncRes.ok || tcpaRes.ok) scrubbed++

    candidates.push({ number: raw, dnc, tcpaLitigator, reachable: null })
  }

  // The same pure classifier the election ranks by — reported per number so a
  // caller (or a log line) can say WHY a line was demoted, not just that it was.
  const dispositions = candidates.map((c) => ({ number: c.number, disposition: dispositionOf(c) }))
  return { deferred: false, election: electScrubbedPhones(candidates), scrubbed, dispositions }
}

/** Convenience: the column patch to merge into a contacts/leads update, or {} when deferred/empty. */
export async function scrubPhonesForPatch(numbers: Array<string | null | undefined>): Promise<{
  patch: Record<string, unknown>
  deferred: boolean
  reordered: boolean
  dispositions: PhoneScrubResult["dispositions"]
}> {
  const r = await scrubAndElectPhones(numbers)
  if (r.deferred || !r.election) return { patch: {}, deferred: r.deferred, reordered: false, dispositions: r.dispositions }
  return { patch: electionToColumnPatch(r.election), deferred: false, reordered: r.election.reordered, dispositions: r.dispositions }
}
