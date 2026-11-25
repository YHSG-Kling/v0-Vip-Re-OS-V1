"use server"

// ToS ACCEPTANCE TRACKING — a durable record of WHO accepted WHICH terms version
// WHEN (with IP/UA), captured at signup. Current version lives on
// platform_settings.tos_version; acceptance is idempotent per (email, version).

import { createServiceClient } from "@/lib/supabase/service"
import { createClient } from "@/lib/supabase/server"
import { headers } from "next/headers"
import { requirePlatformStaff } from "@/lib/auth/platform-guard"

export async function getCurrentTosVersionAction(): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  try {
    const svc = createServiceClient()
    const { data } = await svc.from("platform_settings").select("tos_version").limit(1).maybeSingle()
    return { ok: true, version: (data as any)?.tos_version ?? "2026-07-01" }
  } catch (e: any) { return { ok: false, error: e?.message ?? "failed" } }
}

/** PUBLIC: record a ToS acceptance (idempotent per email+version). */
export async function recordTosAcceptanceAction(input: { email: string; version: string }): Promise<{ ok: boolean; error?: string }> {
  const email = (input.email ?? "").trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Valid email required" }
  const version = (input.version ?? "").trim()
  if (!version) return { ok: false, error: "version required" }
  // WAVE 155 (lane 155R21) — THE DECISION, before the write: the per-connection cap of the platform's OWN signup funnel
  // (decidePublicDoor; no tenant exists yet, so the opt-in is the platform's and there is no login wall). A refusal is answered
  // honestly and the funnel stops (app/get-started/trial-funnel-form.tsx) — an acceptance is never dropped silently. No ledger
  // receipt: agent_action_ledger.brokerage_id is NOT NULL and a pre-account acceptance has no tenant; the acceptance row
  // (email, version, IP, user agent, accepted_at) is the legal record.
  // WAVE 155 (lane 155R23 — LAW 5, no tenant): and the ACT is evidenced on the platform's own door once the row landed — ONE
  // superadmin_audit_log row (recordPlatformEvidence): no actor user (pre-account), the public surface named, the acceptance
  // row's id and the version. The email stays on the acceptance row only. Still no ledger row and no invented tenant.
  const { decidePublicDoor, publicCallerIp } = await import("@/lib/security/public-rate-limit")
  const door = await decidePublicDoor({
    surface: "platform-tos-acceptance", callerKey: await publicCallerIp(), cap: { limit: 10, windowMs: 10 * 60_000 },
    optIn: async () => ({ brokerageId: null, platform: true, basis: "the platform's own public signup funnel (no tenant)" }),
  })
  if (!door.allowed) return { ok: false, error: "Too many requests from this connection — your acceptance was NOT recorded. Please try again in a few minutes." }
  const svc = createServiceClient()
  // WAVE 156 (lane 156O) — the version the browser names is a CLAIM: it must be the version the platform serves now, and the hash
  // is of the text served for it, computed here (never sent by the browser). An unknown, stale or tampered version is refused.
  const served = await servedTermsHash(svc, version)
  if (!served.ok) return { ok: false, error: served.error }
  const hdrs = await headers()
  const { data: accepted, error, hashStored } = await upsertTosAcceptance(svc, {
    email, tos_version: served.version,
    ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
    user_agent: hdrs.get("user-agent"),
  }, served.sha256)
  if (error) return { ok: false, error: error.message }
  const { recordPlatformEvidence } = await import("@/lib/platform/staff-action-gate")
  await recordPlatformEvidence({
    actorUserId: null, actorEmail: "public:platform-tos-acceptance", action: "platform_tos.accepted", targetType: "platform_tos_acceptance",
    targetId: ((accepted ?? []) as Array<{ id: string }>)[0]?.id ?? null, details: { tos_version: served.version, content_sha256: served.sha256, hash_on_row: hashStored, door: door.basis },
  })
  return { ok: true }
}

/**
 * WAVE 156 (lane 156O) — THE SHA-256 OF THE TERMS TEXT SERVED FOR A VERSION (directive 156O: version / hash / timestamp).
 * The current version is platform_settings.tos_version (absent row → the same "2026-07-01" default every reader here uses); a
 * REFUSED settings read refuses the acceptance (fail closed). `claimed`, when given, must equal the current version. The text is
 * lib/branding/platform-rights-notice.ts servedTermsDocument — the version plus the /legal notice exactly as /legal renders it
 * (product brand, current UTC year). Nothing here changes which text is published; it records the hash of what is shown.
 */
