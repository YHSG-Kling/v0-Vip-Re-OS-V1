#!/usr/bin/env tsx
/**
 * scripts/marketing-qr-simulator.ts  (npm run test:marketing-qr)
 *
 * Tracked, scannable QR on PRINT/digital marketing material — listing flyers, the listing packet,
 * open-house & just-sold flyers, CMAs — REUSING the qr_codes backend + the shared tracked-QR core
 * (no new tables). Mirrors the video-qr simulator: a pure Layer 1 always runs; a live Layer 2 runs
 * only with SUPABASE_SERVICE_ROLE_KEY, seeds real rows, asserts, then reverse-deletes (cleanup == 0).
 */
// lib/marketing/marketing-qr.ts imports `server-only`, which throws outside a Server Component.
// Neutralize that guard in the require cache BEFORE importing the system under test.
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* nothing to shim */ }

import { randomUUID } from "node:crypto"
import type { MarketingQrKind } from "../lib/marketing/marketing-qr"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

async function main(): Promise<void> {
  const { qrDestinationForMaterial, mintMarketingQr } = await import("../lib/marketing/marketing-qr")

  console.log("\n[marketing QR · pure — material kind → destination_type + URL]")
  const ORIGIN = "https://app.example.com"
  const refs = { listingId: "L-1", agentSlug: "jane-doe" }
  // Wave 141F: the open-house flyer used to pin `/listings/L-1/rsvp` — a route that does not
  // exist (app/listings/[listingId] has no rsvp child). The paths now come from the one
  // destination table (lib/marketing/qr-contract.ts) and are held to the RULE below: every
  // built URL is an allow-listed in-app public path backed by a real app/<segment> directory.
  const { isQrInAppPublicPath, QR_IN_APP_PUBLIC_PREFIXES } = await import("../lib/marketing/qr-contract")
  const { existsSync } = await import("node:fs")
  const { join } = await import("node:path")
  const expected: Record<MarketingQrKind, { dt: string; urlPart: string }> = {
    listing_flyer:    { dt: "listing_detail", urlPart: "/listings/L-1" },
    listing_packet:   { dt: "listing_detail", urlPart: "/listings/L-1" },
    just_sold_flyer:  { dt: "listing_detail", urlPart: "/listings/L-1" },
    open_house_flyer: { dt: "book_meeting",   urlPart: "/listings/L-1" },
    cma:              { dt: "landing_page",   urlPart: "/home-value/jane-doe" },
  }
  for (const kind of Object.keys(expected) as MarketingQrKind[]) {
    const d = qrDestinationForMaterial(kind)
    const url = d.buildTargetUrl(ORIGIN, refs)
    check(`${kind} → ${expected[kind].dt} @ ${expected[kind].urlPart}`,
      d.destinationType === expected[kind].dt && !!url && url.includes(expected[kind].urlPart))
    const path = url ? url.slice(ORIGIN.length) : ""
    const seg = path.split("/")[1]
    check(`${kind}'s URL is an allow-listed in-app public path backed by app/${seg}`,
      !!url && url.startsWith(ORIGIN + "/") && isQrInAppPublicPath(path) && existsSync(join(process.cwd(), "app", seg)))
  }
  check("every allow-listed prefix is a real public route directory (the rule the table is held to)",
    QR_IN_APP_PUBLIC_PREFIXES.every((p) => existsSync(join(process.cwd(), "app", p.replace(/\//g, "")))))
  check("with NO listing and NO agent slug the open-house flyer points at nothing app-hosted (null → the code's own landing), never at the dashboard list",
    qrDestinationForMaterial("open_house_flyer").buildTargetUrl(ORIGIN, {}) === null
    && qrDestinationForMaterial("listing_flyer").buildTargetUrl(ORIGIN, {}) === null)
  // only enum-valid destination_types are emitted
  const dts = new Set((Object.keys(expected) as MarketingQrKind[]).map(k => qrDestinationForMaterial(k).destinationType))
  check("emits only enum-valid destination_types", [...dts].every(d => ["listing_detail", "book_meeting", "landing_page"].includes(d)))

  await scanDoorEndToEnd()

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[marketing QR · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved the mapping")
  } else {
    console.log("\n[marketing QR · live — mint, idempotency, created flag, owner-assign notification → self-clean]")
    const { createServiceClient } = await import("../lib/supabase/service")
    const svc = createServiceClient()
    const tag = `MKTQR-${randomUUID().slice(0, 8)}`
    const brokerageId = randomUUID()
    const adminUserId = randomUUID()
    let listingId: string | null = null
    try {
      await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} Brokerage`, city: "Austin", state: "TX" })
      await svc.from("users").insert({ id: adminUserId, brokerage_id: brokerageId, email: `admin+${tag}@demo.local`, first_name: "Broker", last_name: "Admin", user_type: "broker_admin" })
      const { data: lr } = await svc.from("listings").insert({ brokerage_id: brokerageId, status: "active", address: `${tag} 100 Main St` }).select("id").single()
      listingId = lr!.id as string

      // First mint with notifyOwner (no agent → falls back to the broker-admin).
      const first = await mintMarketingQr({ brokerageId, kind: "listing_packet", listingId, notifyOwner: true, materialName: "100 Main St" })
      check("mints a tracked code with a resolvable scan URL", !!first && /\/api\/qr\/scan\?slug=/.test(first.scanUrl))
      check("returns a valid PNG data URL", !!first && first.qrCodeDataUrl.startsWith("data:image/png;base64,"))
      check("destination_type is listing_detail", first?.destinationType === "listing_detail")
      check("first mint reports created=true", first?.created === true)

      const second = await mintMarketingQr({ brokerageId, kind: "listing_packet", listingId, notifyOwner: true })
      check("re-mint is idempotent (same slug reused)", !!second && !!first && second.slug === first.slug)
      check("re-mint reports created=false", second?.created === false)

      const { count } = await svc.from("qr_codes").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).eq("label", `material:listing_packet:${listingId}`)
      check("exactly ONE qr_codes row exists for (listing, kind)", (count ?? 0) === 1)

      // The broker-admin got ONE assign-URL notification (only on the created mint, not the re-mint).
      const { count: ncount } = await svc.from("notifications").select("id", { count: "exact", head: true })
        .eq("user_id", adminUserId).eq("type", "qr_url_assignment_needed")
      check("owner notified ONCE to assign the URL (created only, not re-mint)", (ncount ?? 0) === 1)
    } finally {
      await svc.from("notifications").delete().eq("user_id", adminUserId)
      await svc.from("qr_codes").delete().eq("brokerage_id", brokerageId)
      if (listingId) await svc.from("listings").delete().eq("id", listingId)
      await svc.from("users").delete().eq("id", adminUserId)
      await svc.from("brokerages").delete().eq("id", brokerageId)
      const { count } = await svc.from("qr_codes").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
      check("cleanup complete", (count ?? 0) === 0)
    }
  }

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ MARKETING_QR_FAIL"); process.exit(1) }
  console.log(" ✅ MARKETING_QR_PASS — listing flyers/packets carry a tracked, scannable QR")
}

/**
 * WAVE 152 (lane 152C) — THE SCAN DOOR, END TO END, ON THE IN-MEMORY CLIENT (SIMULATED: no network, no database).
 * Drives the REAL `GET` of app/api/qr/scan/route.ts. Seams (require cache, the pattern this file already uses for
 * `server-only`): lib/supabase/service → the in-memory client; lib/kernel/emit → a recorder (the kernel fan-out — staff
 * alerts, sequences — is other managers' code and must not run from a proof). Directive 152C proofs: an old printed
 * code resolves after an allowed edit; a scan creates no Contact; repeated / bot scans are identified; a disabled code
 * answers with a safe, helpful page (never a raw 500).
 */
async function scanDoorEndToEnd(): Promise<void> {
  console.log("\n[QR scan door · end to end on the in-memory client — SIMULATED (wave 152, 152C)]")
  const { memSupabase } = await import("./in-memory-supabase")
  type Mem = ReturnType<typeof memSupabase>
  const seed = (opts: { missingColumns?: Record<string, string[]>; refuse?: Record<string, string> } = {}): Mem => memSupabase({
    qr_codes: [
      { id: "q-live", brokerage_id: "bA", agent_id: null, slug: "tok-live", label: "Yard sign", target_url: "/listings/LA", destination_type: "listing_detail", purpose: "listing", is_active: true, scan_count: 0, mint_context: { tracking: "enabled", token_scope: "per_design" }, destination_history: [{ version: 1, target_url: "/listings/LA", destination_type: "listing_detail", kind: "minted", changed_at: "2026-11-01T00:00:00Z", changed_by_user_id: "uA", reason: null }] },
      { id: "q-paused", brokerage_id: "bA", slug: "tok-paused", target_url: "/listings/LA", purpose: "listing", is_active: false, scan_count: 0 },
      { id: "q-retired", brokerage_id: "bA", slug: "tok-retired", target_url: "/listings/LA", purpose: "listing", is_active: false, retired_at: "2026-11-02T00:00:00Z", retired_reason: "retired", scan_count: 0 },
      { id: "q-revoked", brokerage_id: "bA", slug: "tok-revoked", target_url: "/listings/LA", purpose: "listing", is_active: false, retired_at: "2026-11-02T00:00:00Z", retired_reason: "revoked_unsafe", scan_count: 0 },
      { id: "q-quiet", brokerage_id: "bA", slug: "tok-quiet", target_url: "/listings/LA", purpose: "listing", is_active: true, scan_count: 0, mint_context: { tracking: "disabled" } },
      { id: "q-mail", brokerage_id: "bA", slug: "tok-mail", target_url: "/qr/tok-mail", purpose: "campaign", is_active: true, scan_count: 0 },
      { id: "q-legacy", brokerage_id: "bA", slug: "listing-la-lx9old", target_url: "https://app.example.test/listings/LA", purpose: "listing", is_active: true, scan_count: 0 },
    ],
    direct_mail_campaigns: [{ id: "dm-1", brokerage_id: "bA", qr_code_id: "q-mail", lead_id: null, contact_id: null }],
    qr_scan_events: [], contacts: [], leads: [], direct_mail_responses: [], mail_response_tracking: [], lifecycle_events: [],
    tenant_custom_domains: [], brokerage_brand_settings: [], brokerages: [{ id: "bA" }], agent_action_ledger: [],
  }, { uuidIds: true, stampCreatedAt: true, missingColumns: opts.missingColumns, refuse: opts.refuse })

  let current: Mem = seed()
  const emitted: Array<{ event: string; metadata?: Record<string, unknown> }> = []
  // SEAMS — the repo runs as ES modules, so the require-cache shim above cannot reach a TypeScript import. The
  // established pattern (scripts/access-matrix-guard.ts): node:module registerHooks resolves the two specifiers to
  // data: modules that call back into this proof. Active only while this section runs; the live layer below is untouched.
  const seam = { active: true, client: () => current, emit: async (e: { event: string; metadata?: Record<string, unknown> }) => { emitted.push(e); return { inserted: false, lifecycleEventId: null, fanOutOk: true, error: null } } }
  ;(globalThis as Record<string, unknown>).__qrScanDoorSeam = seam
  const STUB: Record<string, string> = {
    "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__qrScanDoorSeam.client()",
    "@/lib/kernel/emit": "export const emitKernelEvent = (e) => globalThis.__qrScanDoorSeam.emit(e)",
  }
  const { registerHooks } = await import("node:module")
  registerHooks({
    resolve(spec: string, ctx: any, next: any) {
      const body = seam.active ? STUB[spec] : undefined
      if (body !== undefined) return { url: `data:text/javascript,${encodeURIComponent(body)}`, shortCircuit: true }
      return next(spec, ctx)
    },
  })

  const { GET } = await import("../app/api/qr/scan/route")
  const { NextRequest } = await import("next/server")
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
  const scan = async (slug: string | null, ua = IPHONE, ip = "203.0.113.7") => {
    const res = await GET(new NextRequest(`https://app.example.test/api/qr/scan${slug === null ? "" : `?slug=${slug}`}`, { headers: { "user-agent": ua, "x-forwarded-for": ip, referer: "https://l.facebook.com/l.php?u=x&h=secret" } }))
    // The live column DEFAULT now() on qr_scan_events.scanned_at (the route never sets it) — modelled here, as the
    // in-memory client models created_at; without it the repeat window could never see the previous scan.
    for (const e of current.tables.qr_scan_events as any[]) if (!e.scanned_at) e.scanned_at = new Date().toISOString()
    return { status: res.status, location: res.headers.get("location"), body: res.status >= 300 && res.status < 400 ? "" : await res.text() }
  }
  const events = (id: string) => current.tables.qr_scan_events.filter((e: any) => e.qr_code_id === id) as any[]
  const code = (id: string) => current.tables.qr_codes.find((r: any) => r.id === id) as any

  const first = await scan("tok-live")
  check("a live code REDIRECTS to its destination with qr=<token> (302, intended action)", first.status === 302 && first.location === "https://app.example.test/listings/LA?qr=tok-live")
  const e1 = events("q-live")[0]
  check("the scan row records only the permitted context: coarse device, referring HOST, traffic class, a hashed visitor key — no IP, no browser string", !!e1 && e1.device_class === "mobile" && e1.referrer === "l.facebook.com" && e1.traffic_class === "human_likely" && /^[0-9a-f]{32}$/.test(e1.visitor_key) && !("ip_address" in e1) && !("user_agent" in e1))
  check("A SCAN CREATES NO CONTACT (and no lead) — contacts and leads untouched", current.tables.contacts.length === 0 && current.tables.leads.length === 0 && !current.writes.some((w) => w.table === "contacts" || w.table === "leads"))
  await scan("tok-live")
  await scan("tok-live", "facebookexternalhit/1.1")
  await scan("tok-live", "curl/8.4.0", "198.51.100.4")
  const classes = events("q-live").map((e) => e.traffic_class).join()
  check("the same phone again is a REPEAT; link previewers / scripts are BOTS — the raw count keeps every hit", classes === "human_likely,repeat,bot,bot" && code("q-live").scan_count === 4)
  check("the routing verdict + traffic class ride the kernel event (a bot is never counted as a visit downstream)", emitted.filter((e) => e.event === "qr_scan_received").map((e) => e.metadata?.traffic_class).join() === "human_likely,repeat,bot,bot")

  const paused = await scan("tok-paused")
  check("a PAUSED code answers 403 with the helpful page (what happened · nothing saved · whom to contact) and records nothing", paused.status === 403 && /This QR code is paused/.test(paused.body) && /Nothing about you was saved/.test(paused.body) && /name="viewport"/.test(paused.body) && events("q-paused").length === 0)
  const retired = await scan("tok-retired")
  const revoked = await scan("tok-revoked")
  check("a RETIRED code answers 410 'retired'; a code TURNED OFF as unsafe answers 410 with the safety notice", retired.status === 410 && /has been retired/.test(retired.body) && revoked.status === 410 && /turned off for your safety/.test(revoked.body) && events("q-retired").length + events("q-revoked").length === 0)
  const missing = await scan("no-such-token")
  const noSlug = await scan(null)
  check("a MISSING code is a helpful 404 page (it used to bounce silently to '/'); no slug is a helpful 400", missing.status === 404 && /We don't recognize this QR code/.test(missing.body) && noSlug.status === 400 && !missing.location)
  const quiet = await scan("tok-quiet")
  check("tracking OFF: the scan still routes and counts, but no per-scan row is written", quiet.status === 302 && events("q-quiet").length === 0 && code("q-quiet").scan_count === 1)
  await scan("tok-mail", "facebookexternalhit/1.1")
  const respAfterBot = current.tables.direct_mail_responses.length
  await scan("tok-mail")
  check("a mail campaign's code: a bot is NOT a mail response; a phone is (direct_mail_responses, campaign-attributed)", respAfterBot === 0 && current.tables.direct_mail_responses.length === 1 && (current.tables.direct_mail_responses[0] as any).campaign_id === "dm-1" && (current.tables.direct_mail_responses[0] as any).response_metadata?.user_agent === undefined)
  const legacy = await scan("listing-la-lx9old")
  check("a code minted BEFORE wave 152 (label-shaped slug, absolute target) still resolves", legacy.status === 302 && legacy.location === "https://app.example.test/listings/LA?qr=listing-la-lx9old")

  const { editQrDestination } = await import("../lib/marketing/qr-governance")
  const edit = await editQrDestination({ qrCodeId: "q-live", targetUrl: "/open-house/E1/signin", reason: "open house Saturday" }, { brokerageId: "bA", userId: "uA", agentId: null, userType: "agent" }, { client: current, ledgerClient: current, origin: "https://app.example.test", appOrigins: ["https://app.example.test"] })
  const after = await scan("tok-live", IPHONE, "192.0.2.10")
  check("THE OLD PRINTED CODE FOLLOWS AN ALLOWED EDIT: same token, next scan lands on the new destination; v1 kept", edit.ok && after.status === 302 && after.location === "https://app.example.test/open-house/E1/signin?qr=tok-live" && code("q-live").destination_history.length === 2 && code("q-live").destination_history[0].target_url === "/listings/LA")

  current = seed({ missingColumns: { qr_codes: ["retired_at", "retired_reason", "mint_context"], qr_scan_events: ["visitor_key", "traffic_class", "device_class"] } })
  const pre = await scan("tok-live")
  check("BEFORE m945 / m946 are applied: the scan still resolves and is still recorded (earlier row shape, still no raw IP)", pre.status === 302 && events("q-live").length === 1 && !("ip_address" in events("q-live")[0]) && events("q-live")[0].referrer === "l.facebook.com")
  current = seed({ refuse: { qr_codes: "permission denied for table qr_codes" } })
  const broken = await scan("tok-live")
  check("a refused lookup is a helpful 503 page — never a raw 500, never a stack trace or a table name", broken.status === 503 && /We couldn't open this QR code right now/.test(broken.body) && !/permission denied|qr_codes|stack/i.test(broken.body))
  seam.active = false
}

main().catch((e) => { console.error(e); process.exit(1) })
