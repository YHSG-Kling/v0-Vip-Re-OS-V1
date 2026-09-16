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
// SURVIVOR (wave 68): checkDncStatus / checkTcpaStatus are now typed mirrors on
// lib/external/batchdata-mcp.ts, next to verifyPhone — the SAME two tools this file
// used to call as raw callBatchDataMcp("check_dnc_status"/"check_tcpa_status") strings.
// One vocabulary (§6): the tool name and the tolerant-flag reader live in ONE place,
// shared with the SEND-TIME scrub in lib/communication/tcpa-gate.ts.
import { checkDncStatus, checkTcpaStatus } from "@/lib/external/batchdata-mcp"
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
    const dncRes = await checkDncStatus(ten)
    if (dncRes.unconfigured) return { deferred: true, election: null, scrubbed, dispositions: [] } // provider off — bail before more calls
    const tcpaRes = await checkTcpaStatus(ten)
    if (dncRes.ok || tcpaRes.ok) scrubbed++

    candidates.push({ number: raw, dnc: dncRes.dnc, tcpaLitigator: tcpaRes.tcpaLitigator, reachable: null })
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
