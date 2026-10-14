// lib/lead-pipeline/enrichment-retry.ts
// PURE retry/terminal decision for the enrichment queue — no imports, so it's testable
// without dragging in the server-only enrichment orchestrator. (escalateConfigFaultOnce
// at the bottom is the ONE documented I/O exception — the CONFIG-fault side effect —
// mirroring how lib/kernel/self-heal-ledger.ts mixes its pure classifier with its writer.)

/** Max enrichment attempts before a queue entry is terminalized. */
export const MAX_RETRIES = 3

/**
 * enrichmentRetryOutcome — the retry/terminal decision shared by BOTH enrichment
 * failure paths (exception AND no-match). On the FINAL attempt the entry must
 * terminalize to 'failed' — NOT 'pending' — because the fetch excludes
 * retry_count >= MAX_RETRIES, so a 'pending' entry at the cap is a zombie: never
 * retried, never resolved, never surfaced. (The no-match path used to always reset to
 * 'pending', creating exactly that zombie.)
 *
 * `fault` (wave 66): a CONFIG fault (see classifyEnrichmentFault below) NEVER retries,
 * regardless of retryCount — retrying a misconfigured/unprovisioned vendor token cannot
 * ever succeed, so treating it as transient just burns MAX_RETRIES attempts (and
 * enrichment spend) before finally reporting the exact same root cause attempt 1 already
 * had. Defaults to "transient" so every existing caller is unaffected.
 */
export function enrichmentRetryOutcome(
  retryCount: number,
  maxRetries: number = MAX_RETRIES,
  fault: EnrichmentFaultKind = "transient",
): { nextRetry: number; isFinal: boolean; status: "pending" | "failed" } {
  const nextRetry = retryCount + 1
  if (fault === "config") {
    return { nextRetry, isFinal: true, status: "failed" }
  }
  const isFinal = nextRetry >= maxRetries
  return { nextRetry, isFinal, status: isFinal ? "failed" : "pending" }
}

// ─── CONFIG fault vs TRANSIENT fault (wave 66 ruling) ────────────────────────────────
//
// BatchData's own wording for an account whose API token lacks a scope/product, or one
// that was never provisioned for a capability, is a 403 carrying "token ability missing"
// or "provisioning required" — a fact about the ACCOUNT, not about this one call. Retrying
// changes nothing; only a human fixing the BatchData account/plan does. Treating it as a
// normal transient failure (rate limit, network blip, momentary 5xx) was the defect: the
// queue entry retried MAX_RETRIES times against the SAME wall, spending nothing (BatchData
// refuses before billing) but burning the retry budget and reporting a generic "failed"
// that told nobody the account itself needed attention.

export type EnrichmentFaultKind = "config" | "transient"

/** Case-insensitive substrings BatchData is known to use for an account-level refusal. */
const BATCHDATA_CONFIG_FAULT_SIGNATURES = [
  "token ability missing",
  "provisioning required",
] as const

/**
 * PURE: classifies a vendor error as a CONFIG fault (the account/subscription itself is
 * misconfigured or unprovisioned) or a TRANSIENT fault (worth retrying). `httpStatus`, when
 * known, narrows the match to BatchData's actual status (403) — omit it (undefined/null) to
 * match on message text alone, e.g. when only a logged string survives.
 */
export function classifyEnrichmentFault(
  errorMessage: string | null | undefined,
  httpStatus?: number | null,
): EnrichmentFaultKind {
  if (!errorMessage) return "transient"
  const msg = errorMessage.toLowerCase()
  const looksLikeConfigFault = BATCHDATA_CONFIG_FAULT_SIGNATURES.some((sig) => msg.includes(sig))
  if (!looksLikeConfigFault) return "transient"
  if (httpStatus !== undefined && httpStatus !== null && httpStatus !== 403) return "transient"
  return "config"
}

/** "Escalate once" window: a config fault a human has already been told about does not
 *  re-page them on every retry tick within this many hours. A NEW outage after the window
 *  closes escalates again. */
export const ESCALATE_ONCE_WINDOW_HOURS = 24

/**
 * escalateConfigFaultOnce — the CONFIG-fault side effect: ONE self_heal_events row
 * (domain 'connector', outcome 'escalated') per vendor per rolling window, so an
 * enrichment queue stuck failing every attempt against the same broken BatchData account
 * does not write one escalation per record. Best-effort (never throws) like every other
 * self_heal_events writer in this codebase.
 */
export async function escalateConfigFaultOnce(
  svc: any,
  params: { brokerageId: string | null; vendor: string; errorMessage: string },
): Promise<{ escalated: boolean; alreadyEscalated: boolean }> {
  const subject = `${params.vendor}_config_fault`
  try {
    const since = new Date(Date.now() - ESCALATE_ONCE_WINDOW_HOURS * 60 * 60 * 1000).toISOString()
    const { data: existing } = await svc
      .from("self_heal_events")
      .select("id")
      .eq("domain", "connector")
      .eq("subject", subject)
      .eq("outcome", "escalated")
      .gte("created_at", since)
      .limit(1)
    if (existing && existing.length > 0) {
      return { escalated: false, alreadyEscalated: true }
    }
    const { recordSelfHeal } = await import("@/lib/kernel/self-heal-ledger")
    await recordSelfHeal(svc, {
      brokerageId: params.brokerageId,
      domain: "connector",
      subject,
      action: "vendor_config_fault",
      outcome: "escalated",
      detail: { vendor: params.vendor, error: params.errorMessage },
    })
    return { escalated: true, alreadyEscalated: false }
  } catch {
    // Escalation is best-effort — a failure here must never break the retry/terminal
    // decision that already ran above it.
    return { escalated: false, alreadyEscalated: false }
  }
}
