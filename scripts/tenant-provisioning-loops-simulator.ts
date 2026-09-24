#!/usr/bin/env tsx
/**
 * scripts/tenant-provisioning-loops-simulator.ts   (npm run test:tenant-provisioning-loops)
 * ─────────────────────────────────────────────────────────────────────────────
 * PRODUCTION AUDIT OF THE FOUR AUTONOMOUS PROVISIONING LOOPS (wave 81, lane
 * 81D — owner verbatim: "when a tenant is created, we also coded an automatic
 * website is created … automatic video landing pages for when a new video is
 * created, property listing page, etc. automatic registering business after
 * phone number purchase/port over so can use the phone/test feature. just make
 * sure the whole platform is properly coded and working for production.").
 *
 * ALREADY TRUE vs BUILT (the audit table this proof pins):
 *   1. TENANT → WEBSITE      already true: createTenantCore slugs the brokerage
 *                            and app/site/[slug] serves the storefront from live
 *                            tables (brand cascade off brokerages).
 *                            BUILT: resolveUniqueTenantSlug (collision → re-suffix,
 *                            refused read → creation FAILS loudly) + websitePath
 *                            on the result + the welcome bell names the site.
 *   2. NEW VIDEO → LANDING   already true: /api/cron/geo-reel-autopublish (30
 *                            min) publishes finished+compliant+approved reels
 *                            through publishVideoProjectLanding.
 *                            BUILT: approveContentItem publishes inline at the
 *                            approval moment; publishing MINTS the page's
 *                            registered QR; /v/[slug] shows the QR + lead CTA.
 *   3. LISTING → PROPERTY    FOUND: /listing/[slug] resolves listings.slug and
 *                            NO production writer existed (demo seed only).
 *                            BUILT: lib/listings/listing-slug.ts (pure + idempotent
 *                            + counted) on intake, on launch, and as a sweep.
 *   4. PHONE → REGISTRATION  already true: the A2P 10DLC step machine + the
 *                            settings card. FOUND: only a human button ran it;
 *                            no toll-free lane; no test feature; nothing gated.
 *                            BUILT: kickCarrierRegistration after purchase / port,
 *                            runTollfreeVerification, assessPhoneTestReadiness,
 *                            placePhoneTestCallAction + the card, fail-closed.
 *
 * No network, no DB, no Twilio: pure functions + stub clients + stripped source.
 * Run: npx tsx --conditions=react-server scripts/tenant-provisioning-loops-simulator.ts
 */
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { buildTenantSlug, resolveUniqueTenantSlug, tenantWebsitePath } from "../lib/kernel/tenant-creation"
import { buildListingSlug, ensureListingSlug, ensureMissingListingSlugs, LISTING_SLUG_MAX } from "../lib/listings/listing-slug"
import { isTollFreeNumber, assessPhoneTestReadiness, kickCarrierRegistration, describeTollfreeState, type A2pState } from "../lib/voice/a2p-registration"
import { isAutoPublishEligible } from "../lib/geo/video-landing"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(root, p), "utf8")
const stripped = (p: string) => stripComments(src(p))

delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN
process.env.NEXT_PUBLIC_APP_URL = "https://os.example.test"

// ── A generic stub client: per-table rows for reads, recorded writes ─────────
function fakeSvc(tables: Record<string, any[]> = {}, opts: { refuse?: Record<string, string>; updateMatches?: (table: string, patch: any, eqs: Array<[string, unknown]>) => any[] } = {}) {
  const inserts: Array<{ table: string; row: any }> = []
  const updates: Array<{ table: string; patch: any; eqs: Array<[string, unknown]>; is: Array<[string, unknown]> }> = []
  const chain = (table: string) => {
    const eqs: Array<[string, unknown]> = []; const isP: Array<[string, unknown]> = []
    const q: any = { _op: "select" }
    for (const m of ["select", "order", "limit", "not", "neq", "in", "gte", "or"]) q[m] = () => q
    q.eq = (k: string, v: unknown) => { eqs.push([k, v]); return q }
    q.is = (k: string, v: unknown) => { isP.push([k, v]); return q }
    q.insert = (row: any) => { q._op = "insert"; inserts.push({ table, row }); return q }
    q.update = (patch: any) => { q._op = "update"; q._patch = patch; return q }
    const rows = () => (tables[table] ?? []).filter((r) => eqs.every(([k, v]) => r[k] === v) && isP.every(([k, v]) => (v === null ? r[k] == null : r[k] === v)))
    const result = () => {
      if (opts.refuse?.[table]) return { data: null, error: { message: opts.refuse[table] } }
      if (q._op === "insert") return { data: { id: "new-row" }, error: null }
      if (q._op === "update") { updates.push({ table, patch: q._patch, eqs, is: isP }); const m = opts.updateMatches ? opts.updateMatches(table, q._patch, eqs) : rows(); m.forEach((r) => Object.assign(r, q._patch)); return { data: m.map((r) => ({ id: r.id })), error: null } }
      return { data: rows(), error: null }
    }
    q.maybeSingle = async () => { const r = result(); return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error } }
    q.single = q.maybeSingle
    q.then = (res: any, rej: any) => Promise.resolve(result()).then(res, rej)
    return q
  }
  return { inserts, updates, from: (t: string) => chain(t) } as any
}

