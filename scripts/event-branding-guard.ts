#!/usr/bin/env tsx
/**
 * scripts/event-branding-guard.ts   (npm run test:event-branding) — in-memory, no DB, no network.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WAVE 149, LANE 149F — contract C32 (tenant-branded events) + C29 (arbiter-owned timing) on the event surfaces; owner rulings
 * 15 ("Event marketing cannot use 'VIPAgents' — it is the tenant's brand name … unless it is the platform's own event"),
 * 16 ("Registration 'other question' is not an open question"), 11 (a QR to the landing page), 12 (on the tenant's own website),
 * 7 ("Nothing fixed in communications") and 3 (intent is buyer | seller | both).
 *
 *   A  BRAND — no platform brand in any event surface's code or copy (stripped source census + the expert prompt), the brand
 *      comes from THE cascade (never global_settings.app_name, whose live DEFAULT is 'VIP Real Estate OS'), a platform name in a
 *      tenant event's copy blocks approval, the platform's brand only on brand_owner = 'platform'; runtime on memSupabase.
 *   B  QUESTIONS — every registration kind asks closed, situation-specific questions; the sanitizer drops free text and forged
 *      values; a client gathering never asks a buying situation; intent = buyer | seller | both; never `prospect`.
 *   C  QR + TENANT SITE — publication mints the QR (the one minter) to the registration page INSIDE the tenant website; the
 *      tenant-site route proves the event is the site's tenant's.
 *   D  ONE PRODUCER — no open_house_events insert outside lib/kernel/open-house.ts; each legacy producer routes to it.
 *   E  ARBITER-OWNED TOUCHES — no fixed reminder table in the event files; reminders and no-show hand-offs are the arbiter's
 *      decision (runtime with a scripted arbiter): wait sends nothing, remind sends once in the approved words, the tenant's
 *      fatigue floor holds, a no-show is handed to the host only on the arbiter's say, once; m947 absent → no reminder (fail closed).
 *
 * POSITIVE CONTROLS on every finder. BLIND SPOTS printed at the end. The summary line is `RESULT: N passed, M failed`.
 * Run: NODE_OPTIONS=--max-old-space-size=6000 npx tsx --conditions=react-server scripts/event-branding-guard.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"

const ROOT = process.cwd()
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const raw = (rel: string): string => { try { return readFileSync(join(ROOT, rel), "utf8") } catch { return "" } }
const stripped = (rel: string): string => stripComments(raw(rel))
function walk(dir: string, out: string[] = []): string[] {
  let names: string[] = []
  try { names = readdirSync(join(ROOT, dir)) } catch { return out }
  for (const n of names) {
    const rel = `${dir}/${n}`
    if (n === "node_modules" || n.startsWith(".")) continue
    const st = statSync(join(ROOT, rel))
    if (st.isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(n)) out.push(rel)
  }
  return out
}

/** The event surfaces (C32 census). The detector itself (event-registry.ts, which holds the patterns) is excluded — published. */
const EVENT_SURFACES = [
  ...walk("lib/open-house").filter((f) => !f.endsWith("event-registry.ts")),
  ...walk("app/open-house"), ...walk("app/site/[slug]/events"), ...walk("app/api/open-house"),
  "lib/communications/send-invitation.ts", "app/actions/open-house.ts", "app/actions/open-house-automation.ts", "app/actions/seller-open-house.ts",
  "app/dashboard/open-houses/open-houses-client.tsx", "app/api/cron/open-house-followup/route.ts",
]

