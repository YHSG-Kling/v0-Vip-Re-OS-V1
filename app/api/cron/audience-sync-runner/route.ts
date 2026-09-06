/**
 * app/api/cron/audience-sync-runner/route.ts
 *
 * Wave 38 — drains audience_members.sync_status='pending' rows and
 * pushes them to Facebook Custom Audiences via the connector
 * gateway. Batched per (brokerage × audience) so each FB call carries
 * the maximum number of records (FB caps around 10K per call).
 *
 * Schedule: every 15 min (slash-15 in vercel.json cron syntax). The lead-capture +
 * conversion hooks stage rows synchronously but inline-firing the FB
 * API there would block the lead capture path; the cron is the
 * async drain.
 *
 * Auth: CRON_SECRET dual scheme. No-op when META_APP_ID +
 * META_APP_SECRET aren't configured.
 *
 * Hashing: FB requires SHA-256 of normalized email + phone. We
 * compute that here so the audience_members row never stores hashed
 * PII (raw contact PII stays in contacts/leads as the canonical
 * source).
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { isAudienceUploadEligible, AUDIENCE_CONSENT_COLUMNS } from "@/lib/ads/audience-eligibility"
import { describeConsentChange } from "@/lib/audiences/audience-sync"
import { createHash } from "node:crypto"

export const dynamic = "force-dynamic"
export const maxDuration = 300

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

interface PendingRow {
  id:           string
  brokerage_id: string
  audience_id:  string
  contact_id:   string | null
  lead_id:      string | null
  /** Consent basis recorded at add-time (lib/audiences/audience-sync.ts
   *  stageMembership). Read on the removal path so a suppression names WHAT
   *  lapsed — m164:53 "so removal recovers it". */
  consent_snapshot: unknown
  sync_status:  string
  synced_at:    string | null
}

const MEMBER_COLS = "id, brokerage_id, audience_id, contact_id, lead_id, consent_snapshot, sync_status, synced_at"

// ── synced_at ages the re-sync selection (wave 26 columns) ──────────────────
// synced_at was stamped on every successful push (below) and never read: a
// row, once 'synced', was never selected again. So (a) a contact whose email
// or phone changed after the push was matched on Meta by identifiers they no
// longer use, and (b) — the compliance half — a contact who REVOKED consent
// after the push stayed in the Custom Audience indefinitely, because the
// eligibility gate only ever ran on 'pending' rows. Rows synced more than
// RESYNC_AFTER_DAYS ago (or synced with no timestamp — pre-column rows) are
// now swept back through the same gate: eligible ones are re-uploaded (Meta's
// /users endpoint upserts, so this is idempotent) and get a fresh synced_at;
// ineligible ones are REMOVED with the basis change recorded.
const RESYNC_AFTER_DAYS = 30
const RESYNC_BATCH = 1000

function hash(input: string): string {
  return createHash("sha256").update(input.toLowerCase().trim()).digest("hex")
}

function normalizePhone(p: string): string {
  // FB expects digits only, leading country code (US default).
  const digits = p.replace(/\D/g, "")
  if (digits.length === 10) return `1${digits}`
  return digits
}

