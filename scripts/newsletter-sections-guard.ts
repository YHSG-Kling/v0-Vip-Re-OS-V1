/**
 * scripts/newsletter-sections-guard.ts — `npm run test:newsletter-sections`
 *
 * WAVE 155 (lane 155G2 — directive G3 / G4, owner R5 / R6 / R8; acceptance rows "Newsletter" and "QR"; eval BIAS-003).
 * Every proof is SIMULATED: the in-memory supabase client (scripts/in-memory-supabase.ts), the REAL planner
 * (lib/kernel/newsletter/section-planner.ts), the REAL scheduled sender (GET of app/api/cron/publish-newsletters/route.ts),
 * the REAL minter (lib/marketing/tracked-qr.ts resolveArtifactQrSlot) and the REAL scan handler
 * (app/api/qr/scan/route.ts). The email provider, the compliance gate, the de-conflict gate and the kernel event bus are
 * injected seams that COUNT their calls — nothing is sent, nothing leaves the process, no model is called.
 *
 * RED AT d2d6468c (the base): lib/kernel/newsletter/section-planner.ts does not exist (§1–§4 cannot load); the scheduled
 * sender mails a campaign whose planned listing has SOLD or whose event was CANCELED (no provenance gate: send seam > 0),
 * and it puts the creator's raw JSON section list at the top of every email (§4 "no JSON intro"); the email carries no QR
 * link (§4); ListingFlyer has no date / status-detail line (§6). Measured: see $S/lane155G2-notes.md "Proofs".
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const stripped = (p: string) => stripComments(readFileSync(join(root, p), "utf8"))

// ─── SEAMS (registered before any product import) ────────────────────────────
const ORIGIN = "https://app.example.test"
process.env.NEXT_PUBLIC_APP_URL = ORIGIN
process.env.NEWSLETTER_FROM_DOMAIN = "mail.example.test"
process.env.SECRETS_ENCRYPTION_KEY = (await import("node:crypto")).randomBytes(32).toString("hex")
type Seam = {
  client: () => unknown
  dispatched: Array<Record<string, any>>
  gate: (a: { content: string }) => Promise<{ allowed: boolean; violations: string[] }>
  events: Array<Record<string, unknown>>
  emit: (e: Record<string, unknown>) => Promise<unknown>
  frame: number; config: { width: number; height: number; fps: number; durationInFrames: number }
}
const seam: Seam = {
  client: () => { throw new Error("no client seeded") },
  dispatched: [],
  gate: async () => ({ allowed: true, violations: [] }),
  events: [],
  emit: async () => ({ inserted: false, lifecycleEventId: null, fanOutOk: true, error: null }),
  frame: 0, config: { width: 2625, height: 3375, fps: 30, durationInFrames: 1 },
}
const g = globalThis as Record<string, unknown>
g.__nlSeam = seam
g.__nlReact = (await import("react")).default
const S = "globalThis.__nlSeam"
const STUB: Record<string, string> = {
  "server-only": "export {}",
  "@/lib/supabase/service": `export const createServiceClient = () => ${S}.client()`,
  "@/lib/providers/dispatch": `export const dispatchEmail = async (a) => { ${S}.dispatched.push(a); return { success: true, messageId: "m-" + ${S}.dispatched.length } }`,
  "@/lib/kernel/deconflict": "export const evaluateBroadcastDeconflict = async () => ({ allowed: true })",
  "@/lib/kernel/tenant-config-reads": `export const evaluateTenantOutbound = (a) => ${S}.gate(a)`,
  "@/lib/kernel/events": "export const KernelEvent = new Proxy({}, { get: (_, k) => String(k) })",
  "@/lib/kernel/notification-engine": `export const processKernelEvent = async (e) => { ${S}.events.push(e); return {} }`,
  "@/lib/kernel/composition-gate": "export const ASSET_READINESS_CONFIGS = { newsletter_video: {} }; export const checkAssetReadiness = async () => ({ kind: 'not_staged', reason: 'stub' })",
  "@/lib/kernel/write-sentinel": "export const sentinelWrite = async (_svc, p) => await p",
  "@/lib/cron-auth": "export const verifyCronAuth = () => null",
  "@/lib/notifications/buyer-preferences": "export const resolveBuyerNotificationPreferences = () => ({}); export const buyerWantsNotification = () => true",
  "@/lib/marketing/engagement-rollup": "export const rollupNewsletterCampaignRates = async () => ({ refusals: [] })",
  "@/lib/marketing/humanize-final": "export const recordDoorPublication = async () => ({ ok: true })",
  "@/lib/kernel/manager-signals": "export const publishManagerSignal = async () => ({})",
  "@/lib/kernel/emit": `export const emitKernelEvent = (e) => ${S}.emit(e)`,
  "@/lib/supabase/server": "export const createClient = async () => { throw new Error('no cookie session in a proof') }",
}
const REMOTION_STUB = `
const R = () => globalThis.__nlReact
export const useCurrentFrame = () => ${S}.frame
export const useVideoConfig = () => ${S}.config
export const AbsoluteFill = (p) => R().createElement("div", { style: p.style }, p.children)
export const Img = (p) => R().createElement("img", { src: p.src, style: p.style, alt: p.alt })
export const staticFile = (s) => s
export const delayRender = () => 0
export const continueRender = () => {}
`
registerHooks({
  resolve(spec: string, ctx: { parentURL?: string }, next: (s: string, c: unknown) => unknown) {
    if (STUB[spec] !== undefined) return { url: `data:text/javascript,${encodeURIComponent(STUB[spec])}`, shortCircuit: true }
    if (spec === "remotion" && ctx.parentURL && !ctx.parentURL.includes("/node_modules/")) return { url: `data:text/javascript,${encodeURIComponent(REMOTION_STUB)}`, shortCircuit: true }
    return next(spec, ctx)
  },
} as never)

const { memSupabase } = await import("./in-memory-supabase")
const P = await import("../lib/kernel/newsletter/section-planner")
const { resolveArtifactQrSlot } = await import("../lib/marketing/tracked-qr")
type Mem = ReturnType<typeof memSupabase>

const NOW = new Date()
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString().slice(0, 10)

function seedDb(): Mem {
  return memSupabase({
    brokerages: [{ id: "bA", website: null }, { id: "bB", website: null }],
    users: [{ id: "uA", brokerage_id: "bA", first_name: "Ann" }, { id: "uB", brokerage_id: "bB" }],
    agents: [{ id: "agA", user_id: "uA", brokerage_id: "bA", public_slug: "ann-alder", team_id: null, location_id: null }, { id: "agA2", user_id: "uA2", brokerage_id: "bA", public_slug: null }, { id: "agB", user_id: "uB", brokerage_id: "bB", public_slug: "bee" }],
    teams: [], locations: [], marketing_campaigns: [], tenant_custom_domains: [], brokerage_brand_settings: [], leads: [],
    contacts: [{ id: "ctA", brokerage_id: "bA" }, { id: "ctA2", brokerage_id: "bA" }],
    market_data: [
      { id: "mdStale", brokerage_id: "bA", market_area: "Naples", city: "Naples", state: "FL", data_date: day(-100), source_type: "rentcast", median_sale_price: 600000, sold_listings_30d: 40, active_listings: 300, new_listings_30d: 50, avg_days_on_market: 30, months_of_inventory: 4, price_trend_pct_1yr: 2 },
      { id: "mdZero", brokerage_id: "bA", market_area: "Bonita", city: "Bonita Springs", state: "FL", data_date: day(-2), source_type: "cma_aggregate", median_sale_price: 0, sold_listings_30d: 0, active_listings: null, new_listings_30d: 0, avg_days_on_market: 0, months_of_inventory: 0, price_trend_pct_1yr: 0 },
      { id: "mdA", brokerage_id: "bA", market_area: "Naples", city: "Naples", state: "FL", data_date: day(-3), source_type: "rentcast", median_sale_price: 615000, sold_listings_30d: 42, active_listings: 0, new_listings_30d: 0, avg_days_on_market: 0, months_of_inventory: 0, price_trend_pct_1yr: 0 },
      { id: "mdB", brokerage_id: "bB", market_area: "Naples", city: "Naples", state: "FL", data_date: day(-1), source_type: "rentcast", median_sale_price: 999999, sold_listings_30d: 99, active_listings: 99 },
    ],
    listings: [
      { id: "LA", brokerage_id: "bA", agent_id: "agA", address: "12 Palm Ct", city: "Naples", state: "FL", list_price: 725000, bedrooms: 3, bathrooms: 2, sqft: 1900, status: "active", deleted_at: null, primary_photo_url: "https://cdn.example.test/la.jpg", photos: [], updated_at: day(-1) },
      { id: "Lsold", brokerage_id: "bA", agent_id: "agA", address: "9 Sold Way", city: "Naples", state: "FL", list_price: 900000, status: "sold", deleted_at: null, updated_at: day(0) },
      { id: "Lother", brokerage_id: "bA", agent_id: "agA2", address: "1 Other Agent Rd", city: "Naples", state: "FL", list_price: 500000, status: "active", deleted_at: null, updated_at: day(0) },
      { id: "LB", brokerage_id: "bB", agent_id: "agA", address: "7 Other Tenant Ln", city: "Naples", state: "FL", list_price: 400000, status: "active", deleted_at: null, updated_at: day(0) },
    ],
    content_topic_bank: [
      { id: "tEvent", brokerage_id: "bA", status: "fresh", topic_title: "Naples Farmers Market reopens", raw_data: { local_fact: { kind: "local_event", event_start: day(5) }, local_event: { status: "scheduled", source_event_key: "fm-1", start_date: day(5) } } },
      { id: "tGuide", brokerage_id: null, status: "fresh", topic_title: "How a home inspection works", raw_data: {} },
    ],
    newsletter_campaigns: [], newsletter_sections: [], newsletter_subscribers: [], newsletter_sends: [], newsletter_scheduled_sends: [], newsletter_seo_scores: [],
    asset_persona_renders: [], ai_generated_content: [],
    qr_codes: [], qr_scan_events: [], agent_action_ledger: [], lifecycle_events: [], marketing_asset_qr_links: [],
  }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]], qr_codes: [["slug"]] } })
}

const eventFact = { topicId: "tEvent", kind: "local_event", title: "Naples Farmers Market reopens", url: "https://naples.example.gov/market", publisher: "City of Naples", eventStart: day(5), eventEnd: null, venue: "Cambier Park", city: "Naples", state: "FL", confidence: 0.8, temporal: "upcoming" }
const expiredFact = { ...eventFact, topicId: "tOld", title: "Last month's art walk", eventStart: day(-20), temporal: "expired" }
const guideTopic = { id: "tGuide", topic_title: "How a home inspection works", value_angle: "what buyers can ask for", source_url: "https://www.example.org/inspection", categories: ["buyer_advice"], is_brokerage_local: false }

// ── 1 · the selector (pure) ─────────────────────────────────────────────────
console.log("\n[1 · the section selector chooses from what is REAL — 2 to 5 sections, nothing filled]")
{
  const db = seedDb()
  const full = await P.gatherSectionCandidates(db as never, { brokerageId: "bA", agentId: "agA", now: NOW, localFacts: [eventFact, expiredFact], topics: [guideTopic], audienceCities: ["Naples"] })
  const plan = P.selectNewsletterSections(full.candidates, { now: NOW })
  const mods = plan.selected.map((s) => s.module)
  check("verified market item + upcoming event + live listing + community resource are ALL selected, plus one next action (5)", mods.length === 5 && ["market_education", "local_event", "active_listing", "community_value", "next_action"].every((m) => mods.includes(m as never)), mods.join(","))
  const listing = plan.selected.find((s) => s.module === "active_listing")
  check("the listing is the author's OWN ACTIVE listing — never the sold one, another agent's, or another tenant's", listing?.provenance?.kind === "listing" && listing.provenance.listingId === "LA", JSON.stringify(listing?.provenance))
  const market = plan.selected.find((s) => s.module === "market_education")
  check("the market item is THIS tenant's freshest row with ≥2 MEASURED figures (not the 100-day-old row, not the all-zero row, not tenant B's)", market?.provenance?.kind === "market_data" && market.provenance.id === "mdA")
  check("an unmeasured figure (0 = unknown) is never stated: 'Active listings' / 'Days on market' are absent from mdA's facts", !!market && !market.facts.some((f) => /Active listings|days on market|Months of inventory|12 months/i.test(f)) && market.facts.some((f) => f.includes("$615,000")))
  check("the event is the UPCOMING one with its source; the expired recap is not offered as an event", plan.selected.find((s) => s.module === "local_event")?.provenance?.kind === "local_event" && (plan.selected.find((s) => s.module === "local_event")!.provenance as { topicId: string }).topicId === "tEvent")
  const prompt = P.renderPlanForPrompt(plan)
  check("the writer's directive names the selected section types with their facts and drops the fixed template list", prompt.includes('section_type="property_highlight"') && prompt.includes("12 Palm Ct") && !prompt.includes("featured_listings"))

  const onlyMarket = P.selectNewsletterSections(full.candidates.filter((c) => c.module === "market_education"), { now: NOW })
  check("NOTHING FABRICATED: with only a market fact the issue is market + next action (2); event / listing / community are OMITTED with a reason", onlyMarket.selected.length === 2 && onlyMarket.omitted.filter((o) => o.reason === "no_verified_fact").map((o) => o.module).sort().join(",") === "active_listing,community_value,local_event")
  check("...and the directive tells the writer NOT to write the omitted modules", P.renderPlanForPrompt(onlyMarket).includes("OMITTED (no verified fact — do NOT write these): local event, active listing, community value"))
  const none = P.selectNewsletterSections([], { now: NOW })
  check("with no verified fact at all: evergreen education + next action (still 2) and the evergreen rule forbids naming any figure / event / listing", none.selected.length === 2 && none.selected[0].module === "evergreen_education" && /no statistic, price, date, business, event or listing/.test(none.selected[0].facts[0]))
  const repeat = P.selectNewsletterSections(full.candidates, { now: NOW, recentModules: ["active_listing"] })
  check("frequency: a module that ran last issue is scored down (−0.2) and says so", (repeat.selected.find((s) => s.module === "active_listing")?.score ?? 9) < (listing as { score: number }).score && /ran last issue/.test(repeat.selected.find((s) => s.module === "active_listing")?.why ?? ""))
  const zeroDb = memSupabase({ market_data: [{ id: "z", brokerage_id: "bA", market_area: "X", data_date: day(0), source_type: "rentcast", median_sale_price: 0, sold_listings_30d: null, active_listings: 0, new_listings_30d: 0, avg_days_on_market: 0, months_of_inventory: 0, price_trend_pct_1yr: 0 }], listings: [] })
  const zero = await P.gatherSectionCandidates(zeroDb as never, { brokerageId: "bA", agentId: null, now: NOW, localFacts: [], topics: [], audienceCities: [] })
  ;(zeroDb.tables.market_data[0] as any).median_sale_price = 1; (zeroDb.tables.market_data[0] as any).sold_listings_30d = 2
  const two = await P.gatherSectionCandidates(zeroDb as never, { brokerageId: "bA", agentId: null, now: NOW, localFacts: [], topics: [], audienceCities: [] })
  check("POSITIVE CONTROL for 'never state an unmeasured figure': an all-zero row yields NO market candidate; the same row with two figures yields one with 2 figure lines", zero.candidates.length === 0 && two.candidates.length === 1 && two.candidates[0].facts.length === 3)
}

// ── 2 · enforcement + server-side stamping ──────────────────────────────────
console.log("\n[2 · a section the plan did not select is DROPPED; provenance is stamped server-side, never taken from the browser]")
const db0 = seedDb()
const fullPlan = P.selectNewsletterSections((await P.gatherSectionCandidates(db0 as never, { brokerageId: "bA", agentId: "agA", now: NOW, localFacts: [eventFact], topics: [guideTopic], audienceCities: ["Naples"] })).candidates, { now: NOW })
{
  const marketOnly = P.selectNewsletterSections(fullPlan.selected.filter((s) => s.module === "market_education"), { now: NOW })
  const modelWrote = [
    { type: "market", section_type: "market_update", title: "Naples market", content: "Median sale price $615,000." },
    { type: "events", section_type: "local_event", title: "This weekend", content: "Jazz in the park Saturday!" },
    { type: "testimonial", section_type: "testimonial", title: "Happy client", content: "\"Best agent ever\" — J." },
    { type: "tips", section_type: "tips", title: "Spring prep", content: "Clean the gutters." },
    { type: "cta", section_type: "cta", title: "Let's talk", content: "Reply any time." },
  ]
  const e = P.enforcePlanOnSections(modelWrote, marketOnly)
  check("the model's invented event and testimonial are dropped (2), market / tips / cta are kept (3)", e.dropped.length === 2 && e.dropped.map((d) => d.sectionType).sort().join(",") === "local_event,testimonial" && e.sections.length === 3)
  check("the kept market section carries its provenance (market_data mdA) and module", (e.sections[0] as any).plan_module === "market_education" && (e.sections[0] as any).provenance?.[0]?.id === "mdA")
  const forged = [{ type: "listing", section_type: "property_highlight", title: "x", content: "y", provenance: [{ kind: "listing", listingId: "Lsold" }] }]
  check("a browser-supplied provenance is STRIPPED when no authored plan backs it (no forged / stale provenance survives)", P.stampSectionProvenance(forged, null)[0].provenance === undefined)
  check("...and REPLACED by the authored plan's provenance when one does", (P.stampSectionProvenance(forged, fullPlan)[0] as any).provenance?.[0]?.listingId === "LA")
  const stored = JSON.stringify(P.stampSectionProvenance(modelWrote.filter((s) => s.section_type !== "testimonial"), fullPlan))
  const parsed = P.parseStoredIssue(stored)
  check("the stored JSON issue is NOT an intro (introHtml null) and yields each fact's provenance once", parsed.introHtml === null && parsed.provenance.length === 3 && ["market_data", "local_event", "topic"].every((k) => parsed.provenance.some((p) => p.kind === k)))
  check("CONTROL: prose / HTML content is still the intro and carries no provenance", P.parseStoredIssue("<p>[Note] Hello</p>").introHtml === "<p>[Note] Hello</p>" && P.parseStoredIssue("[not json").introHtml === "[not json")
  const carried = P.planFromStoredIssue(stored)
  check("edit-in-place keeps the provenance the stored issue had (carry-forward)", (P.stampSectionProvenance([{ section_type: "local_event", title: "x" }], carried)[0] as any).provenance?.[0]?.topicId === "tEvent")
}

// ── 3 · send-time verification ──────────────────────────────────────────────
console.log("\n[3 · the live re-check: canceled event / sold listing / stale fact → HOLD; a refused read → defer (fail closed)]")
{
  const db = seedDb()
  const prov = fullPlan.selected.map((s) => s.provenance).filter(Boolean) as Parameters<typeof P.verifyIssueProvenance>[2]
  check("all facts still true → ok (4 checked)", (await P.verifyIssueProvenance(db as never, "bA", prov, NOW)).ok === true)
  ;(db.tables.listings.find((l: any) => l.id === "LA") as any).status = "sold"
  const sold = await P.verifyIssueProvenance(db as never, "bA", prov, NOW)
  check("the listing SOLD → invalid listing_sold, hold", !sold.ok && sold.hold && sold.invalid.some((i) => i.reason === "listing_sold" && i.id === "LA"))
  ;(db.tables.listings.find((l: any) => l.id === "LA") as any).status = "active"
  const ev = db.tables.content_topic_bank.find((t: any) => t.id === "tEvent") as any
  ev.raw_data = { local_fact: null, local_event: { ...ev.raw_data.local_event, status: "canceled", corrected_at: NOW.toISOString() } }
  const canceled = await P.verifyIssueProvenance(db as never, "bA", prov, NOW)
  check("the event CANCELED (the shape correctEvent writes) → invalid event_canceled, hold", !canceled.ok && canceled.invalid.some((i) => i.reason === "event_canceled"))
  const later = await P.verifyIssueProvenance(seedDb() as never, "bA", prov, new Date(NOW.getTime() + 10 * 86_400_000))
  check("an event whose date has passed by send time → event_expired", !later.ok && later.invalid.some((i) => i.reason === "event_expired"))
  const crossTenant = await P.verifyIssueProvenance(seedDb() as never, "bB", prov, NOW)
  check("TENANT: tenant B cannot verify tenant A's listing / market row (they read as gone → hold, never as fine)", !crossTenant.ok && crossTenant.invalid.some((i) => i.reason === "listing_gone") && crossTenant.invalid.some((i) => i.reason === "market_fact_gone"))
  const refused = memSupabase({ listings: [], content_topic_bank: [], market_data: [] }, { refuse: { listings: "permission denied", content_topic_bank: "permission denied", market_data: "permission denied" } })
  const r = await P.verifyIssueProvenance(refused as never, "bA", prov, NOW)
  check("FAIL CLOSED: a refused read is UNVERIFIABLE (defer, not hold) — never 'checked and fine'", !r.ok && r.hold === false && r.unverifiable.some((u) => u.startsWith("listings")))
  check("an issue with no recorded provenance (manual copy) is not blocked here (0 checked)", (await P.verifyIssueProvenance(db as never, "bA", [], NOW)).ok === true)
}

// ── 4 · THE REAL SCHEDULED SENDER ───────────────────────────────────────────
console.log("\n[4 · publish-newsletters (real handler): canceled event / sold listing invalidate BEFORE send — send seam 0]")
const { GET: cronGET } = await import("../app/api/cron/publish-newsletters/route")
const { NextRequest } = await import("next/server")
function seedCampaign(db: Mem, id: string) {
  const sections = P.stampSectionProvenance([
    { type: "market", section_type: "market_update", title: "Naples market", content: "<p>Median sale price $615,000.</p>" },
    { type: "events", section_type: "local_event", title: "Coming up", content: "<p>The farmers market reopens.</p>" },
    { type: "listing", section_type: "property_highlight", title: "12 Palm Ct", content: "<p>Listed at $725,000.</p>" },
    { type: "cta", section_type: "cta", title: "Next step", content: "<p>Reply any time.</p>" },
  ], fullPlan)
  db.tables.newsletter_campaigns.push({ id, brokerage_id: "bA", agent_id: "agA", campaign_name: "Spring", subject_line: "Spring in Naples", content: JSON.stringify(sections), status: "scheduled", approval_status: "approved", marketing_campaign_id: null, created_by: "uA", is_ai_generated: false, send_date: new Date(NOW.getTime() - 3_600_000).toISOString(), defer_reason: null })
  for (const [i, s] of sections.entries()) db.tables.newsletter_sections.push({ id: `${id}-s${i}`, newsletter_id: id, brokerage_id: "bA", title: s.title, content: s.content, order_index: i, target_personas: null, target_locations: null, section_type: s.section_type })
  if (!db.tables.newsletter_subscribers.length) db.tables.newsletter_subscribers.push(
    { id: "sub1", brokerage_id: "bA", agent_id: "agA", contact_id: "ctA", email: "a@example.test", status: "subscribed", contact: null },
    { id: "sub2", brokerage_id: "bA", agent_id: "agA", contact_id: "ctA2", email: "b@example.test", status: "subscribed", contact: null },
  )
}
const runCron = async () => (await cronGET(new NextRequest(`${ORIGIN}/api/cron/publish-newsletters`))).json()
{
  // a) the listing sold after approval
  const db = seedDb(); seam.client = () => db; seam.dispatched = []; seam.events = []
  seedCampaign(db, "nlSold")
  ;(db.tables.listings.find((l: any) => l.id === "LA") as any).status = "sold"
  await runCron()
  const c = db.tables.newsletter_campaigns.find((x: any) => x.id === "nlSold") as any
  check("SOLD listing: the campaign is HELD (deferred + back to pending_review, reason names listing_sold:LA)", c.status === "deferred" && c.approval_status === "pending_review" && /provenance_invalid:listing_sold:LA/.test(c.defer_reason ?? ""), `${c.status}/${c.approval_status}/${c.defer_reason}`)
  check("SOLD listing: send seam 0 calls; 0 newsletter_sends rows; the deferral is announced (NEWSLETTER_SEND_DEFERRED)", seam.dispatched.length === 0 && db.tables.newsletter_sends.length === 0 && seam.events.some((e) => e.event === "NEWSLETTER_SEND_DEFERRED"))
}
{
  // b) the event was canceled after approval (the shape lib/newsletter/local-events.ts correctEvent writes)
  const db = seedDb(); seam.client = () => db; seam.dispatched = []; seam.events = []
  seedCampaign(db, "nlCancel")
  const ev = db.tables.content_topic_bank.find((t: any) => t.id === "tEvent") as any
  ev.raw_data = { local_fact: null, local_event: { ...ev.raw_data.local_event, status: "canceled", corrected_at: NOW.toISOString() } }
  await runCron()
  const c = db.tables.newsletter_campaigns.find((x: any) => x.id === "nlCancel") as any
  check("CANCELED event: HELD with event_canceled:tEvent; send seam 0 calls", c.status === "deferred" && c.approval_status === "pending_review" && /event_canceled:tEvent/.test(c.defer_reason ?? "") && seam.dispatched.length === 0)
}
{
  // c) POSITIVE CONTROL — every fact still true: it sends, with no JSON intro and with the tracked QR link
  const db = seedDb(); seam.client = () => db; seam.dispatched = []; seam.events = []
  seedCampaign(db, "nlOk")
  const out = await runCron()
  const c = db.tables.newsletter_campaigns.find((x: any) => x.id === "nlOk") as any
  check("POSITIVE CONTROL: all facts true → sent to both subscribers (send seam 2), campaign 'sent'", seam.dispatched.length === 2 && c.status === "sent", JSON.stringify(out.results?.[0]))
  const html = String(seam.dispatched[0]?.html ?? "")
  check("the email does NOT open with the stored JSON section list (base: every email began with '[{\"type\"…')", !html.includes('[{"type"') && !html.includes('"provenance"') && html.includes("Median sale price $615,000."))
  const qr = db.tables.qr_codes.find((q: any) => q.mint_context?.source_table === "newsletter_campaigns") as any
  check("the email carries ONE clickable TRACKED link (/api/qr/scan?slug=…) from THE minter, for the planned listing's public page", !!qr && html.includes(`${ORIGIN}/api/qr/scan?slug=${qr.slug}`) && /\/listings\/LA$/.test(qr.target_url ?? "") && qr.brokerage_id === "bA")
  check("the code is minted ONCE per campaign (2 recipients, 1 code)", db.tables.qr_codes.filter((q: any) => q.mint_context?.source_table === "newsletter_campaigns").length === 1)
}
{
  // d) BIAS-003 at the send: the final compliance gate (seam) blocks a steering phrase → held for a human, 0 sent
  const db = seedDb(); seam.client = () => db; seam.dispatched = []; seam.events = []
  seedCampaign(db, "nlSteer")
  const prior = seam.gate
  seam.gate = async (a) => ({ allowed: !/perfect for families/i.test(a.content), violations: ["FairHousing: familial status"] })
  ;(db.tables.newsletter_sections.find((s: any) => s.id === "nlSteer-s2") as any).content = "<p>Perfect for families.</p>"
  await runCron()
  seam.gate = prior
  const c = db.tables.newsletter_campaigns.find((x: any) => x.id === "nlSteer") as any
  check("BIAS-003 (send): a hard fair-housing block DEFERS the campaign with the violation named; send seam 0", c.status === "deferred" && /final_compliance:FairHousing/.test(c.defer_reason ?? "") && seam.dispatched.length === 0)
}

// ── 5 · BIAS-003 at the writer: the REAL deterministic scan ──────────────────
console.log("\n[5 · BIAS-003 — the real fair-housing scan flags a steering phrase; plain description passes]")
{
  let detect: ((c: string, j: "buyer" | "seller") => string[]) | null = null
  try { detect = (await import("../lib/video/script-compliance")).detectFairHousingRedFlags } catch (e) { console.log(`  (script-compliance did not load: ${(e as Error).message})`) }
  const steer = detect ? detect("This home is perfect for families who want a quiet street.", "buyer") : []
  const clean = detect ? detect("Three bedrooms, a fenced yard and a two-car garage, a short walk to the park.", "buyer") : ["x"]
  check("a steering newsletter / flyer draft trips a HARD flag (authorNewsletterContent refuses it: 'not kept')", steer.length > 0, steer.join("; "))
  check("NEGATIVE CONTROL: a description of the home trips none", clean.length === 0, clean.join("; "))
  check("the writer refuses on a hard flag and passes warnings through (source: redFlags → refusal, warnings → complianceWarnings)", /graded\.redFlags\.length > 0\)\s*\{\s*return \{ success: false/.test(stripped("lib/kernel/content-creators.ts")) && /complianceWarnings = \[\.\.\.graded\.warnings/.test(stripped("lib/kernel/content-creators.ts")))
}

// ── 6 · QR: newsletter destination rules + the flyer through the REAL scan route ─
console.log("\n[6 · QR — real public destination or none; flyer code scans through the tracked route; paused / expired / cross-tenant refused]")
{
  const db = seedDb()
  const counted: Array<Record<string, unknown>> = []
  const resolve = async (a: Record<string, unknown>, c?: unknown) => { counted.push(a); return resolveArtifactQrSlot(a as never, c as never) as never }
  const camp = { id: "nlX", brokerage_id: "bA", agent_id: "agA", created_by: "uA", marketing_campaign_id: null }
  const withListing = await P.resolveNewsletterEmailQr(db as never, camp, [{ kind: "listing", listingId: "LA", statusAtSelection: "active", listPrice: 1 }], { resolve, origin: ORIGIN })
  const profileOnly = await P.resolveNewsletterEmailQr(db as never, camp, [], { resolve, origin: ORIGIN })
  const nothing = await P.resolveNewsletterEmailQr(db as never, { ...camp, agent_id: "agA2" }, [], { resolve, origin: ORIGIN })
  check("planned listing → the email link's destination is its public page", withListing.qr !== null && counted[0]?.destinationUrl === `${ORIGIN}/listings/LA`)
  check("no listing → the agent's public profile (/p/<public_slug>)", profileOnly.qr !== null && counted[1]?.destinationUrl === `${ORIGIN}/p/ann-alder`)
  check("no real public page → NO code is minted (minter seam not called) and no block", nothing.qr === null && nothing.status === "no_public_destination" && counted.length === 2)

  const { ListingFlyer } = await import("../remotion/ListingFlyer")
  const React = g.__nlReact as typeof import("react")
  const { renderToStaticMarkup } = await import("react-dom/server")
  const slot = await resolveArtifactQrSlot({ brokerageId: "bA", sourceTable: "listings", sourceId: "LA", slot: "flyer_panel", destinationUrl: `${ORIGIN}/listings/LA`, destinationType: "listing_detail", purpose: "listing", creatorUserId: "uA", listingId: "LA", size: { sideInches: 1 }, origin: ORIGIN }, db as never)
  const props = { address: "12 Palm Ct", cityState: "Naples, FL", price: "$725,000", beds: "3", baths: "2", sqft: "1,900", propertyType: "Single family", highlights: [], heroImageUrl: null, photoUrls: [], agentName: "Ann", agentPhone: "239-555-0100", agentPhotoUrl: null, qrCodeDataUrl: slot.status === "placed" ? slot.qrCodeDataUrl : null, qrCaption: "Scan to tour", statusLine: "OPEN HOUSE", statusDetail: "Sat · 1–3 PM ET", asOfDate: day(0), photoCredit: "Photos: Alder Studio", brand: { primaryColor: "#0F172A", accentColor: "#F59E0B", logoUrl: null, brokerageName: "Alder Realty", licenseLine: "FL Lic. #BK000", showEhoMark: true } }
  const html = renderToStaticMarkup(React.createElement(ListingFlyer as never, props as never))
  check("the open-house FLYER export draws the slot's tracked code, the date / status detail, the as-of date, the license line, EHO and the photo credit", slot.status === "placed" && html.includes(slot.qrCodeDataUrl ?? "-") && html.includes("Sat · 1–3 PM ET") && html.includes(`as of ${day(0)}`) && html.includes("FL Lic. #BK000") && html.includes("Equal Housing Opportunity") && html.includes("Photos: Alder Studio"))
  const bare = renderToStaticMarkup(React.createElement(ListingFlyer as never, { ...props, statusDetail: undefined, asOfDate: undefined, photoCredit: undefined, qrCodeDataUrl: null } as never))
  check("CONTROL: without the optional props nothing is invented (no status-detail line, no 'as of', no code)", !bare.includes("data-flyer-status-detail") && !bare.includes("as of") && !bare.includes("data:image/png"))

  if (slot.status === "placed") {
    seam.client = () => db
    const { GET: scanGET } = await import("../app/api/qr/scan/route")
    const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    const scan = async () => { const res = await scanGET(new NextRequest(slot.scanUrl, { headers: { "user-agent": IPHONE, "x-forwarded-for": "203.0.113.9" } })); return { status: res.status, location: res.headers.get("location") } }
    const live = await scan()
    check("the flyer's code RESOLVES through the tracked route to the listing's public page (redirect, slug attributed), one anonymous scan event", live.status >= 300 && live.status < 400 && (live.location ?? "").includes("/listings/LA") && (live.location ?? "").includes(`qr=${slot.slug}`) && db.tables.qr_scan_events.length === 1 && !db.tables.qr_scan_events[0].contact_id)
    const row = db.tables.qr_codes.find((q: any) => q.id === slot.qrCodeId) as any
    row.is_active = false
    const paused = await scan()
    check("PAUSED: the scan is refused (no redirect to the listing; no scan event; an audit row names the state)", !(paused.location ?? "").includes("/listings/LA") && db.tables.qr_scan_events.length === 1 && db.tables.lifecycle_events.some((e: any) => e.event_type === "qr_scan_refused"))
    const held = await resolveArtifactQrSlot({ brokerageId: "bA", sourceTable: "listings", sourceId: "LA", slot: "flyer_panel", destinationUrl: `${ORIGIN}/listings/LA`, destinationType: "listing_detail", creatorUserId: "uA", listingId: "LA", size: { sideInches: 1 }, origin: ORIGIN }, db as never)
    check("PAUSED: the next flyer export is HELD (no silent re-mint)", held.status === "held")
    row.is_active = true; row.expires_at = new Date(NOW.getTime() - 60_000).toISOString()
    const expired = await scan()
    check("EXPIRED: the scan is refused (no redirect to the listing)", !(expired.location ?? "").includes("/listings/LA") && db.tables.qr_scan_events.length === 1)
    const cross = await resolveArtifactQrSlot({ brokerageId: "bB", sourceTable: "listings", sourceId: "LB", slot: "flyer_panel", destinationUrl: `${ORIGIN}/listings/LB`, size: { sideInches: 1 }, choice: { mode: "existing", qrCodeId: slot.qrCodeId }, origin: ORIGIN }, db as never)
    check("CROSS-TENANT: tenant B placing tenant A's code is refused", cross.status === "refused")
  }
}

// ── 7 · source controls (stripped source — a tombstone is not a call site) ───
console.log("\n[7 · wiring — both senders run the gate before mailing; the writer uses the plan; no second minter]")
{
  const cron = stripped("app/api/cron/publish-newsletters/route.ts")
  const iProv = cron.indexOf("verifyIssueProvenance("), iClaim = cron.indexOf('.update({ status: "sending" })'), iLoop = cron.indexOf("for (const s of subs)")
  check("cron: the provenance gate runs BEFORE the campaign is claimed and before the recipient loop", iProv > 0 && iProv < iClaim && iClaim < iLoop)
  check("cron: the QR slot is resolved once, before the recipient loop", cron.indexOf("resolveNewsletterEmailQr(") > iClaim && cron.indexOf("resolveNewsletterEmailQr(") < iLoop)
  check("cron: no assembly reads raw c.content as the intro any more", !/campaignBodyHtml:[^\n]*c\.content/.test(cron))
  const act = stripped("app/actions/ai-newsletter.ts")
  const send = act.slice(act.indexOf("export async function sendNewsletter"))
  check("send-now: refuses pending_review / rejected and runs the provenance gate BEFORE the dispatch loop", send.indexOf("pending_review") > 0 && send.indexOf("verifyIssueProvenance(") > 0 && send.indexOf("verifyIssueProvenance(") < send.indexOf("dispatchEmail("))
  const writer = stripped("lib/kernel/content-creators.ts")
  check("writer: the fixed template list is used only for the Insider Edit; every other issue gets the selected plan", /sectionPlan \? planner\.renderPlanForPrompt\(sectionPlan\) : `Sections needed/.test(writer) && /enforcePlanOnSections\(/.test(writer))
  check("creator: provenance is stamped from the authored row (tenant-pinned), not from the request", /from\("ai_generated_content"\)\.select\("metadata"\)\s*\.eq\("id", input\.authoredContentId\)\.eq\("brokerage_id", brokerageId\)/.test(writer))
  const planner = stripped("lib/kernel/newsletter/section-planner.ts")
  check("the planner never mints: no mintTrackedQr / qrcode import / insert into qr_codes", !/mintTrackedQr|from "qrcode"|from\("qr_codes"\)/.test(planner))
}

console.log(`\nnewsletter-sections: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1) }
process.exit(0)
