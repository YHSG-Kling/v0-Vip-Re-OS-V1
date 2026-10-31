// lib/external/batchdata-tokens.ts
//
// TOKEN STRATEGY SEAM (wave 67, owner ruling — "how can we get around the caps").
// RESEARCHED FACT (help.batchdata.io / batchdata.io/pricing, 2026-09-16, recorded
// verbatim in the wave-67 lane prompt): BatchData bills PER RECORD against whatever
// datasets a given server-side token is PROVISIONED for, and an account may hold
// MULTIPLE server-side tokens, each independently provisioned. A single shared token
// used for every purpose (motivated-seller search, skip-trace, listing data, MCP)
// gets billed at the UNION of every dataset any caller ever needed — e.g. if the
// skip-trace lane's token also carries the listing/comps add-ons because the search
// lane asked for them once, every skip-trace record is now billed against a wider
// (more expensive) provisioning than skip-trace alone needs. Separate tokens per
// PURPOSE, each provisioned ONLY for what that purpose actually reads, keep the
// per-record cost down and make a runaway lane's spend attributable to the token
// that caused it (the account dashboard bills per token).
//
// This module is the ONE place that resolves "which env var backs this call" — every
// request builder in batchdata-client.ts and batchdata-mcp.ts reads its bearer token
// through `resolveBatchDataToken(purpose)`, never `process.env.BATCHDATA_API_KEY`
// directly (that direct read stays ONLY as the account-wide "is BatchData configured
// at all" gate — resolveBatchDataToken falls back to it by design, so an account that
// never provisioned the narrower tokens keeps working unchanged on one key).
//
// Fallback chain per purpose (all optional overrides fall back to BATCHDATA_API_KEY,
// so setting nothing beyond BATCHDATA_API_KEY reproduces today's single-token
// behavior exactly):
//   search     → BATCHDATA_API_KEY                                    (always)
//   skip_trace → BATCHDATA_SKIP_TRACE_TOKEN ?? BATCHDATA_API_KEY
//   listing    → BATCHDATA_LISTING_TOKEN    ?? BATCHDATA_API_KEY
//   mcp        → BATCHDATA_MCP_AUTH         ?? BATCHDATA_API_KEY
//   batchrank  → BATCHDATA_BATCHRANK_TOKEN                               (NO fallback —
//                BatchRank is a separately, custom-priced add-on; silently riding the
//                shared key would turn it on for every tenant the moment BATCHDATA_API_KEY
//                is set, which is the opposite of the wave-68 fail-closed-by-default ruling
//                in lib/external/batchdata-batchrank.ts. It must be provisioned on purpose.)

export type BatchDataTokenPurpose = "search" | "skip_trace" | "listing" | "mcp" | "batchrank"

/** PURE (reads env, no I/O) — resolves the bearer token for one BatchData call
 *  purpose per the fallback chain above. Returns null when nothing is configured
 *  for that purpose at all (including the shared fallback) — callers treat that the
 *  same way they already treat a missing BATCHDATA_API_KEY: fail closed, never a
 *  fabricated/empty-string token sent as a real Authorization header. */
export function resolveBatchDataToken(purpose: BatchDataTokenPurpose): string | null {
  switch (purpose) {
    case "search":
      return process.env.BATCHDATA_API_KEY || null
    case "skip_trace":
      return process.env.BATCHDATA_SKIP_TRACE_TOKEN || process.env.BATCHDATA_API_KEY || null
    case "listing":
      return process.env.BATCHDATA_LISTING_TOKEN || process.env.BATCHDATA_API_KEY || null
    case "mcp":
      return process.env.BATCHDATA_MCP_AUTH || process.env.BATCHDATA_API_KEY || null
    case "batchrank":
      // Deliberately NO fallback to BATCHDATA_API_KEY — see the header.
      return process.env.BATCHDATA_BATCHRANK_TOKEN || null
    default: {
      // Exhaustiveness guard — a new purpose added to the union without a case here
      // falls back to the master key rather than throwing into a caller.
      const _exhaustive: never = purpose
      void _exhaustive
      return process.env.BATCHDATA_API_KEY || null
    }
  }
}