export async function GET(req: NextRequest) {
  const auth     = req.headers.get("authorization")?.replace("Bearer ", "")
  const url      = new URL(req.url)
  const qs       = url.searchParams.get("secret")
  const expected = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (auth !== expected && qs !== expected) return unauthorized()

  const appId     = process.env.META_APP_ID
  const appSecret = process.env.META_APP_SECRET
  if (!appId || !appSecret) {
    return NextResponse.json({ ran_at: new Date().toISOString(), skipped: "META_APP_* not configured" })
  }
  const accessToken = `${appId}|${appSecret}`

  const svc = createServiceClient()

  // Pull pending rows. Per-cycle cap to avoid one cron tick eating
  // an enormous backlog in one shot.
  //
  // Wave 38 CORRECTION — contact-only push. The .not('contact_id',
  // 'is', null) filter guards against any legacy lead-only rows
  // that may have leaked in before m165 marked them 'removed'.
  // Meta Custom Audiences require consent; only contacts (with
  // tcpa_consent verified at conversion) qualify.
  const { data: pendingRows, error: pendingErr } = await svc.from("audience_members")
    .select(MEMBER_COLS)
    .eq("sync_status", "pending")
    .not("contact_id", "is", null)
    .order("added_at", { ascending: true })
    .limit(5000)
  if (pendingErr) {
    // §3 — a refused read is not an empty queue.
    return NextResponse.json({ ran_at: new Date().toISOString(), error: `audience_members read refused: ${pendingErr.message}` }, { status: 500 })
  }

  // Aged re-sync selection (see RESYNC_AFTER_DAYS above).
  const resyncBefore = new Date(Date.now() - RESYNC_AFTER_DAYS * 86_400_000).toISOString()
  const { data: agedRows, error: agedErr } = await svc.from("audience_members")
    .select(MEMBER_COLS)
    .eq("sync_status", "synced")
    .not("contact_id", "is", null)
    .or(`synced_at.is.null,synced_at.lt.${resyncBefore}`)
    .order("synced_at", { ascending: true, nullsFirst: true })
    .limit(RESYNC_BATCH)
  if (agedErr) {
    // The pending drain must still run; the aging half reports its refusal
    // in the payload rather than pretending nothing had aged.
    console.error("[audience-sync-runner] aged re-sync read refused:", agedErr.message)
  }

  const seen = new Set<string>()
  const pending: PendingRow[] = []
  for (const r of [...((pendingRows ?? []) as PendingRow[]), ...((agedRows ?? []) as PendingRow[])]) {
    if (seen.has(r.id)) continue
    seen.add(r.id); pending.push(r)
  }
  const pendingSelected = (pendingRows ?? []).length
  const resyncSelected  = (agedRows ?? []).length
  if (pending.length === 0) {
    return NextResponse.json({
      ran_at: new Date().toISOString(), drained: 0,
      pending_selected: 0, resync_selected: 0,
      resync_read_error: agedErr?.message ?? null,
    })
  }

  // Bucket by (brokerage, audience) → batch FB call.
  const buckets = new Map<string, PendingRow[]>()
  for (const r of pending) {
    const k = `${r.brokerage_id}|${r.audience_id}`
    const arr = buckets.get(k) ?? []
    arr.push(r); buckets.set(k, arr)
  }

  let totalSynced = 0
  let totalFailed = 0
  let totalRemoved = 0
  // Every removal, with the consent basis recovered from the snapshot. Capped
  // in the payload so one big lapse cannot bloat the response; the full list
  // goes to the log.
  const removals: Array<{ member_id: string; audience_id: string; previously: string; snapshot_at: string | null; basis: string[] }> = []
  const audienceRuns: Array<{ audience_id: string; attempted: number; synced: number; rejected: number; removed: number; error?: string }> = []

  for (const [key, rows] of buckets.entries()) {
    const [, audienceId] = key.split("|")

    // Pull the external_audience_id (FB-side) for this audience.
    const { data: audienceRow } = await svc.from("facebook_custom_audiences")
      .select("external_audience_id, brokerage_id")
      .eq("id", audienceId)
      .maybeSingle()
    const audMeta = audienceRow as { external_audience_id: string | null; brokerage_id: string | null } | null
    if (!audMeta?.external_audience_id) {
      // Audience not yet provisioned on FB — mark these rows failed
      // with a clear error so the admin sees what's missing.
      await svc.from("audience_members")
        .update({ sync_status: "failed" })
        .in("id", rows.map((r) => r.id))
      totalFailed += rows.length
      audienceRuns.push({ audience_id: audienceId, attempted: rows.length, synced: 0, rejected: rows.length, removed: 0, error: "external_audience_id missing" })
      continue
    }

    // Pull PII for each pending row in one query per source.
    const contactIds = rows.map((r) => r.contact_id).filter((id): id is string => !!id)
    const leadIds    = rows.map((r) => r.lead_id).filter((id): id is string => !!id)
    const [contactsR, leadsR] = await Promise.all([
      contactIds.length > 0
        ? svc.from("contacts").select(`id, email, phone, first_name, last_name, ${AUDIENCE_CONSENT_COLUMNS}`).in("id", contactIds)
        : Promise.resolve({ data: [] }),
      leadIds.length > 0
        ? svc.from("leads").select("id, email, phone, first_name, last_name, mailing_zip").in("id", leadIds)
        : Promise.resolve({ data: [] }),
    ])
    const contactById = new Map<string, any>()
    for (const r of (contactsR.data ?? []) as any[]) {
      contactById.set(r.id, r)
    }
    const leadById = new Map<string, { email: string | null; phone: string | null; first_name: string | null; last_name: string | null; mailing_zip: string | null }>()
    for (const r of (leadsR.data ?? []) as Array<{ id: string; email: string | null; phone: string | null; first_name: string | null; last_name: string | null; mailing_zip: string | null }>) {
      leadById.set(r.id, r)
    }

    // FB expects rows of pre-hashed PII in `data`. Schema per row:
    //   [EMAIL_hash, PHONE_hash, FN_hash, LN_hash, ZIP_hash, COUNTRY_hash]
    // Empty field = empty string; FB still matches on any present
    // identifier.
    const schema = ["EMAIL", "PHONE", "FN", "LN", "ZIP", "COUNTRY"]
    const data: string[][] = []
    const rowIdByIndex: string[] = []  // parallel index so we can mark per-row outcomes
    const suppressedRowIds: string[] = []  // contacts who revoked the PII-share (CCPA do-not-share)
    for (const r of rows) {
      const src = r.contact_id ? contactById.get(r.contact_id) : (r.lead_id ? leadById.get(r.lead_id) : null)
      if (!src) continue
      // PII-share gate: never upload a withdrawn / fully-opted-out contact's identifiers to Meta.
      if (r.contact_id && !isAudienceUploadEligible(src)) {
        suppressedRowIds.push(r.id)
        // THE REMOVAL RECOVERS THE SNAPSHOT (m164:53). Name what lapsed
        // between add-time and now, so the audit says "tcpa_consent
        // true→false on a row synced 2026-06-01", not just "removed".
        const change = describeConsentChange(r.consent_snapshot, src as Record<string, unknown>)
        removals.push({
          member_id: r.id, audience_id: audienceId,
          previously: r.sync_status, snapshot_at: change.snapshotAt, basis: change.basis,
        })
        console.warn("[audience-sync-runner] member removed — consent basis lapsed", {
          member_id: r.id, audience_id: audienceId, previously: r.sync_status,
          synced_at: r.synced_at, snapshot_at: change.snapshotAt, basis: change.basis,
        })
        continue
      }
      const email = src.email ? hash(src.email) : ""
      const phone = src.phone ? hash(normalizePhone(src.phone)) : ""
      const fn    = src.first_name ? hash(src.first_name) : ""
      const ln    = src.last_name  ? hash(src.last_name)  : ""
      const zip   = ("mailing_zip" in src && src.mailing_zip) ? hash(String(src.mailing_zip)) : ""
      const country = hash("us")
      // FB requires AT LEAST one identifier per row.
      if (!email && !phone && !fn && !ln) continue
      data.push([email, phone, fn, ln, zip, country])
      rowIdByIndex.push(r.id)
    }

    // CCPA do-not-share: drop opted-out / withdrawn contacts from the audience (never uploaded).
    // removed_at is stamped so the revive path (audience-sync.ts stageMembership)
    // can say when they left when they come back.
    if (suppressedRowIds.length > 0) {
      const { data: removedRows, error: removeErr } = await svc.from("audience_members")
        .update({ sync_status: "removed", removed_at: new Date().toISOString() })
        .in("id", suppressedRowIds)
        .select("id")
      if (removeErr) {
        console.error("[audience-sync-runner] removal update refused:", removeErr.message, { ids: suppressedRowIds })
      } else {
        // §3: a matched-nothing update resolves too — count what came back.
        totalRemoved += (removedRows ?? []).length
        if ((removedRows ?? []).length !== suppressedRowIds.length) {
          console.error("[audience-sync-runner] removal matched fewer rows than selected", {
            selected: suppressedRowIds.length, removed: (removedRows ?? []).length,
          })
        }
      }
    }

    if (data.length === 0) {
      // Nothing left to upload for this audience. A sweep that only found
      // lapsed members is a COMPLETED removal pass, not a failure — only
      // rows that were neither uploaded nor removed are failed.
      const remaining = rows.map((r) => r.id).filter((id) => !suppressedRowIds.includes(id))
      if (remaining.length > 0) {
        await svc.from("audience_members").update({ sync_status: "failed" }).in("id", remaining)
        totalFailed += remaining.length
      }
      audienceRuns.push({
        audience_id: audienceId, attempted: rows.length, synced: 0, rejected: remaining.length,
        removed: suppressedRowIds.length, error: remaining.length > 0 ? "no_identifiable_pii" : undefined,
      })
      continue
    }

    // FB call: POST /<audience_id>/users with payload { schema, data }.
    const payload = {
      payload: JSON.stringify({ schema, data }),
      access_token: accessToken,
    }
    const res = await callConnector<{ audience_id?: string; num_received?: number; num_invalid_entries?: number; error?: { message: string } }>({
      connector: "meta_ads",
      baseUrl:   "https://graph.facebook.com",
      path:      `v18.0/${encodeURIComponent(audMeta.external_audience_id)}/users`,
      method:    "POST",
      auth:      { style: "none" },
      bodyType:  "form",
      body:      payload as unknown as Record<string, string>,
      responseType: "json",
      timeoutMs:    30_000,
    })

    const synced   = res.ok && res.data?.num_received ? res.data.num_received : 0
    const rejected = res.data?.num_invalid_entries ?? 0
    const err      = res.ok ? null : (res.data?.error?.message ?? `connector_${res.status ?? "error"}`)

    // Mark per-row outcomes. FB doesn't tell us WHICH rows failed at
    // index-level so v1 is binary: all-synced on success, all-failed
    // on call-level failure.
    if (res.ok && err == null) {
      await svc.from("audience_members")
        .update({ sync_status: "synced", synced_at: new Date().toISOString() })
        .in("id", rowIdByIndex)
      totalSynced += synced
    } else {
      await svc.from("audience_members")
        .update({ sync_status: "failed" })
        .in("id", rowIdByIndex)
      totalFailed += rowIdByIndex.length
    }

    // Audit row for the existing audience_sync_runs ledger.
    await svc.from("audience_sync_runs").insert({
      brokerage_id:       audMeta.brokerage_id,
      audience_id:        audienceId,
      run_status:         err ? "failed" : "completed",
      records_attempted:  data.length,
      records_synced:     synced,
      records_rejected:   rejected,
      error_message:      err,
      provider_response:  res.data ?? null,
      completed_at:       new Date().toISOString(),
    })

    audienceRuns.push({ audience_id: audienceId, attempted: data.length, synced, rejected, removed: suppressedRowIds.length, error: err ?? undefined })
  }

  return NextResponse.json({
    ran_at:           new Date().toISOString(),
    drained:          pending.length,
    pending_selected: pendingSelected,
    resync_selected:  resyncSelected,
    resync_after_days: RESYNC_AFTER_DAYS,
    resync_read_error: agedErr?.message ?? null,
    total_synced:     totalSynced,
    total_failed:     totalFailed,
    total_removed:    totalRemoved,
    removals:         removals.slice(0, 50),
    removals_truncated: Math.max(0, removals.length - 50),
    audience_runs:    audienceRuns,
  })
}