async function servedTermsHash(svc: any, claimed: string | null): Promise<{ ok: true; version: string; sha256: string } | { ok: false; error: string }> {
  const { data, error } = await svc.from("platform_settings").select("tos_version, product_brand").limit(1).maybeSingle()
  if (error) return { ok: false, error: "The current terms could not be read — your acceptance was NOT recorded. Please try again." }
  const current = String((data as any)?.tos_version ?? "2026-07-01")
  if (claimed !== null && claimed !== current) return { ok: false, error: "These terms are not the current version — reload the page and accept the current terms. Nothing was recorded." }
  const [{ servedTermsDocument }, { resolveProductBrand }] = await Promise.all([import("@/lib/branding/platform-rights-notice"), import("@/lib/platform/product-brand")])
  const text = servedTermsDocument({ tosVersion: current, holder: resolveProductBrand((data as any)?.product_brand)?.name ?? "", year: new Date().getUTCFullYear() })
  if (text === null) return { ok: false, error: "The text of the current terms version could not be resolved — your acceptance was NOT recorded." }
  const { createHash } = await import("node:crypto")
  return { ok: true, version: current, sha256: createHash("sha256").update(text, "utf8").digest("hex") }
}

/** The acceptance upsert WITH the hash; before m1066 is applied the column is absent and PostgREST refuses the WHOLE write
 *  (PGRST204 / 42703, CLAUDE.md §3) — then the same row is written without it, so an acceptance is never lost. */
async function upsertTosAcceptance(svc: any, row: Record<string, unknown>, sha256: string): Promise<{ data: unknown; error: { message: string } | null; hashStored: boolean }> {
  const first = await svc.from("platform_tos_acceptances").upsert({ ...row, content_sha256: sha256 }, { onConflict: "email,tos_version" }).select("id")
  const absent = first.error && (first.error.code === "PGRST204" || first.error.code === "42703") && /content_sha256/.test(first.error.message ?? "")
  if (!absent) return { data: first.data, error: first.error, hashStored: !first.error }
  const again = await svc.from("platform_tos_acceptances").upsert(row, { onConflict: "email,tos_version" }).select("id")
  return { data: again.data, error: again.error, hashStored: false }
}

/**
 * READER — the re-prompt gate. Renders as `<TosReacceptanceBanner>` on every
 * dashboard page (app/components/layout/app-shell.tsx, same slot as
 * ImpersonationBanner). platform_tos_acceptances.tos_version /.email were
 * written on every signup and never read anywhere (readerless-write-census)
 * — a version bump on platform_settings.tos_version never reached anyone who
 * had already accepted an older version.
 *
 * TENANT/IDENTITY: the email checked is the SIGNED-IN user's own session
 * email (§4) — never a request body. Non-authenticated callers get
 * needsAcceptance:false so the banner stays silent rather than erroring.
 */
export async function checkCurrentUserTosStatusAction(): Promise<
  { ok: true; needsAcceptance: boolean; currentVersion: string; fingerprint: TosFingerprint } | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return { ok: true, needsAcceptance: false, currentVersion: "", fingerprint: "none" }

  // WAVE 156 (lane 156O round 3) — THE READER of content_sha256. An acceptance covers what is served only when it names the
  // current version AND its stored hash equals the hash of the text served NOW (servedTermsHash: the version plus the /legal
  // notice as rendered). FAIL DIRECTION, deliberately: anything that cannot be read ASKS AGAIN (needsAcceptance true) — the
  // current terms, the acceptance row — never a pass. A row written before m1066 (hash NULL) keeps the version-only answer and is
  // labeled "not_fingerprinted": never treated as a match, never locked out.
  const svc = createServiceClient()
  const served = await servedTermsHash(svc, null)
  if (!served.ok) return { ok: true, needsAcceptance: true, currentVersion: "", fingerprint: "unreadable" }
  const row = await readTosAcceptance(svc, user.email.trim().toLowerCase(), served.version)
  const fingerprint = tosFingerprint(row, served.sha256)
  return { ok: true, needsAcceptance: fingerprint !== "match" && fingerprint !== "not_fingerprinted", currentVersion: served.version, fingerprint }
}

/** How a stored acceptance relates to the text served now. */
type TosFingerprint = "match" | "not_fingerprinted" | "different_text" | "none" | "unreadable"
type TosRowRead = { state: "row"; sha256: string | null } | { state: "none" } | { state: "unreadable" }

/** PURE — the comparison. A stored hash that is not exactly the served one (another text, or a tampered value) is "different_text". */
function tosFingerprint(row: TosRowRead, servedSha256: string): TosFingerprint {
  if (row.state === "unreadable") return "unreadable"
  if (row.state === "none") return "none"
  if (row.sha256 === null) return "not_fingerprinted"
  return row.sha256 === servedSha256 ? "match" : "different_text"
}

/** The acceptance row for (email, version). Before m1066 the hash column is absent (PGRST204 / 42703 refuses the whole read):
 *  the row is re-read without it and reported unfingerprinted. Any other refusal is "unreadable" (fail closed: ask again). */