async function main() {
  console.log("\n[1 · tenant → website]")
  check("buildTenantSlug: kebab + suffix, deterministic with a given suffix, never empty", buildTenantSlug("Kling & Co. Realty", "ab12") === "kling-co-realty-ab12" && buildTenantSlug("!!!", "zz").startsWith("brokerage-"))
  check("tenantWebsitePath is the ONE spelling of the storefront path", tenantWebsitePath("acme-1a2b") === "/site/acme-1a2b")
  {
    const svc = fakeSvc({ brokerages: [{ id: "b-old", slug: "acme-realty-aaaa" }] })
    const r = await resolveUniqueTenantSlug(svc, "Acme Realty", { suffixes: ["aaaa", "bbbb"] })
    check("a slug collision re-suffixes (the second candidate is taken) and reports the retry", r.ok && r.slug === "acme-realty-bbbb" && r.retried === 1)
    const fresh = await resolveUniqueTenantSlug(fakeSvc(), "Acme Realty", { suffixes: ["cccc"] })
    check("a free slug is taken first try", fresh.ok && fresh.slug === "acme-realty-cccc" && fresh.retried === 0)
    const refused = await resolveUniqueTenantSlug(fakeSvc({}, { refuse: { brokerages: "permission denied" } }), "Acme Realty")
    check("a REFUSED slug read fails the creation loudly (never 'probably unique')", !refused.ok && /NOT created/.test(refused.error) && /permission denied/.test(refused.error))
    const stuck = await resolveUniqueTenantSlug(fakeSvc({ brokerages: [{ id: "x", slug: "acme-realty-same" }] }), "Acme Realty", { attempts: 3, suffixes: ["same", "same", "same"] })
    check("CONTROL: a slug that always collides is refused after the bounded attempts", !stuck.ok && /after 3 attempts/.test(stuck.error))
  }
  const tc = stripped("lib/kernel/tenant-creation.ts")
  check("createTenantCore resolves the unique slug BEFORE the brokerages insert and returns websitePath", tc.indexOf("await resolveUniqueTenantSlug(service, brokerageName)") < tc.indexOf('.from("brokerages")\n    .insert(') && /websitePath: tenantWebsitePath\(slug\)/.test(tc) && /if \(!slugRes\.ok\) return \{ ok: false, error: slugRes\.error/.test(tc))
  const site = stripped("app/site/[slug]/page.tsx")
  check("app/site/[slug] serves the storefront by brokerages.slug with the brand cascade (logo, colour, about) and the listings/agents/blog blocks", /\.eq\("slug", slug\)/.test(site) && /logo_url/.test(site) && /primary_color/.test(site) && /from\("listings"\)/.test(site) && /from\("agents"\)/.test(site) && /from\("blog_posts"\)/.test(site))
  check("the welcome bell names the storefront path", /Your website is already up at \$\{tenantWebsitePath\(slug\)\}/.test(tc))

  console.log("\n[2 · new video → landing page (+ registered QR + lead capture)]")
  check("the auto-publish sweep is a registered cron (/api/cron/geo-reel-autopublish)", CRON_REGISTRY.some((c: { path: string }) => c.path === "/api/cron/geo-reel-autopublish"))
  check("the sweep publishes through publishVideoProjectLanding", /publishVideoProjectLanding\(\{ projectId: reel\.id, brokerageId: reel\.brokerage_id \}\)/.test(stripped("app/api/cron/geo-reel-autopublish/route.ts")))
  check("the gate: only finished + compliance-passed + approved + artifact reels publish (pending is refused)", isAutoPublishEligible({ status: "completed", complianceStatus: "passed", approvalStatus: "approved", videoUrl: "https://x/v.mp4", isPublished: false }) && !isAutoPublishEligible({ status: "completed", complianceStatus: "passed", approvalStatus: "pending_review", videoUrl: "https://x/v.mp4", isPublished: false }))
  const cs = stripped("lib/kernel/content-studio.ts")
  check("approveContentItem publishes the landing page INLINE after the approval update (the cron stays the net)", cs.indexOf('.update({ approval_status: "approved"') < cs.indexOf("publishVideoProjectLanding({ projectId: videoProjectId, brokerageId })") && /if \(!updated\) return \{ ok: false/.test(cs))
  const pvl = stripped("lib/geo/publish-video-landing.ts")
  check("publishing MINTS the page's QR through the ONE minter on both rails (label video_landing:<rail>:<id>, destination landing_page, target /v/<slug>)", /mintTrackedQr\(\{[\s\S]{0,300}label: videoLandingQrLabel\(args\.rail, args\.id\)[\s\S]{0,120}destinationType: "landing_page"[\s\S]{0,120}\/v\/\$\{args\.slug\}/.test(pvl) && (pvl.match(/await mintVideoLandingQr\(/g) ?? []).length === 2)
  {
    const { videoLandingQrLabel, mintVideoLandingQr } = await import("../lib/geo/publish-video-landing")
    check("videoLandingQrLabel is deterministic per rail + id", videoLandingQrLabel("project", "p1") === "video_landing:project:p1" && videoLandingQrLabel("render", "r1") === "video_landing:render:r1")
    const c = fakeSvc({ qr_codes: [] })
    const inserted: any[] = []
    const client: any = { from: (t: string) => { const q = c.from(t); const ins = q.insert; q.insert = (row: any) => { inserted.push(row); q._op = "insert"; const q2: any = { select: () => q2, maybeSingle: async () => ({ data: { id: "qr-1", slug: "vl-slug" }, error: null }) }; return q2 }; void ins; return q } }
    const m = await mintVideoLandingQr({ rail: "project", id: "p1", brokerageId: "b1", slug: "tour-p1", listingId: "L1" }, client)
    check("mintVideoLandingQr registers a tenant-owned code pointing at the page (stub client)", !!m && inserted[0]?.brokerage_id === "b1" && inserted[0]?.label === "video_landing:project:p1" && inserted[0]?.target_url === "https://os.example.test/v/tour-p1" && inserted[0]?.destination_type === "landing_page" && inserted[0]?.listing_id === "L1")
  }
  const vpage = stripped("app/v/[slug]/page.tsx")
  check("/v/[slug] reads the REGISTERED code back (never mints on a page view), renders its PNG from the tracked scan link, and offers a lead CTA (listing page or storefront) + a tel link", /from\("qr_codes"\)[\s\S]{0,200}videoLandingQrLabel\(rail, data\.render\.id\)/.test(vpage) && !/mintTrackedQr|mintVideoLandingQr\(/.test(vpage) && /renderQrPng\(`\$\{normalizeOrigin\(\)\}\/api\/qr\/scan\?slug=/.test(vpage) && /\/listing\/\$\{listingSlug\}/.test(vpage) && /\/site\/\$\{brokerage\.slug\}/.test(vpage) && /href=\{`tel:/.test(vpage))

  console.log("\n[3 · listing → property page]")
  const id = "9f1c2b3a-4d5e-4f60-8a71-b2c3d4e5f607"
  check("buildListingSlug: kebab of address+city+state, id-tailed, deterministic, capped", buildListingSlug("123 Main St.", "Austin", "TX", id) === "123-main-st-austin-tx-9f1c2b3a" && buildListingSlug("123 Main St.", "Austin", "TX", id) === buildListingSlug("123 Main St.", "Austin", "TX", id) && buildListingSlug("x".repeat(200), "y", "z", id).length <= LISTING_SLUG_MAX && buildListingSlug(null, null, null, id) === "home-9f1c2b3a")
  check("CONTROL: two listings at the same address get DIFFERENT slugs (the id tail)", buildListingSlug("1 Elm", "A", "TX", id) !== buildListingSlug("1 Elm", "A", "TX", "aaaaaaaa-0000-4000-8000-000000000000"))
  {
    const svc = fakeSvc({ listings: [{ id, brokerage_id: "b1", slug: null, address: "123 Main St", city: "Austin", state: "TX" }] })
    const r = await ensureListingSlug(svc, { listingId: id, brokerageId: "b1" })
    const u = svc.updates[0]
    check("a listing without a slug gets one — the update is tenant-predicated, fenced on slug IS NULL, and COUNTED (1 row)", r.ok && r.created && r.slug === "123-main-st-austin-tx-9f1c2b3a" && !!u && u.eqs.some(([k, v]: [string, unknown]) => k === "brokerage_id" && v === "b1") && u.is.some(([k, v]: [string, unknown]) => k === "slug" && v === null))
    const again = await ensureListingSlug(svc, { listingId: id, brokerageId: "b1" })
    check("idempotent: an existing slug is KEPT (no second update — printed QR links never move)", r.ok && again.ok && !again.created && again.slug === r.slug && svc.updates.length === 1)
    const other = await ensureListingSlug(svc, { listingId: id, brokerageId: "b2" })
    check("another tenant's id is 'not found' (the read is predicated on the session's brokerage)", !other.ok && /not found in this brokerage/.test(other.reason))
    const refused = await ensureListingSlug(fakeSvc({}, { refuse: { listings: "permission denied" } }), { listingId: id, brokerageId: "b1" })
    check("a refused read is reported, never 'no listing'", !refused.ok && /read refused: permission denied/.test(refused.reason))
    const raced = fakeSvc({ listings: [{ id, brokerage_id: "b1", slug: null, address: "1 Elm", city: "A", state: "TX" }] }, { updateMatches: () => [] })
    const rr = await ensureListingSlug(raced, { listingId: id, brokerageId: "b1" })
    check("an update that matches 0 rows and leaves no slug is a REFUSAL (a phantom success is never reported)", !rr.ok && /matched 0 rows/.test(rr.reason))
    const sweep = await ensureMissingListingSlugs(fakeSvc({ listings: [{ id, brokerage_id: "b1", slug: null, address: "1 Elm", city: "A", state: "TX", status: "active" }, { id: "no-brk", brokerage_id: null, slug: null, status: "active" }] }), 10)
    check("the sweep gives every slug-less listing a page and names the ones it could not", sweep.scanned === 2 && sweep.created === 1 && sweep.errors.length === 1 && /no-brk: no brokerage/.test(sweep.errors[0]))
  }
  const lk = stripped("app/actions/listings-kernel.ts")
  check("intake AND launch call ensureListingSlug with the session's brokerage", (lk.match(/ensureListingSlug\((createServiceClient\(\)|svc), \{ listingId: (newListingId|params\.listingId), brokerageId: ctx\.brokerageId \}\)/g) ?? []).length === 2)
  check("the geo tick runs the listing-page sweep and reports it", /ensureMissingListingSlugs\(svc, 100\)/.test(stripped("app/api/cron/geo-reel-autopublish/route.ts")))
  check("app/listing/[slug] resolves the page by listings.slug (getListingBySlug)", /getListingBySlug\(slug\)/.test(stripped("app/listing/[slug]/page.tsx")) && /\.eq\("slug", slug\)/.test(stripped("app/actions/listing-landing.ts")))

  console.log("\n[4 · phone purchase/port → business registration → test feature]")
  check("isTollFreeNumber: 8xx is toll-free (E.164 or 11 digits), a local number is not, garbage is not", isTollFreeNumber("+18005551212") && isTollFreeNumber("18885551212") && isTollFreeNumber("+18335551212") && !isTollFreeNumber("+15125551212") && !isTollFreeNumber("") && !isTollFreeNumber("800555"))
  const approved: A2pState = { customer_profile_sid: "BU1", trust_product_sid: "BU2", brand_sid: "BN1", brand_status: "APPROVED", messaging_service_sid: "MG1", number_attached: true, campaign_sid: "QE1", campaign_status: "VERIFIED" }
  const pending: A2pState = { ...approved, campaign_status: "PENDING" }
  check("readiness: no numbers → not ready with the reason", !assessPhoneTestReadiness(approved, []).ready)
  check("readiness: a local number needs the 10DLC campaign approved (pending → refused, names 10dlc)", !assessPhoneTestReadiness(pending, [{ phone_number: "+15125551212" }]).ready && /10dlc/.test(assessPhoneTestReadiness(pending, [{ phone_number: "+15125551212" }]).reason ?? "") && assessPhoneTestReadiness(approved, [{ phone_number: "+15125551212" }]).ready)
  check("readiness: a toll-free number needs TWILIO_APPROVED verification; an approved campaign alone is not enough", !assessPhoneTestReadiness(approved, [{ phone_number: "+18005551212" }]).ready && assessPhoneTestReadiness({ ...approved, tollfree_verification_sid: "HH1", tollfree_status: "TWILIO_APPROVED" }, [{ phone_number: "+18005551212" }]).ready)
  check("readiness: both kinds present → BOTH lanes must be registered", (() => { const r = assessPhoneTestReadiness({ ...approved, tollfree_status: "IN_REVIEW", tollfree_verification_sid: "HH1" }, [{ phone_number: "+15125551212" }, { phone_number: "+18005551212" }]); return !r.ready && r.lanes.length === 2 && r.lanes[0].registered && !r.lanes[1].registered })())
  check("describeTollfreeState is honest about not-submitted / under review / approved / rejected", /not yet submitted/.test(describeTollfreeState({})) && /under carrier review/.test(describeTollfreeState({ tollfree_verification_sid: "HH1", tollfree_status: "IN_REVIEW" })) && /verified/.test(describeTollfreeState({ tollfree_verification_sid: "HH1", tollfree_status: "TWILIO_APPROVED" })) && /REJECTED/.test(describeTollfreeState({ tollfree_verification_sid: "HH1", tollfree_status: "TWILIO_REJECTED" })))
  {
    const svc = fakeSvc({ brokerage_settings: [{ brokerage_id: "b1", settings: { a2p_business_profile: { legalName: "Acme" } } }] })
    const r = await kickCarrierRegistration(svc, { brokerageId: "b1", phoneNumber: "+15125551212", trigger: "purchased" })
    const audit = svc.inserts.find((i: any) => i.table === "phone_number_events")
    check("kickoff with an INCOMPLETE profile: not kicked, names the missing fields, audited on phone_number_events with a CHECK'd event_type", !r.kicked && r.lane === "10dlc" && r.reason === "profile_incomplete" && /missing: EIN/.test(r.statusLine) && !!audit && audit.row.source === "a2p_auto_kickoff" && CHECK_VOCABULARIES.phone_number_events.event_type.includes(audit.row.event_type) && /after purchased/.test(audit.row.notes))
  }
  {
    const profile = { legalName: "Acme Realty LLC", ein: "123456789", website: "https://acme.example", street: "1 Main", city: "Austin", region: "TX", postalCode: "78701", contactFirstName: "A", contactLastName: "B", contactEmail: "a@acme.example", contactPhone: "+15125550100", privacyPolicyUrl: "https://acme.example/privacy", termsUrl: "https://acme.example/terms" }
    const svc = fakeSvc({ brokerage_settings: [{ brokerage_id: "b1", settings: { a2p_business_profile: profile } }], platform_credentials: [], brokerages: [{ id: "b1" }] })
    const r = await kickCarrierRegistration(svc, { brokerageId: "b1", phoneNumber: "+15125551212", trigger: "ported_in" })
    check("kickoff with a complete profile runs the 10DLC machine and is HONEST when the carrier is not configured (nothing marked registered)", !r.kicked && r.lane === "10dlc" && /Twilio master account not configured/.test(r.reason ?? "") && svc.inserts.some((i: any) => i.table === "platform_credentials") && /In progress|not configured/.test(r.statusLine))
    const tf = await kickCarrierRegistration(svc, { brokerageId: "b1", phoneNumber: "+18885551212", trigger: "purchased" })
    check("a toll-free number takes the toll-free lane (verification, not 10DLC) and is equally honest without creds", tf.lane === "tollfree" && !tf.kicked && /not configured/.test(tf.reason ?? ""))
  }
  const np = stripped("lib/voice/number-provisioning.ts")
  check("provisionNumber kicks carrier registration AFTER the purchase + bind and returns the outcome (never blocks the purchase)", np.indexOf("bindNumberToTwilioLane(svc, numberRowId)") < np.indexOf('kickCarrierRegistration(svc, { brokerageId: params.brokerageId, phoneNumber: targetNumber, trigger: "purchased" })') && /registration \}/.test(np))
  const pp = stripped("app/actions/phone-provisioning.ts")
  check("manuallyAddAgentPhone (port-in / BYO) kicks it too, after the audit line, and reports registrationNote", pp.indexOf('eventType: params.source === "ported_in" ? "ported_in" : "manually_added"') < pp.indexOf("kickCarrierRegistration(svc, { brokerageId: ctx.brokerageId, phoneNumber: cleaned") && /registrationNote/.test(pp))
  const a2p = stripped("lib/voice/a2p-registration.ts")
  check("runTollfreeVerification files against /v1/Tollfree/Verifications with the number's SID, Privacy + Terms URLs and the EIN, polls by its OWN sid, and never marks approved itself", /"\/v1\/Tollfree\/Verifications", "POST"/.test(a2p) && /TollfreePhoneNumberSid: tollFree\.twilio_number_sid/.test(a2p) && /PrivacyPolicyUrl: profile\.privacyPolicyUrl/.test(a2p) && /BusinessRegistrationNumber: profile\.ein/.test(a2p) && /`\/v1\/Tollfree\/Verifications\/\$\{state\.tollfree_verification_sid\}`, "GET"/.test(a2p) && !/tollfree_status = "TWILIO_APPROVED"/.test(a2p))
  const ptc = stripped("app/actions/phone-test-call.ts")
  const dial = ptc.slice(ptc.indexOf("export async function placePhoneTestCallAction"))
  check("the test-call action is 'use server' with async exports only, gates BEFORE the service client, and FAILS CLOSED on readiness before any dial", /^"use server"/.test(src("app/actions/phone-test-call.ts")) && !/^export (?!async function)/m.test(ptc) && dial.indexOf('requireBrokerCtx("write")') < dial.indexOf("createServiceClient()") && dial.indexOf("if (!readiness.ready) return { ok: false, error: `REFUSED:") < dial.indexOf("placeOutboundAiCall(svc, {"))
  check("a refused phone-number read is a refusal of the test (never 'no numbers')", /the test is refused until the read succeeds/.test(ptc))
  const psc = stripped("app/dashboard/admin/phone-settings/phone-settings-client.tsx")
  check("the phone settings page mounts the test card beside the registration card", /<A2pRegistrationCard \/>[\s\S]{0,200}<PhoneTestCard \/>/.test(psc) && existsSync(join(root, "app/dashboard/admin/phone-settings/phone-test-card.tsx")))

  console.log("\n[5 · registration]")
  const pkg = JSON.parse(src("package.json"))
  check("package.json registers test:tenant-provisioning-loops after test:scrapers (ordering)", typeof pkg.scripts["test:tenant-provisioning-loops"] === "string" && pkg.scripts.guard.indexOf("npm run test:scrapers") < pkg.scripts.guard.indexOf("npm run test:tenant-provisioning-loops"))
  const dom = (MAINTENANCE_DOMAINS as any).tenant_provisioning_loops
  check("MAINTENANCE_DOMAINS.tenant_provisioning_loops names a manager, this proof, and coOwners", !!dom && dom.proof === "test:tenant-provisioning-loops" && Array.isArray(dom.coOwners) && dom.coOwners.length >= 2)

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(" blind spots: no Twilio call is made (the 10DLC/toll-free runners are exercised up to the honest 'not configured' refusal on stubs; a real filing is a smoke run with master + subaccount creds); the test call's outbound gate stack (suppression/TCPA/budget) is asserted by call order in source, not exercised; the storefront and /v pages are proved by stripped source, not rendered; the listing sweep runs on a stub client.")
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ TENANT_PROVISIONING_LOOPS_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