async function main(): Promise<void> {
  const reg = await import("../lib/open-house/event-registry")
  const mk = await import("../lib/open-house/event-marketing")

  // ── A ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── A  C32: the tenant's brand on every event surface ──")
  const hitsIn = (files: readonly string[]) => files.flatMap((f) => reg.platformBrandHits(stripped(f)).map((h) => `${f}: "${h}"`))
  const surfaceHits = hitsIn(EVENT_SURFACES)
  check(`no platform brand in the code / copy of ${EVENT_SURFACES.length} event surface files (stripped — a tombstone naming it is not a use)`, surfaceHits.length === 0, surfaceHits.join("; "))
  check("POSITIVE CONTROL: the census sees a planted 'Hosted by VIPAgents' / 'VIP Agents' / 'VIP Real Estate OS' string",
    reg.platformBrandHits(stripComments(`const h = "Hosted by VIPAgents"`)).length === 1 && reg.platformBrandHits("Brought to you by VIP Agents").length === 1 && reg.platformBrandHits("VIP Real Estate OS").length === 1 && reg.platformBrandHits("our VIP agent concierge").length === 0)
  check("POSITIVE CONTROL: a configured product name (the platform renamed) is caught too", reg.platformBrandHits("Powered by Acme Cloud", ["Acme Cloud"]).length === 1)
  const P = mk.EVENT_MARKETING_SYSTEM
  check("the expert prompt names NO platform brand and carries the BRAND rule (only the host's brand; never the software)", reg.platformBrandHits(P).length === 0 && /BRAND \(non-negotiable\)/.test(P) && /solo agent, a team or a brokerage/.test(P))
  check("POSITIVE CONTROL: the wave-148 opening ('… inside VIPAgents, the AI team …') would be caught", reg.platformBrandHits("You are the events director and lead copywriter inside VIPAgents, the AI team").length === 1)
  const view = stripped("app/open-house/[eventId]/register/registration-view.tsx")
  check("the registration view takes its brand from resolveEventBrand (THE cascade) and never reads global_settings.app_name", /resolveEventBrand\(/.test(view) && !/app_name/.test(view) && !/global_settings/.test(view))
  check("POSITIVE CONTROL: the app_name finder sees the wave-148 read", /app_name/.test(`svc.from("global_settings").select("app_name, app_logo_url")`))
  const inv = stripped("lib/communications/send-invitation.ts")
  check("the invitation resolves the event's brand and puts it in the header and footer; no 'exclusive' puffery on the piece", /resolveEventBrand\(/.test(inv) && /brand:\s*\{\s*name:\s*brand\.displayName/.test(inv) && !/\bexclusive\b/i.test(inv))
  const brandBody = raw("lib/open-house/event-marketing.ts")
  check("resolveEventBrand reads THE cascade (resolveBrandContext) and falls back to the tenant's own name — never the platform's", /resolveBrandContext\(/.test(stripComments(brandBody)) && /displayName:\s*legal/.test(stripComments(brandBody)))

  const good = {
    headline: "Buying your first home", registration_intro: "Join Harbor Realty for an evening.", what_you_will_learn: ["a"], invitation_subject: "s", invitation_body: "b", invitation_sms: "Join us. Reply STOP to opt out.",
    confirmation_subject: "s", confirmation_body: "See you {{date_time}} — {{join_link}}", reminder_subject: "s", reminder_body: "Soon: {{date_time}} — {{join_link}}",
    replay_attended_subject: "s", replay_attended_body: "{{replay_link}}", replay_missed_subject: "s", replay_missed_body: "{{replay_link}}", social_post: "p", self_check: "",
  }
  check("a clean tenant draft is approvable", !mk.scanEventCopy(good, { online: true, brandOwner: "tenant" }).blocking)
  const leaked = mk.scanEventCopy({ ...good, headline: "VIPAgents presents: first-time buyer night" }, { online: true, brandOwner: "tenant" })
  check("POSITIVE CONTROL: the platform's name in a TENANT event's headline BLOCKS approval (high severity)", leaked.blocking && leaked.findings.some((f) => f.field === "headline" && f.severity === "high"))
  check("…and in a bullet on the public page too", mk.scanEventCopy({ ...good, what_you_will_learn: ["How VIP Agents finds homes"] }, { online: true }).blocking)
  check("the platform's OWN event may name the platform (brand_owner = 'platform')", !mk.scanEventCopy({ ...good, headline: "VIPAgents live demo" }, { online: true, brandOwner: "platform" }).blocking)
  check("an unknown / unreadable brand owner is the TENANT (the safe answer)", reg.eventBrandOwner(undefined) === "tenant" && reg.eventBrandOwner("PLATFORM") === "tenant" && reg.eventBrandOwner("platform") === "platform")
  check("a reminder without {{date_time}} is not approvable (the words a C29 touch sends)", mk.scanEventCopy({ ...good, reminder_body: "See you soon" }, { online: false }).missing.some((m) => /reminder_body/.test(m)))

  // runtime: the brand an event speaks in, and the prompt the model gets
  {
    const B = "b1490000-0000-4000-8000-0000000000f1", U = "d1490000-0000-4000-8000-0000000000f1", AG = "a1490000-0000-4000-8000-0000000000f1", EV = "e1490000-0000-4000-8000-0000000000f1", EVP = "e1490000-0000-4000-8000-0000000000f2"
    const svc = memSupabase({
      brokerages: [{ id: B, name: "Harbor Realty", slug: "harbor" }],
      global_settings: [{ brokerage_id: B, app_name: "VIP Real Estate OS" }],
      users: [{ id: U, brokerage_id: B, first_name: "Dana", last_name: "Host", team_id: null }],
      agents: [{ id: AG, user_id: U, brokerage_id: B }],
      open_house_events: [
        { id: EV, brokerage_id: B, agent_id: AG, created_by: U, event_type: "webinar", title: "First-time buyer basics", event_date: "2026-12-10", start_time: "18:00", end_time: "19:00", virtual_provider: "zoom", marketing_assets: {} },
        { id: EVP, brokerage_id: B, agent_id: AG, created_by: U, event_type: "webinar", title: "Platform demo", event_date: "2026-12-11", start_time: "18:00", end_time: "19:00", virtual_provider: "zoom", marketing_assets: {}, brand_owner: "platform" },
      ],
    })
    const cascade = async () => ({ displayName: "Harbor Realty", brokerageName: "Harbor Realty", agentName: "Dana Host", display: { websiteWordmark: "harborrealty.example" }, visual: { logoUrl: null, primaryColor: "#123456" }, fairHousing: { shortDisclosure: "Equal Housing Opportunity." } })
    const product = async () => ({ name: "VIP Agents", ctaUrl: "https://platform.example", logoUrl: null, primaryColor: "#000000" })
    const tb = await mk.resolveEventBrand(svc as never, { id: EV, brokerage_id: B, agent_id: AG, created_by: U }, { brandContext: cascade as never, productBrand: product })
    check("a tenant event's brand is the cascade's (Harbor Realty, its website) — the global_settings app_name 'VIP Real Estate OS' never appears", tb.owner === "tenant" && tb.displayName === "Harbor Realty" && tb.website === "harborrealty.example" && !JSON.stringify(tb).includes("VIP"), JSON.stringify(tb))
    const pb = await mk.resolveEventBrand(svc as never, { id: EVP, brokerage_id: B, agent_id: AG, created_by: U }, { brandContext: cascade as never, productBrand: product })
    check("a platform-owned event's brand is the platform's brand kit", pb.owner === "platform" && pb.displayName === "VIP Agents")
    const fb = await mk.resolveEventBrand(svc as never, { id: EV, brokerage_id: B, agent_id: AG, created_by: U }, { brandContext: (async () => { throw new Error("cascade down") }) as never, productBrand: product })
    check("POSITIVE CONTROL — a cascade failure falls back to the TENANT's own name, never the platform's", fb.owner === "tenant" && fb.displayName === "Harbor Realty", JSON.stringify(fb))
    let prompt = ""
    const d1 = await mk.draftEventMarketing(svc as never, EV, { brandContext: cascade as never, productBrand: product, generate: async (r) => { prompt = r.prompt; return { ...good, handout_subject: "h", handout_body: "{{handout_link}}" } as never } })
    check("the model is told it writes for the TENANT, in the host's brand and website (no platform name in its facts)", d1.ok && /TENANT EVENT/.test(prompt) && /HOSTED BY: Dana Host, Harbor Realty/.test(prompt) && /HOST WEBSITE: harborrealty\.example/.test(prompt) && reg.platformBrandHits(prompt).length === 0, prompt.slice(0, 300))
    const d2 = await mk.draftEventMarketing(svc as never, EV, { brandContext: cascade as never, productBrand: product, generate: async () => ({ ...good, invitation_body: "VIPAgents invites you", handout_subject: "h", handout_body: "{{handout_link}}" }) as never })
    check("POSITIVE CONTROL: a draft that names the platform on a tenant event is stored as needs_revision, not approvable", d2.ok && d2.status === "needs_revision" && d2.findings.some((f) => f.field === "invitation_body"))

    // ── C ── QR + the page inside the tenant website
    console.log("\n── C  rulings 11 + 12: the registration page on the tenant's website, and its QR ──")
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test"
    const minted: any[] = []
    const qr = await mk.ensureEventQr(svc as never, { id: EV, brokerage_id: B, agent_id: AG, listing_id: null, event_type: "webinar" }, { mint: (async (a: any) => { minted.push(a); return { qrCodeId: "qr-1", slug: "s1", scanUrl: "https://app.example.test/api/qr/scan?slug=s1", targetUrl: a.targetUrl, qrCodeDataUrl: "data:image/png;base64,AA", destinationType: a.destinationType, created: true } }) as never })
    const evRow = ((svc as any).tables.open_house_events as any[]).find((e) => e.id === EV)
    check("publication mints ONE QR through the one minter, owned by the tenant + host, pointing INSIDE the tenant website (/site/harbor/events/<id>), stamped on the event",
      qr.ok && minted.length === 1 && minted[0].brokerageId === B && minted[0].agentId === AG && minted[0].targetUrl === `https://app.example.test/site/harbor/events/${EV}` && minted[0].label === `open_house:${EV}` && minted[0].purpose === "event" && evRow?.qr_code_id === "qr-1", JSON.stringify(minted[0] ?? qr))
    ;(svc as any).tables.brokerages[0].slug = null
    check("a tenant with no website slug falls back to the platform-origin registration page", (await mk.eventFrontDoorPath(svc as never, { id: EV, brokerage_id: B, event_type: "webinar" })) === `/open-house/${EV}/register`)
    check("a kiosk kind's front door is its sign-in page", (await mk.eventFrontDoorPath(svc as never, { id: EV, brokerage_id: B, event_type: "open_house" })) === `/open-house/${EV}/signin`)
    delete process.env.NEXT_PUBLIC_APP_URL
    const noOrigin = await mk.ensureEventQr(svc as never, { id: EV, brokerage_id: B, event_type: "webinar" }, { mint: (async () => { throw new Error("must not mint") }) as never })
    check("POSITIVE CONTROL: with no public origin no QR is minted (a QR to a relative address scans to nowhere) — said", !noOrigin.ok && /origin/.test(noOrigin.error))
  }
  const approveSrc = stripped("app/actions/open-house.ts")
  check("approveEventMarketing mints the QR after the approval is stored, and scans with the event's brand owner", /ensureEventQr\(\s*service,\s*ev\s*\)/.test(approveSrc) && /brandOwner:\s*brand\.owner/.test(approveSrc))
  const site = stripped("app/site/[slug]/events/[eventId]/page.tsx")
  check("the tenant-site route proves the event belongs to THAT site's tenant (siteBrokerageId → 404 otherwise)", /EventRegistrationView eventId=\{eventId\} siteBrokerageId=\{site\.id\}/.test(site) && /siteBrokerageId !== undefined && siteBrokerageId !== ev\.brokerage_id\) notFound\(\)/.test(view))
  check("the invitation's registration link is the tenant-site front door (eventFrontDoorPath), not a hard-coded platform path", /eventFrontDoorPath\(/.test(inv) && !/\/open-house\/\$\{params\.eventId\}\/register/.test(inv))

  // ── B ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── B  ruling 16: situation-specific registration questions ──")
  const regKinds = reg.EVENT_KINDS.filter((k) => reg.EVENT_PRODUCER_REGISTRY[k].registration.required)
  const noQuestions = regKinds.filter((k) => reg.REGISTRATION_QUESTIONS[k].length === 0)
  check(`every registration kind (${regKinds.join(", ")}) asks its own situation questions`, noQuestions.length === 0, noQuestions.join(", "))
  const all = reg.EVENT_KINDS.flatMap((k) => reg.REGISTRATION_QUESTIONS[k].map((q) => ({ k, q })))
  check("every question is CLOSED (single / multiple / yes-no / count with ≥ 2 options) — no open text, no 'question' key", all.every(({ q }) => ["single", "multiple", "yes_no", "count"].includes(q.kind) && q.options.length >= 2 && (q.key as string) !== "question"))
  check("each kind's declared situationFields are exactly what its questions ask", regKinds.every((k) => JSON.stringify([...reg.EVENT_PRODUCER_REGISTRY[k].registration.situationFields].sort()) === JSON.stringify([...new Set(reg.REGISTRATION_QUESTIONS[k].map((q) => q.key))].filter((x) => reg.EVENT_PRODUCER_REGISTRY[k].registration.situationFields.includes(x)).sort())) && regKinds.every((k) => reg.EVENT_PRODUCER_REGISTRY[k].registration.situationFields.every((f) => reg.REGISTRATION_QUESTIONS[k].some((q) => q.key === f))))
  check("a client gathering never asks a past client their buying situation (no intent / timeline / agent question)", reg.REGISTRATION_QUESTIONS.client_event.every((q) => !["intent", "timeline", "workingWithAgent"].includes(q.key)) && reg.REGISTRATION_QUESTIONS.client_event.some((q) => q.key === "guests"))
  check("the virtual open house asks about THE HOME (tour interests) and the sessions about THE SUBJECT (different interest lists)", JSON.stringify(reg.REGISTRATION_QUESTIONS.virtual_open_house.find((q) => q.key === "interests")?.options) !== JSON.stringify(reg.REGISTRATION_QUESTIONS.webinar.find((q) => q.key === "interests")?.options))
  const forged = reg.sanitizeEventSituation("webinar", { intent: "buyer", question: "free text the owner ruled out", interests: ["financing_and_rates", "<script>"], requests: ["home_value_estimate"], guests: 3 })
  check("the sanitizer keeps only what the kind's questions admit: free text, an off-list value and another kind's field are DROPPED",
    forged.intent === "buyer" && JSON.stringify(forged.interests) === JSON.stringify(["financing_and_rates"]) && JSON.stringify(forged.requests) === JSON.stringify(["home_value_estimate"]) && forged.guests === null && !("question" in forged))
  check("POSITIVE CONTROL: a client gathering's guest count IS kept on its own kind", reg.sanitizeEventSituation("client_event", { guests: "2", accessibility: "yes" }).guests === 2 && reg.sanitizeEventSituation("client_event", { guests: 2 }).accessibility === null)
  check("the registration form renders the server's questions and has no free-text box", !/<textarea/.test(stripped("app/open-house/[eventId]/register/registration-form.tsx")) && /questions\.map\(/.test(stripped("app/open-house/[eventId]/register/registration-form.tsx")))
  check("POSITIVE CONTROL: the textarea finder sees the wave-148 box", /<textarea/.test(`<textarea rows={3} value={f.question} />`))
  check("ruling 3: the registration intent is buyer | seller | both and maps onto itself — never 'prospect'", JSON.stringify([...reg.EVENT_INTENTS]) === JSON.stringify(["buyer", "seller", "both"]) && !Object.values(reg.CONTACT_TYPE_FOR_INTENT).includes("prospect" as never) && !/"prospect"/.test(stripped("lib/open-house/event-attendance.ts")))

  // ── D ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── D  one producer: every event row through lib/kernel/open-house.ts ──")
  const INSERT = /\.from\(\s*["'`]open_house_events["'`]\s*\)\s*\.(insert|upsert)\(/
  const codeFiles = [...walk("app"), ...walk("lib"), ...walk("workflows")]
  const writers = codeFiles.filter((f) => INSERT.test(stripped(f)))
  check(`exactly ONE file inserts open_house_events (${writers.length}): lib/kernel/open-house.ts`, writers.length === 1 && writers[0] === "lib/kernel/open-house.ts", writers.join(", "))
  check("POSITIVE CONTROL: the census sees a planted second insert, and not one inside a tombstone comment",
    INSERT.test(stripComments(`await supabase.from("open_house_events")\n  .insert({ listing_id })`)) && !INSERT.test(stripComments(`// TOMBSTONE: await supabase.from("open_house_events").insert({ x })`)))
  const LEGACY: Array<[string, RegExp]> = [
    ["app/actions/open-house.ts", /produceEventRow\(/],
    ["app/actions/seller-open-house.ts", /produceEventRow\(/],
    ["app/actions/open-house-automation.ts", /createOpenHouse\(/],
    ["app/actions/seller-listing/execution-engine.ts", /produceEventRow\(/],
    ["lib/kernel/launch-war-room.ts", /produceEventRow\(/],
    ["lib/wizard-staging/content-staging.ts", /produceEventRow\(/],
    ["app/lifetime-customers/components/campaigns-gifting-panel.tsx", /aiGenerateEventInvitation\(/],
  ]
  for (const [f, re] of LEGACY) check(`${f} produces through the one door / writer`, re.test(stripped(f)))
  const auto = stripped("app/actions/open-house-automation.ts")
  check("the acquisition doors take the host from the SESSION (createOpenHouse), never the body's agentId", !/agent_id:\s*params\.agentId/.test(auto))
  const sphereSrc = stripped("app/actions/ai-sphere-management.ts"), ohSrc = stripped("app/actions/open-house.ts")
  check("the sphere's event is a REAL event (aiGenerateEventInvitation → createOpenHouse, kinds client_event / education_session / webinar); the free-standing copy generator is gone",
    !/aiGenerateEventInvitation|Create invitation content for this client event/.test(sphereSrc) && /export async function aiGenerateEventInvitation\(/.test(ohSrc) && /SPHERE_EVENT_KIND\s*=\s*\{\s*client_appreciation:\s*"client_event"/.test(ohSrc))

  // ── E ─────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n── E  C29: reminders and no-show follow-up are the arbiter's ──")
  const TIMETABLE = /\b(reminder|remind|nudge|followup|follow_up)\w*(Days|Hours)(Before|After)\b|\bT[-+]\d+\s*[dh]\b|\[\s*7\s*,\s*1\s*\]|\b(daysBefore|hoursBefore|daysAfter|hoursAfter)\b/
  const tableHits = EVENT_SURFACES.filter((f) => TIMETABLE.test(stripped(f)))
  check(`no fixed reminder / no-show timetable in the event files (${tableHits.length})`, tableHits.length === 0, tableHits.join(", "))
  check("POSITIVE CONTROL: a planted `reminderDaysBefore = 7` and a 'T-7d' offset are caught", TIMETABLE.test("const reminderDaysBefore = 7") && TIMETABLE.test(`const at = "T-7d"`))
  const touches = stripped("lib/open-house/event-touches.ts")
  check("the touches decide through THE arbiter (arbitrateFollowUp over a closed remind / wait and host / rest menu) and ledger every act", /A\.arbitrateFollowUp\(/.test(touches) && /id:\s*"remind"/.test(touches) && /id:\s*"wait"/.test(touches) && /id:\s*"notify_human"/.test(touches) && /action:\s*"open_house\.reminder\.send"/.test(touches) && /action:\s*"open_house\.no_show\.hand_to_host"/.test(touches))
  check("the cron sweep only gives the arbiter the chance to decide (arbitrateEventTouches), and the follow-up sweep hands no-shows to it", /arbitrateEventTouches\(/.test(stripped("app/api/cron/open-house-followup/route.ts")) && /arbitrateEventTouches\(/.test(auto))
  {
    const T = await import("../lib/open-house/event-touches")
    const B = "b1490000-0000-4000-8000-0000000000e1", AG = "a1490000-0000-4000-8000-0000000000e1", U = "d1490000-0000-4000-8000-0000000000e1"
    const EV = "e1490000-0000-4000-8000-0000000000e1", C1 = "c1490000-0000-4000-8000-0000000000e1", R1 = "f1490000-0000-4000-8000-0000000000e1"
    const now = new Date("2026-12-08T15:00:00Z")
    const approved = { status: "approved", approved: { reminder_subject: "See you Thursday", reminder_body: "Hi {{first_name}} — {{event_title}} is {{date_time}}. Your link: {{join_link}}" } }
    const mk2 = (extra: Record<string, unknown> = {}) => memSupabase({
      open_house_events: [{ id: EV, brokerage_id: B, agent_id: AG, created_by: U, event_type: "webinar", status: "scheduled", title: "First-time buyer basics", event_date: "2026-12-10", start_time: "18:00", end_time: "19:00", timezone: "America/New_York", virtual_provider: "zoom", is_published: true, marketing_assets: approved, ...extra }],
      open_house_rsvp_tracking: [{ id: R1, event_id: EV, contact_id: C1, brokerage_id: B, rsvp_status: "yes", registered_at: "2026-12-01T12:00:00Z", situation: { timeline: "1-3_months", requests: ["one_on_one_consultation"] }, reminder_count: 0, last_reminded_at: null }],
      contacts: [{ id: C1, brokerage_id: B, email: "ana@example.test", first_name: "Ana", last_name: "Lopez" }],
    })
    const { platformFollowupPolicy } = await import("../lib/ai-isa/followup-policy")
    const policy = platformFollowupPolicy()
    const keys = new Set<string>()
    const ledger = (async (ctx: any, run: () => Promise<any>, hooks: any) => { const k = `${ctx.action}|${ctx.subject?.id}|${ctx.cycle}`; if (keys.has(k)) return hooks.replay({ kind: "replayed" }); keys.add(k); return run() }) as never
    const sent: any[] = [], tasks: any[] = [], waits: any[] = []
    const base = { policy, ledger, now: () => now, sendEmail: async (p: any) => { sent.push(p); return { success: true } }, routeToAgent: (async (_s: unknown, a: any) => { tasks.push(a); return true }) as never, recordWait: async (_s: unknown, a: any) => { waits.push(a) } }
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test"
    const say = (optionId: string, extra: Record<string, unknown> = {}) => (async () => ({ optionId, channel: optionId === "remind" ? "email" : null, rationale: `scripted arbiter chose ${optionId} for the proof`, evidence: ["journey", "history"], confidence: 0.9, ...extra })) as never
    const s1 = mk2()
    const w = await T.arbitrateEventTouches(s1 as never, EV, { ...base, decide: say("wait", { waitHours: 24 }) })
    check("the arbiter says WAIT → nothing is sent, the wait is recorded (bounded deferral)", w.phase === "upcoming" && w.asked === 1 && w.reminded === 0 && sent.length === 0 && waits.length === 1, JSON.stringify(w))
    const r = await T.arbitrateEventTouches(s1 as never, EV, { ...base, decide: say("remind") })
    const row = ((s1 as any).tables.open_house_rsvp_tracking as any[])[0]
    check("the arbiter says REMIND → ONE reminder in the APPROVED words with the personal link, the memory recorded (count 1)", r.reminded === 1 && sent.length === 1 && /First-time buyer basics/.test(sent[0].text) && sent[0].text.includes(`/open-house/${EV}/join?r=${R1}`) && row.reminder_count === 1 && !!row.last_reminded_at, JSON.stringify({ r, sent: sent.map((x) => x.text) }))
    const r2 = await T.arbitrateEventTouches(s1 as never, EV, { ...base, decide: say("remind") })
    check("the TENANT's fatigue floor holds: right after a reminder the arbiter is not even asked", r2.asked === 0 && sent.length === 1 && r2.skipped.some((x) => /fatigue floor/.test(x.reason)))
    const s0 = mk2({ marketing_assets: { status: "approved", approved: {} } })
    const n0 = await T.arbitrateEventTouches(s0 as never, EV, { ...base, decide: say("remind") })
    check("POSITIVE CONTROL: no approved reminder copy → nothing sent (nothing static stands in), said", n0.reminded === 0 && sent.length === 1 && n0.skipped.some((x) => /approved reminder copy/.test(x.reason)))
    // m947 absent: the memory read is refused → no reminder (fail closed). Simulated by a client whose rsvp memory select errors.
    const s3 = mk2()
    const wrapped = { from: (t: string) => { const q = (s3 as any).from(t); if (t !== "open_house_rsvp_tracking") return q; const sel = q.select.bind(q); q.select = (cols: string, ...rest: unknown[]) => (/reminder_count/.test(cols) ? { in: () => ({ eq: async () => ({ data: null, error: { message: "column open_house_rsvp_tracking.reminder_count does not exist", code: "42703" } }) }) } : sel(cols, ...rest)); return q } }
    const f3 = await T.arbitrateEventTouches(wrapped as never, EV, { ...base, decide: say("remind") })
    check("FAIL CLOSED: before m947 the reminder memory is unreadable → no reminder is sent, and it says why", f3.reminded === 0 && sent.length === 1 && /m947/.test(f3.reason), JSON.stringify(f3))
    // AFTER: a verified no-show — the host is told only when the arbiter says so, once.
    const after = () => new Date("2026-12-11T15:00:00Z")
    const s4 = mk2(); ((s4 as any).tables.open_house_rsvp_tracking as any[])[0].rsvp_status = "no_show"
    const rest = await T.arbitrateEventTouches(s4 as never, EV, { ...base, now: after, decide: say("wait", { waitHours: 24 }) })
    check("a no-show the arbiter says to let rest → no task for the host", rest.phase === "after" && rest.asked === 1 && rest.handedToHost === 0 && tasks.length === 0)
    const told = await T.arbitrateEventTouches(s4 as never, EV, { ...base, now: after, decide: say("notify_human") })
    const again = await T.arbitrateEventTouches(s4 as never, EV, { ...base, now: after, decide: say("notify_human") })
    check("the arbiter says hand to the host → ONE task (never 'we noticed you didn't come'), and a second sweep hands nothing again", told.handedToHost === 1 && tasks.length === 1 && /Never mention that they did not attend/.test(tasks[0].description) && again.handedToHost === 0 && tasks.length === 1, JSON.stringify({ told, again }))
    const s5 = mk2({ event_type: "client_event", virtual_provider: null }); ((s5 as any).tables.open_house_rsvp_tracking as any[])[0].rsvp_status = "no_show"
    const party = await T.arbitrateEventTouches(s5 as never, EV, { ...base, now: after, decide: say("notify_human") })
    check("a client gathering's no-show is never chased (the arbiter is not asked)", party.asked === 0 && tasks.length === 1 && /never chased/.test(party.reason))
    delete process.env.NEXT_PUBLIC_APP_URL
  }

  {
    // 149Z (this lane's Outside-lane 2, C32): the tenant website's home lists its OWN upcoming published events, linked inside
    // the site (the tenant-site event route proves the tenant again); positive control on the finder.
    const site = stripped("app/site/[slug]/page.tsx")
    const READS_OWN_EVENTS = /from\("open_house_events"\)[\s\S]{0,260}\.eq\("brokerage_id",[^)]*\)[\s\S]{0,200}\.eq\("is_published", true\)/
    check("the tenant website lists its own upcoming published events and links each INSIDE the site (/site/<slug>/events/<id>)",
      READS_OWN_EVENTS.test(site) && /\.gte\("event_date", todayIso\)/.test(site) && /href=\{`\$\{tenantWebsitePath\(b\.slug\)\}\/events\/\$\{e\.id\}`\}/.test(site))
    check("POSITIVE CONTROL: the finder refuses an events read with no tenant predicate", !READS_OWN_EVENTS.test(`svc.from("open_house_events").select("id").eq("is_published", true)`))
  }

  console.log("\n[blind spots]")
  console.log("  · the brand census reads STRIPPED source of the event surface files by pattern (platform names: VIP Agents / VIPAgents / VIP Real Estate OS / VIP RE OS + a configured product name); a platform name assembled at runtime from parts, or one stored in a tenant's own data, is not seen here — the copy scan (scanEventCopy) is the runtime net for model-written words");
  console.log("  · lib/open-house/event-registry.ts is excluded from the census: it holds the detector's own patterns")
  console.log("  · the model, the QR minter, the brand cascade (server-only) and the dispatcher are seams; memSupabase has no RLS / CHECK — m947 / m948 are WRITTEN, NOT APPLIED, so brand_owner and the reminder memory exist only in the fixture")
  console.log("  · 'platform-owned' is decided in createOpenHouse from the session's platform_role (code gate) — the database CHECK cannot see the actor")
  console.log("  · the arbiter's decision is scripted here; whether the live model chooses well is not provable statically")
  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  for (const f of failures) console.log(`   ✗ ${f}`)
  process.exit(failed > 0 ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
