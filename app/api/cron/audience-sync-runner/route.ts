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
}

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
  const { data: pendingRows } = await svc.from("audience_members")
    .select("id, brokerage_id, audience_id, contact_id, lead_id")
    .eq("sync_status", "pending")
    .not("contact_id", "is", null)
    .order("added_at", { ascending: true })
    .limit(5000)
  const pending = (pendingRows ?? []) as PendingRow[]
  if (pending.length === 0) {
    return NextResponse.json({ ran_at: new Date().toISOString(), drained: 0 })
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
  const audienceRuns: Array<{ audience_id: string; attempted: number; synced: number; rejected: number; error?: string }> = []

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
      audienceRuns.push({ audience_id: audienceId, attempted: rows.length, synced: 0, rejected: rows.length, error: "external_audience_id missing" })
      continue
    }

    // Pull PII for each pending row in one query per source.
    const contactIds = rows.map((r) => r.contact_id).filter((id): id is string => !!id)
    const leadIds    = rows.map((r) => r.lead_id).filter((id): id is string => !!id)
    const [contactsR, leadsR] = await Promise.all([
      contactIds.length > 0
        ? svc.from("contacts").select("id, email, phone, first_name, last_name").in("id", contactIds)
        : Promise.resolve({ data: [] }),
      leadIds.length > 0
        ? svc.from("leads").select("id, email, phone, first_name, last_name, mailing_zip").in("id", leadIds)
        : Promise.resolve({ data: [] }),
    ])
    const contactById = new Map<string, { email: string | null; phone: string | null; first_name: string | null; last_name: string | null }>()
    for (const r of (contactsR.data ?? []) as Array<{ id: string; email: string | null; phone: string | null; first_name: string | null; last_name: string | null }>) {
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
    for (const r of rows) {
      const src = r.contact_id ? contactById.get(r.contact_id) : (r.lead_id ? leadById.get(r.lead_id) : null)
      if (!src) continue
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

    if (data.length === 0) {
      await svc.from("audience_members")
        .update({ sync_status: "failed" })
        .in("id", rows.map((r) => r.id))
      totalFailed += rows.length
      audienceRuns.push({ audience_id: audienceId, attempted: rows.length, synced: 0, rejected: rows.length, error: "no_identifiable_pii" })
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

    audienceRuns.push({ audience_id: audienceId, attempted: data.length, synced, rejected, error: err ?? undefined })
  }

  return NextResponse.json({
    ran_at:        new Date().toISOString(),
    drained:       pending.length,
    total_synced:  totalSynced,
    total_failed:  totalFailed,
    audience_runs: audienceRuns,
  })
}
