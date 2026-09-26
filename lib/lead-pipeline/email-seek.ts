/**
 * lib/lead-pipeline/email-seek.ts — THE EMAIL-SEEK HOOK of the raw pipeline's enrich leg (lane 85B, wave 85)
 *
 * Owner, 2026-09-26, verbatim: "change in what is needed to become a lead it should be email required
 * so email and/or phone." THE gate (canonical-lead-eligibility.ts::isLeadEligibleIdentity) now needs an
 * EMAIL; a phone-only raw row stays raw and keeps going dedup → enrich → dedup → gate. That loop only
 * rescues the row if the "enrich" leg actually LOOKS for an email — before this hook the raw path asked
 * PeopleData (by phone) and, for a full-name row, Perplexity, but never the cheapest phone-keyed
 * provider already wired.
 *
 * THE ORDER, cheapest marginal cost first (every provider already existed — nothing new is bought):
 *   1. PeopleData — pipeline-processor.ts::enrichWithPeopleData asks it on EVERY pass for demographics
 *      (lane 83A), so an email it returns costs nothing extra. This hook runs only when that leg left
 *      the row without a usable email.
 *   2. BatchData REVERSE skip trace by PHONE — lib/enrichment/reverse-skip-trace.ts::reverseSkipTracePerson
 *      (the ONE wrapper; $0.07 per MATCHED person, a lookup that resolves to no one is not billed —
 *      batchdata.io/reverse-skip-trace-api), behind THE ONE BatchData gate it resolves itself
 *      (resolveBatchDataAccess, purpose "skip_trace"). `peopleData: null` because step 1 already asked
 *      PDL this pass — never a second PDL charge. The wrapper books its own platform-ledger row and
 *      refuses a returned person whose last name disagrees with the record's (a shared/recycled line).
 *   3. Perplexity gap-fill — unchanged, still runs after this hook for a full-name row with no email
 *      (enrichment-merge.ts::shouldGapFill).
 * The found email is then RE-GATED: processRawRecord runs the post-enrichment dedup and the gate on it.
 *
 * NO RE-BILLING ON RETRY: the stranded sweep re-runs a row up to MAX_PROMOTION_ATTEMPTS times. The
 * outcome of a BILLED attempt is stamped on raw_scraped_leads.normalized_preview.email_seek (the raw
 * layer's jsonb — no new column) and a later pass for the SAME phone is skipped. A gate REFUSAL
 * (BatchData off / capped) or a lookup that resolved to no one is not billed, so it is not stamped and
 * is retried on the next pass.
 *
 * Scope note (lane 85C owns enrichment demographics/provider additions): this file adds no provider.
 */

import { leadEmailProblem } from "./canonical-lead-eligibility"

export interface EmailSeekInput {
  /** Tenant resolved server-side by processRawRecord (market / raw row) — never a body (§4). */
  brokerageId: string | null
  /** The raw record id — echoed as the provider's correlation ref. */
  ref: string
  firstName: string | null
  lastName: string | null
  phone: string | null
  /** The email the row carries after the PeopleData leg (may be missing or unusable). */
  email: string | null
  city?: string | null
  state?: string | null
  /** normalized_preview.email_seek from an earlier pass, if any. */
  prior?: EmailSeekStamp | null
}

export interface EmailSeekStamp {
  at: string
  phone: string
  status: "matched" | "no_match"
  provider: string | null
  cost_usd: number
  reason: string
}

export interface EmailSeekResult {
  /** "skipped" = no call was made (and why is in `reason`). */
  status: "found" | "not_found" | "skipped"
  email: string | null
  firstName: string | null
  lastName: string | null
  phones: string[]
  costUsd: number
  reason: string
  /** Set when a billable attempt resolved — processRawRecord persists it (no-rebill on retry). */
  stamp: EmailSeekStamp | null
}

type ReverseFn = typeof import("@/lib/enrichment/reverse-skip-trace").reverseSkipTracePerson

export interface EmailSeekDeps {
  reverse?: ReverseFn
  /** Defaults to !!process.env.BATCHDATA_API_KEY — the drain's own precondition. */
  batchDataConfigured?: boolean
  now?: () => Date
}

const digits = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "")

/** PURE — should this pass spend a call seeking an email? */
export function emailSeekDecision(input: Pick<EmailSeekInput, "email" | "phone" | "prior">): { seek: boolean; reason: string } {
  if (!leadEmailProblem(input.email)) return { seek: false, reason: "the row already carries a usable email" }
  if (!digits(input.phone)) return { seek: false, reason: "no phone to reverse-trace from" }
  if (input.prior && digits(input.prior.phone) === digits(input.phone)) {
    return { seek: false, reason: `this phone was already reverse-traced (${input.prior.status} on ${input.prior.at}) — not re-billed` }
  }
  return { seek: true, reason: "phone on file, no usable email — reverse skip trace by phone" }
}

/** THE hook. Never throws — every miss/refusal comes back as data. */
export async function seekEmailForRawRecord(input: EmailSeekInput, deps: EmailSeekDeps = {}): Promise<EmailSeekResult> {
  const none = (reason: string, status: EmailSeekResult["status"] = "skipped", stamp: EmailSeekStamp | null = null, costUsd = 0): EmailSeekResult =>
    ({ status, email: null, firstName: null, lastName: null, phones: [], costUsd, reason, stamp })

  const decision = emailSeekDecision(input)
  if (!decision.seek) return none(decision.reason)
  if (!input.brokerageId) return none("no tenant on the record — a tenant-less billed trace is refused (§4)")
  const configured = deps.batchDataConfigured ?? !!process.env.BATCHDATA_API_KEY
  if (!configured) return none("BatchData is not configured — no phone-keyed email source to ask")

  try {
    const reverse = deps.reverse ?? (await import("@/lib/enrichment/reverse-skip-trace")).reverseSkipTracePerson
    const rev = await reverse(
      {
        brokerageId: input.brokerageId, ref: input.ref,
        firstName: input.firstName, lastName: input.lastName,
        phone: input.phone, email: null,
        city: input.city ?? null, state: input.state ?? null,
      },
      { peopleData: null, systemSource: "lead_scraping", metadata: { path: "raw_email_seek" } },
    )
    if (rev.status === "refused") return none(`reverse skip trace refused: ${rev.reason}`)

    const at = (deps.now ?? (() => new Date()))().toISOString()
    const usable = rev.status === "matched" ? rev.emails.find((e) => !leadEmailProblem(e)) ?? null : null
    const stamp: EmailSeekStamp = {
      at, phone: input.phone ?? "", status: usable ? "matched" : "no_match",
      provider: rev.provider, cost_usd: rev.costUsd, reason: rev.reason,
    }
    // Nothing billed → nothing stamped: a gate that was closed ("not asked") or a lookup that resolved to
    // no one (BatchData does not bill it) costs nothing to retry, and the next pass may find the gate
    // open or the phone newly known. Only a BILLED attempt blocks a re-run for the same phone.
    if (rev.costUsd === 0 && !usable) {
      return none(`no usable email for this phone (free miss, retryable): ${rev.reason}`, rev.gate?.allowed ? "not_found" : "skipped")
    }
    if (!usable) return none(`no usable email for this phone: ${rev.reason}`, "not_found", stamp, rev.costUsd)
    return {
      status: "found", email: usable,
      firstName: rev.person?.firstName ?? null, lastName: rev.person?.lastName ?? null,
      phones: rev.phones, costUsd: rev.costUsd, reason: rev.reason, stamp,
    }
  } catch (e) {
    return none(`reverse skip trace failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
