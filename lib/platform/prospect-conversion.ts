// lib/platform/prospect-conversion.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM PROSPECT → TENANT CONVERSION STAMP — the missing half of
// platform_prospects.converted_brokerage_id (§1.2 build, 2026-08-27).
//
// THE GAP: the acquisition rail captured prospects five ways (/get-started,
// /demo, phone reception, the Reddit OS-intent sourcer, subscriber referrals)
// and worked them (follow-up cron, growth board, proposals) — but when a
// prospect actually BECAME a tenant, nothing recorded it. Both tenant-creation
// paths (app/actions/auth/signup-brokerage.ts self-serve and
// app/actions/admin/create-subscriber.ts superadmin) provisioned the brokerage
// without ever touching platform_prospects, so converted_brokerage_id had ONE
// writer: the manual, billing-gated linkReferralConversionAction on the growth
// page. The funnel's conversion rate — the number the whole self-marketing
// rail exists to move — depended on a human remembering to click a link
// button on a referral card. The referral-fee ledger (which computes fees off
// converted_brokerage_id → MRR) had the same blind spot for every non-referral
// channel.
//
// THE STAMP: called from both tenant-creation paths AFTER the tenant is
// committed. Matches prospects by admin/brokerage email (the same idempotency
// key every web capture uses) and by phone (the key the AI reception uses —
// caller-ID E.164, so digit variants are tried). Per CLAUDE.md §3 every UPDATE
// is COUNTED via .select("id") — a stamp that matched nothing is reported as
// zero, never as success — and errors are read, aggregated and returned.
//
// IDEMPOTENT + NEVER-CLOBBER: only rows with converted_brokerage_id IS NULL
// are touched (a manual link to another brokerage is a staff decision this
// automatic path must not overwrite; a re-run is a clean zero). Status is only
// upgraded — a row already 'converted' keeps that status when the new tenant
// is merely trialing (it still gains the link).
//
// OUTCOME VOCABULARY (PROSPECT_STATUSES, lib/platform/growth-funnel.ts):
//   'trial'     — self-serve signup (14-day trial, no payment yet)
//   'converted' — superadmin-provisioned subscriber (active subscription)
// The trial → converted advance when a trial starts paying stays with the
// billing rail / growth board (the Stripe webhook is another lane's surface).
//
// Best-effort at the call sites: a stamping problem must never cost a tenant
// creation — but the loss is logged, never swallowed.

export type ConversionOutcome = "trial" | "converted"

export interface ProspectConversionInput {
  brokerageId: string
  /** Every email that could identify the prospect (admin + brokerage). */
  emails: Array<string | null | undefined>
  /** Optional phone (free text — digit variants are matched against the E.164 caller-ID key). */
  phone?: string | null
  outcome: ConversionOutcome
}

export interface ProspectConversionResult {
  /** Unconverted prospect rows that matched by email/phone. */
  matched: number
  /** Rows that received converted_brokerage_id (counted from the update's returning set). */
  linked: number
  /** Rows whose status advanced to the outcome (never a downgrade). */
  statusAdvanced: number
  errors: string[]
}

/** PURE: normalize candidate emails — lowercase, trimmed, unique, non-empty.
 *  Internal — proven through stampProspectConversion (test:prospect-conversion
 *  drives it with an injected client), not exported for nobody. */
function normalizeConversionEmails(emails: Array<string | null | undefined>): string[] {
  const out = new Set<string>()
  for (const e of emails) {
    const v = (e ?? "").trim().toLowerCase()
    if (v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) out.add(v)
  }
  return Array.from(out)
}

/** PURE: phone variants to try against the caller-ID key (raw, digits, +digits, +1digits).
 *  Internal — proven through stampProspectConversion, same as above. */
function phoneMatchVariants(phone: string | null | undefined): string[] {
  const raw = (phone ?? "").trim()
  if (!raw) return []
  const digits = raw.replace(/\D/g, "")
  if (digits.length < 7) return [] // too short to be a dialable line — don't match noise
  const out = new Set<string>([raw, digits, `+${digits}`])
  if (digits.length === 10) out.add(`+1${digits}`) // US caller-ID arrives E.164 with country code
  return Array.from(out)
}

