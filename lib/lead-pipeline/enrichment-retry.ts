// lib/lead-pipeline/enrichment-retry.ts
// PURE retry/terminal decision for the enrichment queue — no imports, so it's testable
// without dragging in the server-only enrichment orchestrator. (escalateConfigFaultOnce
// at the bottom is the ONE documented I/O exception — the CONFIG-fault side effect —
// mirroring how lib/kernel/self-heal-ledger.ts mixes its pure classifier with its writer.)

/** Max enrichment attempts before a queue entry is terminalized. */
export const MAX_RETRIES = 3

// ─── leads.enrichment_status — ONE vocabulary (wave 151, lane 151C; CLAUDE.md §6) ──────────────────────────────────
//
// Measured 2026-11-09 (live: text, DEFAULT 'pending', NO CHECK, 0 rows): the column was written in THREE spellings —
// 'completed' (pipeline-processor.ts ×2, lead-promoter.ts), 'complete' (enrichment-orchestrator.ts ×2) and 'enriched'
// (lead-application-service.ts) — while the two governance READERS (lib/lead-governance/promotion-readiness.ts:37,
// routing-evaluator.ts:153) test `=== 'complete'`. A lead born from the scrape pipeline therefore never read as enriched
// to the readiness gate, and lib/enrichment/lead-freshness.ts had to refuse the column as evidence. The survivor spelling
// is the readers' word. 'partial' is the honest state the pipeline lacked (directive 151C: "Delayed/partial provider
// results stay retryable and cannot report success as a complete profile") — the miss path used to stamp 'completed'
// with enrichmentConfidence 0.3 and no provider record at all.
export const LEAD_ENRICHMENT_STATUSES = ["pending", "partial", "complete"] as const
export type LeadEnrichmentStatus = (typeof LEAD_ENRICHMENT_STATUSES)[number]

/**
 * PURE — what a lead's enrichment_status may honestly say after a pass. 'complete' needs EVIDENCE (a provider-built
 * profile or a provider-delivered / vendor-sold contact point) AND no gap on the required anchor; anything less is
 * 'partial' — retryable by the queue (enrichmentRetryOutcome) and the re-queue runners, never reported as a full profile.
 */
export function leadEnrichmentStatusFor(input: {
  /** A provider actually answered (a built profile with a provider, or an enrichmentSource naming who delivered). */
  providerAnswered: boolean
  /** The gap the pass existed to close is still open (e.g. no usable email after the seek). */
  gapsRemain: boolean
}): LeadEnrichmentStatus {
  if (!input.providerAnswered) return "partial"
  return input.gapsRemain ? "partial" : "complete"
}

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

// ── PERSONA RE-DERIVATION CADENCE — WAVE 149 (lane 149J): the persona study re-derives on NEW EVIDENCE only.
//
// Wave-148 final report §2, lane C: "persona study re-runs at every enrichment (no cadence policy)". The enrichment
// orchestrator (lib/lead-pipeline/enrichment-orchestrator.ts, step 6e) called the autonomous persona study
// (lib/contacts/persona-builder.ts buildContactPersona → derivePersona, ~1,400 output tokens booked on ai_tool_usage)
// every time a contact was enriched — including a periodic re-buy that returned the SAME facts. That spends the
// platform-covered AI budget (CLAUDE.md §5 — a wrong number on ai_tool_usage is a wrong invoice) on a study whose
// inputs did not move.
//
// The policy is evidence-driven, never a timetable (owner ruling 7, wave 149 — no fixed schedules): a study runs when
// the facts it is built from CHANGED since the last study, or when no study exists. The facts' fingerprint is stored
// beside the enrichment it came from (`contacts.enrichment_profile.persona_evidence`, written by the orchestrator — the
// one enrichment_profile writer) after a study that WROTE its row. Anything else (new behavioural evidence, a stated
// need, a staff edit) reaches the persona through its own doors (app/actions/contact-persona.ts), not this one.
// Kept in this import-free policy module (not a new one) so the orchestrator's graph does not grow (test:proxy-graph-budget).

/** Stable JSON: keys sorted at every level, so the same facts always give the same fingerprint. */
function stable(v: unknown): string {
  if (v === null || v === undefined) return "null"
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`
  if (typeof v === "object") {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`
  }
  return JSON.stringify(v)
}

/** PURE — the fingerprint of the facts a persona study is built from: two independent FNV-1a 32-bit passes over the
 *  stable JSON (16 hex). Not a security hash — an equality check on the evidence, import-free like the rest of this file. */
export function personaEvidenceFingerprint(facts: Record<string, unknown>): string {
  const s = stable(facts)
  let a = 0x811c9dc5
  let b = 0x01000193 ^ s.length
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ (c + 0x9e37), 0x01000193) >>> 0
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0")
}

/** PURE — the stored fingerprint, read from a contact's enrichment_profile (null when absent or malformed). */
export function storedPersonaEvidence(enrichmentProfile: unknown): { fingerprint: string; at: string | null } | null {
  const p = (enrichmentProfile && typeof enrichmentProfile === "object" ? enrichmentProfile : null) as Record<string, unknown> | null
  const e = (p?.persona_evidence && typeof p.persona_evidence === "object" ? p.persona_evidence : null) as Record<string, unknown> | null
  if (!e || typeof e.fingerprint !== "string" || !e.fingerprint) return null
  return { fingerprint: e.fingerprint, at: typeof e.at === "string" ? e.at : null }
}

export type PersonaRederivationVerdict =
  | { run: true; reason: "no_prior_study" | "evidence_changed" | "persona_row_missing" }
  | { run: false; reason: "evidence_unchanged" }

/**
 * PURE — run the study or not. `personaRowExists` is asked only when the fingerprint matches (a deleted row with an
 * unchanged fingerprint is re-derived — the row is what the readers use). Unknown row state (`null`) re-derives:
 * a study that cannot prove it is redundant runs (the persona is additive, the spend is ledgered).
 */
export function personaRederivationVerdict(input: {
  fingerprint: string
  stored: { fingerprint: string } | null
  personaRowExists: boolean | null
}): PersonaRederivationVerdict {
  if (!input.stored) return { run: true, reason: "no_prior_study" }
  if (input.stored.fingerprint !== input.fingerprint) return { run: true, reason: "evidence_changed" }
  if (input.personaRowExists !== true) return { run: true, reason: "persona_row_missing" }
  return { run: false, reason: "evidence_unchanged" }
}