async function readTosAcceptance(svc: any, email: string, version: string): Promise<TosRowRead> {
  const first = await svc.from("platform_tos_acceptances").select("id, content_sha256").eq("email", email).eq("tos_version", version).maybeSingle()
  let data = first.data, error = first.error
  if (error && (error.code === "PGRST204" || error.code === "42703") && /content_sha256/.test(error.message ?? "")) {
    const again = await svc.from("platform_tos_acceptances").select("id").eq("email", email).eq("tos_version", version).maybeSingle()
    data = again.data ? { ...again.data, content_sha256: null } : again.data
    error = again.error
  }
  if (error) return { state: "unreadable" }
  if (!data) return { state: "none" }
  const h = (data as { content_sha256?: unknown }).content_sha256
  return { state: "row", sha256: typeof h === "string" ? h : null }
}

/** Accept the CURRENT terms version as the signed-in user (session email — §4). */
export async function acceptCurrentTosAsCurrentUserAction(): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return { ok: false, error: "Not authenticated" }
  const sessionEmail = user.email
  const run = async (user = { email: sessionEmail }): Promise<{ ok: boolean; error?: string }> => {

  const svc = createServiceClient()
  // WAVE 156 (lane 156O): the current version and the sha256 of its served text, server-side; a refused settings read refuses.
  const served = await servedTermsHash(svc, null)
  if (!served.ok) return { ok: false, error: served.error }

  const hdrs = await headers()
  const { error } = await upsertTosAcceptance(svc, {
    email: user.email.trim().toLowerCase(),
    tos_version: served.version,
    ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
    user_agent: hdrs.get("user-agent"),
  }, served.sha256)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
  }
  // The receipt names the tenant of the SESSION user; platform staff (no brokerage) have no valid ledger row and accept unrecorded.
  const { data: tosUser } = await supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (!tosUser?.brokerage_id) return run()
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const lr = await ledgerSessionAction({ brokerageId: tosUser.brokerage_id as string, action: "platform.tos_acceptance.accept", actor: { type: "user", userId: user.id }, subject: { type: "user", id: user.id }, riskClass: "LEGAL", reasonCode: "HUMAN_REQUESTED" }, run)
  return "ok" in lr ? lr : { ok: false, error: lr.error ?? "This acceptance was not recorded — please try again" }
}

/**
 * READER — compliance/legal export. platform_tos_acceptances carries no
 * brokerage_id (it records pre-account, platform-wide consent at signup —
 * schema-snapshot.ts confirms no tenant column), so there is no tenant subset
 * for a tenant compliance_officer to see; this is gated to PLATFORM staff
 * (requirePlatformStaff — superadmin/admin/marketing/support), the only
 * roster with legitimate reach over a table with no tenant boundary.
 * Explicit columns, newest first, capped.
 */
export async function listTosAcceptancesAction(limit = 200): Promise<
  { ok: true; servedSha256: string | null; rows: Array<{ id: string; email: string; tos_version: string; ip_address: string | null; user_agent: string | null; accepted_at: string; content_sha256: string | null; fingerprint: TosFingerprint | "earlier_version" }> }
  | { ok: false; error: string }
> {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return { ok: false, error: guard.error }

  // WAVE 156 (lane 156O round 3): the evidence a dispute needs — version, accepted-at and the fingerprint of the accepted text,
  // beside the fingerprint of the text served now. Before m1066 the hash column is absent and the log is read without it.
  const svc = createServiceClient()
  const cols = "id, email, tos_version, ip_address, user_agent, accepted_at"
  const page = (sel: string) => svc.from("platform_tos_acceptances").select(sel).order("accepted_at", { ascending: false }).limit(Math.min(limit, 1000))
  let { data, error } = await page(`${cols}, content_sha256`)
  if (error && (error.code === "PGRST204" || error.code === "42703") && /content_sha256/.test(error.message ?? "")) ({ data, error } = await page(cols))
  if (error) return { ok: false, error: error.message }
  const served = await servedTermsHash(svc, null)
  const rows = ((data ?? []) as Array<Record<string, any>>).map((r) => {
    const content_sha256 = typeof r.content_sha256 === "string" ? r.content_sha256 : null
    const fingerprint: TosFingerprint | "earlier_version" = !served.ok ? "unreadable"
      : r.tos_version !== served.version ? (content_sha256 ? "earlier_version" : "not_fingerprinted")
      : tosFingerprint({ state: "row", sha256: content_sha256 }, served.sha256)
    return { id: r.id, email: r.email, tos_version: r.tos_version, ip_address: r.ip_address ?? null, user_agent: r.user_agent ?? null, accepted_at: r.accepted_at, content_sha256, fingerprint }
  })
  return { ok: true, servedSha256: served.ok ? served.sha256 : null, rows }
}