/**
 * Stamp the conversion moment: prospect rows matching this new tenant's
 * email(s)/phone get converted_brokerage_id (+ a status upgrade). Counted,
 * idempotent, never clobbers an existing link. Errors are returned, not thrown.
 */
export async function stampProspectConversion(svc: any, input: ProspectConversionInput): Promise<ProspectConversionResult> {
  const out: ProspectConversionResult = { matched: 0, linked: 0, statusAdvanced: 0, errors: [] }
  const emails = normalizeConversionEmails(input.emails)
  const phones = phoneMatchVariants(input.phone)
  if (emails.length === 0 && phones.length === 0) return out
  if (!input.brokerageId) { out.errors.push("no brokerageId"); return out }

  // 1) Find unconverted candidates. Two keyed reads instead of one .or() —
  //    PostgREST or-trees with in-lists are easy to malform silently, and both
  //    columns are uniquely indexed, so two exact reads are cheap and provable.
  const ids = new Map<string, { status: string | null }>()
  if (emails.length > 0) {
    const { data, error } = await svc.from("platform_prospects")
      .select("id, status").is("converted_brokerage_id", null).in("email", emails)
    if (error) out.errors.push(`email match read: ${error.message}`)
    for (const r of (data ?? []) as Array<{ id: string; status: string | null }>) ids.set(r.id, { status: r.status })
  }
  if (phones.length > 0) {
    const { data, error } = await svc.from("platform_prospects")
      .select("id, status").is("converted_brokerage_id", null).in("phone", phones)
    if (error) out.errors.push(`phone match read: ${error.message}`)
    for (const r of (data ?? []) as Array<{ id: string; status: string | null }>) ids.set(r.id, { status: r.status })
  }
  out.matched = ids.size
  if (ids.size === 0) return out

  const nowIso = new Date().toISOString()
  // 2) Partition: status only moves FORWARD. A row already 'converted' never
  //    drops to 'trial' — it gets the link only.
  const linkOnly: string[] = []
  const full: string[] = []
  for (const [id, row] of ids) {
    if (input.outcome === "trial" && row.status === "converted") linkOnly.push(id)
    else full.push(id)
  }

  // 3) COUNTED updates (§3: a DELETE/UPDATE that matches nothing also resolves —
  //    .select("id") and count what came back; zero here means the row was
  //    converted by a concurrent writer between read and write, which is fine,
  //    but it is REPORTED as zero, not assumed).
  if (full.length > 0) {
    const { data, error } = await svc.from("platform_prospects")
      .update({ converted_brokerage_id: input.brokerageId, status: input.outcome, updated_at: nowIso })
      .in("id", full).is("converted_brokerage_id", null)
      .select("id")
    if (error) out.errors.push(`stamp update: ${error.message}`)
    else { out.linked += (data ?? []).length; out.statusAdvanced += (data ?? []).length }
  }
  if (linkOnly.length > 0) {
    const { data, error } = await svc.from("platform_prospects")
      .update({ converted_brokerage_id: input.brokerageId, updated_at: nowIso })
      .in("id", linkOnly).is("converted_brokerage_id", null)
      .select("id")
    if (error) out.errors.push(`link-only update: ${error.message}`)
    else out.linked += (data ?? []).length
  }

  // 4) Audit the conversion moment — same trail the manual link and the
  //    follow-up sweep write to. Checked (error read), one row per prospect.
  for (const id of [...full, ...linkOnly]) {
    const { error } = await svc.from("superadmin_audit_log").insert({
      actor_user_id: null, actor_email: "system:tenant_creation",
      action: "platform_prospect.converted", target_type: "platform_prospect", target_id: id,
      details: { brokerage_id: input.brokerageId, outcome: input.outcome, matched_by: { emails, phones: phones.length > 0 } },
    })
    if (error) out.errors.push(`audit ${id}: ${error.message}`)
  }

  return out
}
