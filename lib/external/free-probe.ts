// lib/external/free-probe.ts
//
// HONESTY PRIMITIVE FOR THE KEYLESS ("osint_free") LANE.
//
// A keyless provider still has to be REACHABLE. Every free module in this
// directory used to collapse four different outcomes into one `null`:
//
//   • the provider answered and genuinely had nothing for this input  → no_data
//   • the provider refused / errored / timed out                      → unreachable
//   • we never asked because the input was missing                    → not_attempted
//   • the provider answered with a usable value                       → ok
//
// A caller that cannot tell those apart WILL report an empty enrichment as a
// successful one — the exact defect this wave exists to remove. FreeProbe keeps
// the four distinct all the way through to the enrichment ledger, so
// "Nominatim was down" never renders as "this address has no coordinates".
//
// PURE — no imports, no I/O. Shared by nominatim-geocode, census-appreciation,
// osint-neighborhood and the lane assembler in osint-free.ts. It lives in its
// own module (rather than inside osint-free.ts) so those primitive modules do
// not have to import the assembler that imports them.

export type FreeProbeOutcome = "ok" | "no_data" | "unreachable" | "not_attempted"

export interface FreeProbe<T> {
  /** The answer, or null for every non-`ok` outcome. */
  value: T | null
  outcome: FreeProbeOutcome
  /** HTTP status when the provider answered at all; null on network/timeout/skip. */
  status: number | null
  /** Why it is not `ok` — the transport error, or the reason we never asked. */
  error: string | null
}

/** The subset of connector-gateway's GatewayResponse a probe needs. Declared
 *  structurally so this module stays import-free and unit-testable. */
export interface GatewayLike {
  ok: boolean
  status: number | null
  error: string | null
}

/**
 * Turn a connector-gateway response into a probe. `extract` runs ONLY when the
 * transport succeeded, and returning null from it means "the provider answered,
 * it had nothing" — which is a materially different fact from `!res.ok`.
 * A throwing extractor is treated as no_data, never as a crash.
 */
export function gatewayProbe<T>(res: GatewayLike, extract: () => T | null): FreeProbe<T> {
  if (!res.ok) {
    return {
      value: null,
      outcome: "unreachable",
      status: res.status ?? null,
      error: res.error ?? (res.status == null ? "network or timeout" : `HTTP ${res.status}`),
    }
  }
  let value: T | null = null
  try {
    value = extract()
  } catch {
    value = null
  }
  return {
    value,
    outcome: value == null ? "no_data" : "ok",
    status: res.status ?? null,
    error: null,
  }
}

/** The call threw before the gateway could answer (client construction, abort). */
export function unreachableProbe<T>(error: unknown): FreeProbe<T> {
  return {
    value: null,
    outcome: "unreachable",
    status: null,
    error: error instanceof Error ? error.message : String(error),
  }
}

/** We never asked — no ZIP, no address parts. NOT a provider failure and NOT a
 *  "no data" answer; recording it as either would misattribute the gap. */
export function notAttemptedProbe<T>(reason: string): FreeProbe<T> {
  return { value: null, outcome: "not_attempted", status: null, error: reason }
}
