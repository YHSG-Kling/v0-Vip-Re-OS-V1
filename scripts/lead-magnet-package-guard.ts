#!/usr/bin/env tsx
/**
 * scripts/lead-magnet-package-guard.ts   (run: tsx scripts/lead-magnet-package-guard.ts — key to add: test:lead-magnet-package)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 149, LANE 149D — contract C30 (owner rulings 9, 10, 11, 12, 16, 7 of 2026-11-03). In memory, no network: the model, the
 * renderer, the video director and the QR minter are seams; createLeadMagnetPackage, the ordered createMagnetFunnel, the kernel
 * (createLeadMagnet, generateQRCode), the AI-draft survivor, C11, the arbiter (arbitrateFollowUp) and the action ledger run.
 *
 *   A. CONTRACT — the order vocabulary; m942 (either line-1 stamp; columns, FKs, idempotent backfill); every kernel-portal persona
 *      (lib/portal/persona-config.ts) has its own situation questions; every question passes the protected-characteristic
 *      screen and none is a generic open question (positive controls on both screens).
 *   B. THE CREATE DOOR ASKS BEFORE IT BUILDS — no answers → the questions (every persona offered), nothing written.
 *   C. THE ORDER IS THE ORDER — the magnet's primary is produced BEFORE the form row exists; the secondaries AFTER it; the
 *      package and its ledger row carry magnet → landing_page → funnel (positive control: a re-ordered stamp list fails).
 *   D. THE CREATOR IS STORED — created_by_user_id = the creator's users.id; an agents.id is never read as one (null; 149Z); solo /
 *      team / brokerage are not assumed.
 *   E. THE PAGE IS ON THE TENANT SITE, THE QR RESOLVES — storefront path, a connected custom domain, the ONE lead-magnet QR
 *      (label lead_magnet:<id>), qr_code_id on the form, and the QR's target resolves to THIS tenant's form (another tenant's
 *      site does not).
 *   F. SITUATION QUESTIONS — a probate package asks the estate's questions, not the side, never an open box; a planner's
 *      "any other questions?" is dropped and said.
 *   G. NO FIXED TIMELINE — the follow-up is the arbiter's; a public line carrying "day 3" is replaced; a stripped-source census
 *      of the lead-magnet modules finds no fixed outbound schedule (positive control planted).
 *   H. THE ARBITER DECIDES WHEN ONE IS NEEDED — build (a DRAFT, the solo tenant's seat), wait, ask the agent; an off-menu or
 *      evidence-less reply and an outage fall to "ask the agent"; a team with several agents and no territory owner is asked,
 *      never guessed; ledgered.
 *   I. WIRING (stripped source) — the session-gated door; the dashboard component calls the action only; the runner feeds the
 *      arbiter; the cron opts in. J. The arbiter brief meets the prompt standard.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { FUNNEL_PACKAGE_ORDER, FIXED_SCHEDULE, PROTECTED_QUESTION, SITUATION_PERSONAS, SITUATION_QUESTIONS, canonicalSituation, SITUATION_SIDE_QUESTIONS, GENERIC_OPEN_QUESTION, type FunnelDeps, type MagnetFunnelPlanDraft, type ChecklistDraft } from "../lib/lead-magnets/magnet-funnel"
import { createLeadMagnetPackage, arbitrateLeadMagnetOpportunity, opportunityFromSuggestion, LEAD_MAGNET_OPPORTUNITY_ARBITER_SYSTEM, type PackageDeps } from "../lib/lead-magnets/lead-magnet-package"
import { PERSONA_CONFIGS } from "../lib/portal/persona-config"
import { createLeadMagnet } from "../lib/kernel/lead-magnets"
import { resolveTenantLandingForm } from "../lib/tenant-site/landing-page"
import { platformFollowupPolicy } from "../lib/ai-isa/followup-policy"

const ROOT = process.cwd()
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(raw(p))
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}
const section = (t: string) => console.log(`\n[${t}]`)
// The kernel's fire-and-forget audit echoes reach server-only modules under tsx (the test:lead-magnet-creation pattern): recorded.
delete process.env.NEXT_PUBLIC_SUPABASE_URL
delete process.env.SUPABASE_SERVICE_ROLE_KEY
const backgroundRejections: string[] = []
Error.stackTraceLimit = 60
process.on("unhandledRejection", (e) => { backgroundRejections.push(String((e as Error)?.stack ?? e)) })

const B1 = "00000000-0000-4000-8000-0000000000b1", B2 = "00000000-0000-4000-8000-0000000000b2", B3 = "00000000-0000-4000-8000-0000000000b3"
const AG = "00000000-0000-4000-8000-0000000000d1", AG2 = "00000000-0000-4000-8000-0000000000d2", AG3 = "00000000-0000-4000-8000-0000000000d3"
const U1 = "00000000-0000-4000-8000-0000000000a1", U2 = "00000000-0000-4000-8000-0000000000a2", U3 = "00000000-0000-4000-8000-0000000000a3"
const NOW = new Date()
const ORIGIN = "https://app.example.com"

function world(extra: Record<string, any[]> = {}) {
  const db = memSupabase({
    brokerages: [{ id: B1, name: "Elm Realty", slug: "elm-realty", deleted_at: null }, { id: B2, name: "Oak Team", slug: "oak-team", deleted_at: null }, { id: B3, name: "Solo Sam Homes", slug: "solo-sam", deleted_at: null }],
    agents: [{ id: AG, brokerage_id: B1, user_id: U1, is_active: true }, { id: AG2, brokerage_id: B2, user_id: U2, is_active: true }, { id: "00000000-0000-4000-8000-0000000000d4", brokerage_id: B2, user_id: null, is_active: true }, { id: AG3, brokerage_id: B3, user_id: U3, is_active: true }],
    users: [{ id: U1, brokerage_id: B1, first_name: "Ann", user_type: "agent" }, { id: U2, brokerage_id: B2, first_name: "Oli", user_type: "team_lead" }, { id: U3, brokerage_id: B3, first_name: "Sam", user_type: "agent" }],
    calendar_provider_accounts: [{ id: "cal-1", brokerage_id: B1, user_id: U1, is_active: true }],
    campaign_sequences: [], campaign_sequence_steps: [], market_data: [],
    farm_territories: [{ id: "ft-1", brokerage_id: B1, name: "South Austin", city: "Austin", state: "TX", zip_codes: ["78704"], agent_id: AG, is_active: true }],
    conversation_insights: [
      { id: "ci-1", brokerage_id: B1, conversation_id: "cv-1", unresolved_questions: ["Do I need to go through probate before I can sell?"], created_at: NOW.toISOString() },
      { id: "ci-2", brokerage_id: B1, conversation_id: "cv-2", unresolved_questions: ["Do I need to go through probate before I can sell?", "Is 12 Oak St still for sale?"], created_at: NOW.toISOString() },
      { id: "ci-3", brokerage_id: B2, conversation_id: "cv-3", unresolved_questions: ["Do I need to go through probate before I can sell?"], created_at: NOW.toISOString() },
    ],
    tenant_custom_domains: [], qr_codes: [], keyword_intelligence: [], ai_search_citation_observations: [], brokerage_settings: [],
    lead_capture_forms: [], lead_magnet_deliverables: [], lead_magnet_funnel_items: [], lead_magnet_promises: [], ai_video_projects: [],
    agent_action_ledger: [], lifecycle_events: [], notifications: [], tasks: [], manager_signals: [], generated_documents: [],
    ...extra,
  }, { uuidIds: true, stampCreatedAt: true })
  ;(db as any).rpc = async () => ({ data: null, error: null })
  return db
}
const rows = (db: any, t: string) => (db.tables[t] ?? []) as any[]

const CHECKLIST: ChecklistDraft = {
  insufficient: false, insufficient_reason: null, title: "The Inherited-Home Sale Checklist", intro: "The steps to sell an inherited home, in order, at your pace.",
  sections: [
    { heading: "Before anything is listed", items: [{ text: "Confirm who has authority to sell", why: "title companies ask first" }, { text: "Secure and insure the property", why: "a vacant home needs care" }, { text: "Gather the deed and recent bills", why: "it speeds every next step" }] },
    { heading: "Getting it ready", items: [{ text: "Decide what stays and what goes", why: "it frames the timeline" }, { text: "Ask for a no-pressure value review", why: "so the price is grounded" }, { text: "Ask your agent how sales work locally", why: "rules vary by state" }] },
  ],
  closing: "Questions? Reply any time — I'm happy to help.",
}

const PLAN: MagnetFunnelPlanDraft = {
  insufficient: false, insufficient_reason: null,
  name: "Selling an Inherited Home, Step by Step", magnet_type: "seller_guide",
  big_promise: "Know every step to sell an inherited home without guesswork",
  angle: "Families are asking whether probate must finish before a sale", awareness_stage: "problem_aware",
  landing: { headline: "Selling an inherited home: the steps, in order", subhead: "A one-page checklist and a short video for families handling an estate property.", cta: "Send my checklist", description: "Practical steps from Elm Realty.", faq: [] },
  situation_keys: ["timeline", "move_side", "property_address"],
  extra_questions: [{ label: "Any other questions for us?", type: "textarea", options: [] }],
  deliverables: [
    { key: "estate_checklist", kind: "checklist", role: "primary", title: "The Inherited-Home Sale Checklist", promise_line: "The Inherited-Home Sale Checklist — every step on one page", outline: ["authority to sell", "securing the home", "pricing"], why: "a quick, specific win first (reciprocity)" },
    { key: "estate_video", kind: "video", role: "deliverable", title: "What happens when you sell an estate home", promise_line: "A short video walkthrough", outline: ["authority", "timeline in general terms"], why: "authority" },
    { key: "first_chat", kind: "consultation", role: "deliverable", title: "A no-pressure first conversation", promise_line: "Book now", outline: [], why: "commitment" },
  ],
  thank_you: { headline: "Your checklist is on its way", message: "Day 3 you'll get our next tip, then every week a new one.", next_step_line: "Want a hand? Ann is happy to help." },
  steps: { personal_video: false, calendar_link: false, portal_task: null, education_sequence: false },
  follow_up: { first_value_moment: "the checklist arrives", signals_to_watch: ["opened the checklist"], handoff_when: "they ask about a sale" },
  learning: { hypothesis: "estate families convert on a one-page plan", primary_metric: "visit_to_submit" },
}

/** Funnel seams over the same client; every producer call records db.writes.length at the moment it ran (the ORDER evidence). */
function seams(db: any) {
  const events: Array<{ ev: string; at: number }> = []
  const projectFor = new Map<string, string>()
  let n = 0
  const deps: FunnelDeps = {
    now: NOW, client: db,
    entitlement: async () => ({ allowed: true, reason: "ok" }),
    plan: async () => { events.push({ ev: "plan", at: db.writes.length }); return PLAN },
    writeChecklist: async () => { events.push({ ev: "checklist_written", at: db.writes.length }); return CHECKLIST },
    finalize: async (a) => ({ ok: true, texts: a.texts }),
    renderDocument: async () => { n++; events.push({ ev: "checklist_rendered", at: db.writes.length }); return { ok: true, pdfUrl: `https://cdn.example.com/client-docs/b1/checklist-${n}.pdf`, documentId: null, error: null } },
    writeVideoScript: async () => ({ insufficient: false, insufficient_reason: null, title: "What happens when you sell an estate home", script: "Hi, I'm Ann with Elm Realty. Selling a home you inherited usually starts with confirming who can sign, then caring for the property, then pricing it with care. Here is what that looks like in general terms, and what to ask your attorney. Reply any time — I'm happy to help. Elm Realty.", on_screen: ["Authority", "Care", "Price"] }),
    commissionVideo: async (a) => {
      events.push({ ev: "video_commissioned", at: db.writes.length })
      let id = projectFor.get(a.discriminator)
      if (!id) { id = randomUUID(); projectFor.set(a.discriminator, id); db.tables.ai_video_projects.push({ id, brokerage_id: B1, agent_id: AG, video_type: "education", status: "pending_review", approval_status: "pending_review", compliance_status: "pending", video_url: null, is_published: false, video_metadata: {} }) }
      return { ok: true, status: "staged", videoProjectId: id }
    },
    draftBrand: async () => ({}),
  }
  deps.deliverable = { now: NOW, funnel: deps }
  const mint: NonNullable<PackageDeps["mintTrackedQr"]> = async (args, svc) => {
    const existing = rows(svc, "qr_codes").find((q) => q.label === args.label && q.brokerage_id === args.brokerageId)
    if (existing) return { qrCodeId: existing.id, slug: existing.slug, scanUrl: `${ORIGIN}/api/qr/scan?slug=${existing.slug}`, targetUrl: existing.target_url, qrCodeDataUrl: "data:image/png;base64,AAAA" }
    const id = randomUUID(), slug = `qr-${rows(svc, "qr_codes").length + 1}`
    svc.tables.qr_codes.push({ id, brokerage_id: args.brokerageId, agent_id: args.agentId, label: args.label, slug, target_url: args.targetUrl, destination_type: args.destinationType, purpose: args.purpose, is_active: true })
    return { qrCodeId: id, slug, scanUrl: `${ORIGIN}/api/qr/scan?slug=${slug}`, targetUrl: args.targetUrl, qrCodeDataUrl: "data:image/png;base64,AAAA" }
  }
  return { deps, events, mint }
}

const ANSWERS = { persona: "probate", area: "South Austin", topic_key: "ai_pick", deliverable: "checklist" }

async function main() {
  section("A. the contract: the order, m942, a question set for every persona, both screens")
  check("the package order is ONE vocabulary: magnet → landing_page → funnel", JSON.stringify(FUNNEL_PACKAGE_ORDER) === JSON.stringify(["magnet", "landing_page", "funnel"]))
  {
    const sqlRaw = raw("supabase/migrations/m942-lead-capture-forms-creator-and-qr-c30.sql")
    const line1 = sqlRaw.split("\n")[0]
    const sql = sqlRaw.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n")
    check("m942 line 1 is the lane stamp OR the applied stamp (the rule, not the waypoint)", /^-- WRITTEN, NOT APPLIED \(wave 149, lane 149D\) — the integrator applies via Supabase MCP; DROP INDEX \/ DROP COLUMN are owner SQL-editor$/.test(line1) || /^-- ── APPLIED LIVE /.test(line1), line1)
    check("m942 adds created_by_user_id → users(id) and qr_code_id → qr_codes(id), both ON DELETE SET NULL", /created_by_user_id uuid NULL REFERENCES public\.users\(id\) ON DELETE SET NULL/.test(sql) && /qr_code_id uuid NULL REFERENCES public\.qr_codes\(id\) ON DELETE SET NULL/.test(sql))
    check("m942 backfill is idempotent and invents nothing (only NULLs; the create echo, the owner seat, the ONE lead-magnet QR label)", (sql.match(/IS NULL;/g) ?? []).length >= 3 && /event_type = 'lead_magnet_created'/.test(sql) && /'lead_magnet:' \|\| f\.id::text/.test(sql) && !/DROP /i.test(sql))
  }
  const portalPersonas = Object.keys(PERSONA_CONFIGS)
  const unmatched = portalPersonas.filter((p) => canonicalSituation(p) === "other" || SITUATION_QUESTIONS[canonicalSituation(p)].length === 0)
  check(`every kernel-portal persona (${portalPersonas.length}, lib/portal/persona-config.ts) has its OWN situation questions — every persona allowed, none refused`, portalPersonas.length >= 16 && unmatched.length === 0, unmatched.join(", "))
  check("the campaign spellings are aliases onto the same situations (first_time, relocated, downsize, military …) — one vocabulary", canonicalSituation("first_time") === "first_time_buyer" && canonicalSituation("relocated") === "relocating" && canonicalSituation("downsize") === "empty_nester" && canonicalSituation("military") === "military_buyer" && canonicalSituation("a-persona-the-business-adds") === "other")
  const bank = [...SITUATION_PERSONAS.flatMap((p) => SITUATION_QUESTIONS[p]), ...Object.values(SITUATION_SIDE_QUESTIONS).flat()]
  const protectedHits = bank.filter((q) => PROTECTED_QUESTION.test(q.label) || (q.options ?? []).some((o) => PROTECTED_QUESTION.test(o)))
  check(`every situation question (${bank.length}) passes the protected-characteristic screen (wording only — the persona itself is never refused)`, bank.length > 30 && protectedHits.length === 0, protectedHits.map((q) => q.label).join(" | "))
  check("…and no situation question is a generic open question: each is a short choice (≥ 2 options) that belongs to the situation (ruling 16)", bank.every((q) => (q.options ?? []).length >= 2 && !GENERIC_OPEN_QUESTION.test(q.label)))
  check("positive control: the screens see a planted 'How old are you?' and 'Any other questions?'", PROTECTED_QUESTION.test("How old are you?") && GENERIC_OPEN_QUESTION.test("Any other questions?") && GENERIC_OPEN_QUESTION.test("What is the one question you most want answered?"))
  check("every side has its own fallback set (an `other` / newly added persona is never left with an open question)", (["buyer", "seller", "both"] as const).every((k) => SITUATION_SIDE_QUESTIONS[k].length >= 2))

  section("B. the Create door asks before it builds")
  {
    const db = world()
    const s = seams(db)
    const r = await createLeadMagnetPackage({ brokerageId: B1, agentId: AG, createdBy: U1, origin: "create_button", answers: {}, baseUrl: ORIGIN }, { client: db, now: NOW, funnel: s.deps, mintTrackedQr: s.mint, readers: { topicBank: async () => [] } })
    const qs = r.ok ? [] : (r.questions ?? [])
    check("no answers → the questions, and NOTHING is written (no page, no plan, no ledger)", !r.ok && r.stage === "questions" && rows(db, "lead_capture_forms").length === 0 && s.events.length === 0 && rows(db, "agent_action_ledger").length === 0)
    const personaQ = qs.find((q) => q.id === "persona")
    check("the door asks who it is for, offering EVERY situation persona (none withheld)", !!personaQ && personaQ.required && SITUATION_PERSONAS.every((p) => personaQ.options?.some((o) => o.value === p)))
    const tq = qs.find((q) => q.id === "topic_key")
    check("the topic is asked with the tenant's evidence: the question asked in ≥ 2 of THIS tenant's conversations is offered (another tenant's and a one-off are not); a question with a street number never is", !!tq && tq.options?.some((o) => /probate before I can sell/.test(o.label) && /asked often/.test(o.label)) === true && tq.options?.every((o) => !/12 Oak/.test(o.label)) === true, JSON.stringify(tq?.options))
    check("ONE territory on file is the area (not asked again)", !qs.some((q) => q.id === "area"))
    const ask = async (dbx: any, brokerageId: string, agentId: string, createdBy: string, answers: Record<string, string>) => { const sx = seams(dbx); const rx = await createLeadMagnetPackage({ brokerageId, agentId, createdBy, origin: "create_button", answers, baseUrl: ORIGIN }, { client: dbx, now: NOW, funnel: sx.deps, mintTrackedQr: sx.mint, readers: { topicBank: async () => [] } }); return rx.ok ? [] : (rx.questions ?? []) }
    const two = await ask(world({ farm_territories: [{ id: "t1", brokerage_id: B1, name: "South Austin", city: "Austin", state: "TX", zip_codes: ["78704"], agent_id: AG, is_active: true }, { id: "t2", brokerage_id: B1, name: "Round Rock", city: "Round Rock", state: "TX", zip_codes: ["78664"], agent_id: AG, is_active: true }] }), B1, AG, U1, { persona: "probate" })
    check("SEVERAL territories are offered as a choice from the tenant's own settings (not typed into code)", two.find((q) => q.id === "area")?.options?.map((o) => o.value).join("|") === "South Austin|Round Rock")
    const none = await ask(world(), B3, AG3, U3, { persona: "probate" })
    check("NO territory on file → the area is REQUIRED (the door never builds a 'local' magnet for nowhere)", none.find((q) => q.id === "area")?.required === true)
    const other = await ask(world(), B1, AG, U1, { persona: "other" })
    check("a persona the side is unknown for (other) asks the side and a description — never refuses", other.some((x) => x.id === "persona_description" && x.required) && other.some((x) => x.id === "side"))
  }

  section("C. the order is the order: magnet → landing page → funnel")
  const db = world()
  const s = seams(db)
  const r = await createLeadMagnetPackage({ brokerageId: B1, agentId: AG, createdBy: U1, origin: "create_button", answers: ANSWERS, baseUrl: ORIGIN }, { client: db, now: NOW, funnel: s.deps, mintTrackedQr: s.mint, readers: { topicBank: async () => [] } })
  if (!r.ok) { check("the package is built", false, JSON.stringify(r)); return finish() }
  const pkg = r.package
  const formInsertAt = db.writes.findIndex((w: any) => w.table === "lead_capture_forms" && w.op === "insert")
  const ev = (name: string) => s.events.filter((e) => e.ev === name)
  check("the MAGNET first: the topic is the question people keep asking (2 conversations in THIS tenant), with its value proposition", pkg.magnet.source === "frequent_question" && /probate before I can sell/.test(pkg.magnet.topic) && (pkg.magnet.evidence.conversations as number) === 2 && /keep asking/.test(pkg.magnet.valueProposition))
  check("…and its PRIMARY asset was produced BEFORE the landing page row existed (render ran at write #≤ the form insert)", formInsertAt >= 0 && ev("checklist_rendered").length >= 1 && ev("checklist_rendered")[0].at <= formInsertAt, JSON.stringify({ formInsertAt, events: s.events }))
  check("the FUNNEL after the page: the secondary video was commissioned AFTER the form insert", ev("video_commissioned").length === 1 && ev("video_commissioned")[0].at > formInsertAt, JSON.stringify({ formInsertAt, events: s.events }))
  check("the package carries the stamps in order (magnet · landing_page · funnel, seq 1..3)", JSON.stringify(pkg.order.map((o) => [o.stage, o.seq])) === JSON.stringify([["magnet", 1], ["landing_page", 2], ["funnel", 3]]))
  const ledger = rows(db, "agent_action_ledger").find((l) => l.action === "marketing.lead_magnet_funnel.create")
  check("EVIDENCE: the funnel's ledger row records the same order", JSON.stringify((ledger?.detail?.order ?? []).map((o: any) => o.stage)) === JSON.stringify(["magnet", "landing_page", "funnel"]))
  const isOrdered = (st: Array<{ stage: string }>) => st.map((o) => FUNNEL_PACKAGE_ORDER.indexOf(o.stage as never)).every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1]))
  check("positive control: the order rule rejects a page-before-magnet stamp list", isOrdered(pkg.order) && !isOrdered([{ stage: "landing_page" }, { stage: "magnet" }, { stage: "funnel" }]))
  const deliverable = rows(db, "lead_magnet_deliverables").find((d) => d.form_id === pkg.form_id)
  check("C11 holds: the magnet produced first is the form's READY deliverable record (one unit — written WITH the form)", deliverable?.status === "ready" && deliverable?.kind === "checklist" && /^https:\/\//.test(deliverable?.asset_url ?? ""))
  const items = rows(db, "lead_magnet_funnel_items").filter((i) => i.form_id === pkg.form_id)
  const form = rows(db, "lead_capture_forms").find((f) => f.id === pkg.form_id)
  check("the page promises only what existed when it was written: the magnet + the arranged consultation (the later video is a bonus, not promised)", JSON.stringify(form?.landing_content?.bullets) === JSON.stringify([items.find((i) => i.role === "primary")?.promise_line, items.find((i) => i.kind === "consultation")?.promise_line]) && items.find((i) => i.kind === "video")?.promised === false, JSON.stringify(form?.landing_content?.bullets))

  section("D. the creator is stored (solo / team / brokerage — never assumed)")
  check("created_by_user_id = the users.id that clicked Create; assignment follows the form's agent", form?.created_by_user_id === U1 && form?.agent_id === AG && pkg.creator.created_by_user_id === U1)
  {
    const d2 = world()
    const c = await createLeadMagnet({ title: "Agent-id creator", description: "x", magnetType: "generic_form", brokerageId: B2, agentId: AG2, createdBy: AG2, publishState: "draft" }, { client: d2 as never })
    const c2 = await createLeadMagnet({ title: "Foreign creator", description: "x", magnetType: "generic_form", brokerageId: B2, agentId: AG2, createdBy: U1, publishState: "draft" }, { client: d2 as never })
    const f1 = rows(d2, "lead_capture_forms").find((f) => f.id === c.magnetId), f2 = rows(d2, "lead_capture_forms").find((f) => f.id === c2.magnetId)
    // Re-asserted wave 149Z: the RULE is "the users FK only ever holds a users.id of this tenant" (§3). The agents.id crossing
    // that used to satisfy it was one value read as two identities; its one caller (the war room) now passes the users.id.
    check("an agents.id handed as createdBy is never read as a user — created_by_user_id is null, the users FK holds (§3)", c.success && f1?.created_by_user_id === null)
    check("the launch war room passes the agent's USERS id as createdBy (no agents.id reaches the creator column)",
      /createLeadMagnet\(\{[\s\S]{0,600}createdBy:\s*agentUserId/.test(readFileSync("lib/kernel/launch-war-room.ts", "utf8")) && !/createdBy:\s*agentRowId/.test(readFileSync("lib/kernel/launch-war-room.ts", "utf8")))
    check("a users.id from ANOTHER tenant is never recorded as this tenant's creator (null, not a guess)", c2.success && f2?.created_by_user_id === null)
  }

  section("E. the landing page is on the tenant's own website; the QR resolves")
  check("the storefront path /site/<tenant slug>/lm/<slug> on the app origin, a DRAFT", pkg.landing.path === `/site/elm-realty/lm/${pkg.funnel.landing_page.slug}` && pkg.landing.url === `${ORIGIN}/site/elm-realty/lm/${pkg.funnel.landing_page.slug}` && pkg.landing.state === "draft" && form?.is_active === false)
  const qrRow = rows(db, "qr_codes").find((q) => q.id === pkg.qr?.qr_code_id)
  check("ONE tracked QR, keyed on the magnet (lead_magnet:<form id>), pointing at the tenant-site landing URL with QR attribution; qr_code_id on the form", !!qrRow && qrRow.label === `lead_magnet:${pkg.form_id}` && qrRow.target_url.startsWith(pkg.landing.url!) && /utm_source=qr/.test(qrRow.target_url) && form?.qr_code_id === qrRow.id)
  {
    const u = new URL(qrRow?.target_url ?? "https://x/none")
    const m = u.pathname.match(/^\/site\/([^/]+)\/lm\/([^/]+)$/)
    const ok = m ? await resolveTenantLandingForm(db, m[1], m[2]) : null
    const foreign = m ? await resolveTenantLandingForm(db, "oak-team", m[2]) : null
    check("the QR RESOLVES: its target is THIS tenant's form through the tenant-site resolver; another tenant's site does not serve it", ok?.ok === true && (ok as any).formId === pkg.form_id && foreign?.ok === false)
  }
  {
    const d3 = world({ tenant_custom_domains: [{ id: "cd-1", brokerage_id: B1, domain: "homes.elmrealty.test", status: "active" }] })
    const s3 = seams(d3)
    const r3 = await createLeadMagnetPackage({ brokerageId: B1, agentId: AG, createdBy: U1, origin: "create_button", answers: ANSWERS, baseUrl: ORIGIN }, { client: d3, now: NOW, funnel: s3.deps, mintTrackedQr: s3.mint, readers: { topicBank: async () => [] } })
    check("a CONNECTED custom domain is the page's home: https://<domain>/lm/<slug> (proxy.ts serves it through the tenant-site route), and the QR points there", r3.ok && r3.package.landing.on_custom_domain && r3.package.landing.url === `https://homes.elmrealty.test/lm/${r3.package.funnel.landing_page.slug}` && rows(d3, "qr_codes")[0]?.target_url.startsWith("https://homes.elmrealty.test/lm/"))
  }

  section("F. situation-specific qualifying questions")
  const names = pkg.funnel.form.fields.map((f) => f.name)
  check("a probate package asks the estate's own questions (role with the property, where the estate is, condition)", ["property_role", "estate_stage", "home_condition"].every((n) => names.includes(n)))
  check("…does NOT ask 'buying or selling?' (the situation already says it) and has no open question box", !names.includes("move_side") && !names.includes("biggest_question") && !pkg.funnel.form.fields.some((f) => f.type === "textarea"))
  check("the planner's 'Any other questions for us?' textarea was DROPPED and said (ruling 16)", pkg.funnel.notes.some((n) => /generic open question/.test(n)))
  check("a first-time buyer's set asks financing readiness and the first hurdle — different questions for a different situation", (() => { const f = SITUATION_QUESTIONS.first_time_buyer.map((q) => q.key); return f.includes("financing_stage") && f.includes("first_hurdle") && !f.includes("estate_stage") })())
  {
    const d8 = world()
    const s8 = seams(d8)
    const r8 = await createLeadMagnetPackage({ brokerageId: B1, agentId: AG, createdBy: U1, origin: "create_button", answers: { persona: "other", persona_description: "Owners of rental duplexes", side: "seller", area: "South Austin", topic_key: "own", topic: "Selling a tenant-occupied duplex", deliverable: "checklist" }, baseUrl: ORIGIN }, { client: d8, now: NOW, funnel: s8.deps, mintTrackedQr: s8.mint, readers: { topicBank: async () => [] } })
    const f8 = r8.ok ? r8.package.funnel.form.fields : []
    check("an `other` persona's FORM carries its side's situation questions (sale priority, condition) — never an open box", r8.ok && ["sale_priority", "home_condition"].every((n) => f8.some((f) => f.name === n)) && !f8.some((f) => f.type === "textarea"), JSON.stringify(f8.map((f) => f.name)))
    check("…every situation field on a built form is a select (a usable answer)", f8.filter((f) => f.purpose === "situation" && !["area_of_interest", "property_address"].includes(f.name)).every((f) => f.type === "select"))
  }

  section("G. no fixed timeline — the arbiter decides")
  check("the follow-up policy is the arbiter's (decided_by arbiter, fixed_schedule false)", (pkg.funnel.follow_up_policy as any).fixed_schedule === false && /arbiter/.test(String((pkg.funnel.follow_up_policy as any).decided_by)))
  check("a thank-you line carrying a timetable ('Day 3 … every week') was replaced and said", !/day 3|every week/i.test(pkg.funnel.thank_you.message) && pkg.funnel.notes.some((n) => /fixed timetable/.test(n)))
  check("positive control: the schedule screen sees 'Day 3', 'every week', 'in 7 days', a '5-day plan' — and leaves an obligation's 'within one business day' alone", ["Day 3 you'll get", "every week", "in 7 days", "our 5-day plan"].every((t) => FIXED_SCHEDULE.test(t)) && !FIXED_SCHEDULE.test("Ann will reach out within one business day"))
  {
    const files = ["lib/lead-magnets/magnet-funnel.ts", "lib/lead-magnets/lead-magnet-package.ts", "lib/lead-magnets/suggestions.ts", "app/components/features/lead-magnets/LeadMagnetPackageCreate.tsx"]
    const SCHEDULE_TOKEN = /\b(delay_days|delayDays|reminderDaysBefore|followUpDays|dripDays|daysAfterCapture|T-\d+d)\b/
    const hits = files.filter((f) => SCHEDULE_TOKEN.test(code(f)))
    check(`census: no fixed outbound schedule token in the package modules (${files.length} files, stripped source)`, hits.length === 0, hits.join(", "))
    check("positive control: the census sees a planted `const reminderDaysBefore = 7`", SCHEDULE_TOKEN.test(code("lib/lead-magnets/lead-magnet-package.ts") + "\nconst reminderDaysBefore = 7"))
  }

  section("H. the arbiter decides when a package is needed")
  const policy = platformFollowupPolicy()
  const opp = opportunityFromSuggestion({ key: "trending_topic:t1", kind: "trending_topic", magnetType: "seller_guide", concept: "What to do first when you inherit a house", why: "rising in the topic bank (engagement 92)", evidence: { persona: "probate" } }, null)
  check("an idea becomes an opportunity: what, for whom (persona named only by the evidence; side from the idea), why, evidence", opp.what.length > 0 && opp.forWhom.persona === "probate" && opp.forWhom.side === "seller" && /rising/.test(opp.why) && opportunityFromSuggestion({ key: "k", kind: "seasonal", magnetType: "buyer_guide", concept: "c", why: "w", evidence: {} }, null).forWhom.persona === null)
  {
    const d4 = world({ farm_territories: [{ id: "ft-3", brokerage_id: B3, name: "Round Rock", city: "Round Rock", state: "TX", zip_codes: ["78664"], agent_id: AG3, is_active: true }] })
    const s4 = seams(d4)
    let built: any = null
    const out = await arbitrateLeadMagnetOpportunity(d4, { brokerageId: B3, opportunity: opp, existingForPersona: 0 }, {
      policy, now: NOW,
      decide: async () => ({ optionId: "build_package", channel: null, format: null, waitHours: null, rationale: "Strong, rising demand for this situation and no live magnet serves it.", evidence: ["moment", "relationship"], confidence: 0.8 }),
      build: async (x) => { built = x; return createLeadMagnetPackage(x, { client: d4, now: NOW, funnel: { ...s4.deps, client: d4 }, mintTrackedQr: s4.mint, readers: { topicBank: async () => [] } }) },
    })
    const f4 = rows(d4, "lead_capture_forms")[0]
    check("BUILD: a SOLO tenant's package is a DRAFT owned by its one seat (agents.id + users.id), never published", out.action === "built" && built?.agentId === AG3 && built?.createdBy === U3 && built?.origin === "arbiter" && f4?.is_active === false && f4?.created_by_user_id === U3, JSON.stringify({ action: out.action, reason: (out as any).reason, decision: out.decision, built: built ? { agentId: built.agentId, createdBy: built.createdBy } : null }).slice(0, 900))
    check("…the arbiter's decision rides the package record, and the decision is ledgered (marketing.lead_magnet_opportunity.decide)", (f4?.settings?.package?.arbiter_decision?.optionId === "build_package") && rows(d4, "agent_action_ledger").some((l) => l.action === "marketing.lead_magnet_opportunity.decide" && l.status === "executed"))
  }
  {
    const d7 = world()
    const out = await arbitrateLeadMagnetOpportunity(d7, { brokerageId: B3, opportunity: { ...opp, key: "k-noarea" } }, { policy, now: NOW, decide: async () => ({ optionId: "build_package", channel: null, format: null, waitHours: null, rationale: "Strong demand for this situation and nothing live serves it.", evidence: ["moment"], confidence: 0.8 }) })
    check("a build that still needs a person's answer (no territory on file) ASKS the agent, naming what is missing — nothing written", out.action === "asked_agent" && /needs: area/.test(out.action === "asked_agent" ? out.reason : "") && rows(d7, "lead_capture_forms").length === 0)
  }
  {
    const d5 = world()
    const out = await arbitrateLeadMagnetOpportunity(d5, { brokerageId: B2, opportunity: { ...opp, key: "k-team" } }, { policy, now: NOW, decide: async () => ({ optionId: "build_package", channel: null, format: null, waitHours: null, rationale: "Strong demand for this situation in the team's market.", evidence: ["moment"], confidence: 0.8 }), build: async () => { throw new Error("must not build") } })
    check("a TEAM with several agents and no territory owner is ASKED, never guessed (no build)", out.action === "asked_agent" && /no single owning agent/.test(out.action === "asked_agent" ? out.reason : "") && rows(d5, "lead_capture_forms").length === 0)
  }
  {
    const d6 = world()
    const wait = await arbitrateLeadMagnetOpportunity(d6, { brokerageId: B3, opportunity: { ...opp, key: "k-wait" } }, { policy, now: NOW, decide: async () => ({ optionId: "wait", channel: null, format: null, waitHours: 48, rationale: "Thin evidence so far; wait for more signal.", evidence: ["moment"], confidence: 0.7 }), build: async () => { throw new Error("must not build") } })
    const off = await arbitrateLeadMagnetOpportunity(d6, { brokerageId: B3, opportunity: { ...opp, key: "k-off" } }, { policy, now: NOW, decide: async () => ({ optionId: "publish_now", channel: null, format: null, waitHours: null, rationale: "Publish it immediately everywhere.", evidence: ["moment"], confidence: 0.99 }), build: async () => { throw new Error("must not build") } })
    const noEv = await arbitrateLeadMagnetOpportunity(d6, { brokerageId: B3, opportunity: { ...opp, key: "k-noev" } }, { policy, now: NOW, decide: async () => ({ optionId: "build_package", channel: null, format: null, waitHours: null, rationale: "Because I feel like it.", evidence: ["made_up_fact"], confidence: 0.9 }), build: async () => { throw new Error("must not build") } })
    const down = await arbitrateLeadMagnetOpportunity(d6, { brokerageId: B3, opportunity: { ...opp, key: "k-down" } }, { policy, now: NOW, decide: async () => { throw new Error("gateway down") }, build: async () => { throw new Error("must not build") } })
    check("WAIT is a bounded wait (hours), nothing built", wait.action === "waiting" && /48h/.test(wait.action === "waiting" ? wait.reason : ""))
    check("an OFF-MENU reply ('publish_now'), an EVIDENCE-LESS reply and an OUTAGE all fall to asking the agent — never a silent build", off.action === "asked_agent" && noEv.action === "asked_agent" && down.action === "asked_agent" && rows(d6, "lead_capture_forms").length === 0)
  }

  section("I. wiring (stripped source)")
  const act = code("app/actions/lead-magnets-actions.ts")
  const door = act.slice(act.indexOf("export async function createMagnetFunnelAction("), act.indexOf("export async function cloneLeadMagnetAction("))
  check("the Create door is session-gated: tenant, agent and creator from getAgentContext — no tenant in its input", /getAgentContext\(\)/.test(door) && /brokerageId: ctx\.brokerageId, agentId: ctx\.agentId, createdBy: ctx\.userId/.test(door) && !/input\.brokerage|input\.agent|input\.created/.test(door))
  check("ONE door: the wave-148 funnel door was EXTENDED into the package door (it calls createLeadMagnetPackage, never createMagnetFunnel directly)", /createLeadMagnetPackage\(/.test(door) && !/createMagnetFunnel\(/.test(door) && (act.match(/createLeadMagnetPackage\(/g) ?? []).length === 1)
  const ui = code("app/components/features/lead-magnets/LeadMagnetPackageCreate.tsx")
  check("the dashboard component calls the server action and imports NO lib module (proxy-graph rule)", /createMagnetFunnelAction\(/.test(ui) && !/from "@\/lib\//.test(ui) && /<LeadMagnetPackageCreate /.test(code("app/components/features/lead-magnets/MagnetBuilder.tsx")))
  const fn = code("lib/lead-magnets/magnet-funnel.ts")
  const body = fn.slice(fn.indexOf("export async function createMagnetFunnel("), fn.indexOf("async function refreshFunnelItems("))
  const at = (needle: string) => body.indexOf(needle)
  check("createMagnetFunnel's source order: produceMagnetAssetFirst → stamp magnet → draftLeadMagnetFromConcept → stamp landing_page → the secondaries → stamp funnel", at("produceMagnetAssetFirst(") > 0 && at("produceMagnetAssetFirst(") < at('stamp("magnet"') && at('stamp("magnet"') < at("draftLeadMagnetFromConcept({") && at("draftLeadMagnetFromConcept({") < at('stamp("landing_page"') && at('stamp("landing_page"') < at("produceFunnelAsset(svc, it.kind") && at("produceFunnelAsset(svc, it.kind") < at('stamp("funnel"'))
  check("positive control: the same scan rejects secondaries produced before the page", (() => { const planted = body.replace('stamp("landing_page"', "XX").replace("produceFunnelAsset(svc, it.kind", 'stamp("landing_page"'); return !(planted.indexOf('stamp("landing_page"') > planted.indexOf("draftLeadMagnetFromConcept({") && planted.indexOf("produceFunnelAsset(svc, it.kind") > planted.indexOf('stamp("landing_page"')) })())
  const sug = code("lib/lead-magnets/suggestions.ts")
  check("opportunity discovery FEEDS the arbiter: the runner hands new opportunities to arbitrateLeadMagnetOpportunity (opt-in), and the per-tenant cron opts in", /arbitrateLeadMagnetOpportunity\(/.test(sug) && /opts\.arbitrate/.test(sug) && /arbitrate: \{ max: 1/.test(code("app/api/cron/geo-citation-monitor/route.ts")))
  check("the creator is written by the ONE writer of lead_capture_forms (createLeadMagnet), at the top level of the insert", /created_by_user_id: creatorUserId,/.test(code("lib/kernel/lead-magnets.ts")))

  section("J. the arbiter brief (prompt standard)")
  check("ROLE · MANDATE · BUSINESS CONTEXT · FACTS · DECISION · OUTPUT CONTRACT · COMPLIANCE BOUNDARY · ESCALATION", ["ROLE", "MANDATE", "BUSINESS CONTEXT", "THE FACTS YOU MAY RELY ON", "THE DECISION YOU OWN", "OUTPUT CONTRACT", "COMPLIANCE BOUNDARY", "ESCALATION RULE"].every((h) => LEAD_MAGNET_OPPORTUNITY_ARBITER_SYSTEM.includes(h)))
  check("…every persona is a lawful audience; fair housing is about the WORDING; it never publishes; sensitive situations go to the agent", /Every persona is a lawful audience/.test(LEAD_MAGNET_OPPORTUNITY_ARBITER_SYSTEM) && /WORDING/.test(LEAD_MAGNET_OPPORTUNITY_ARBITER_SYSTEM) && /never publish/.test(LEAD_MAGNET_OPPORTUNITY_ARBITER_SYSTEM) && /ask the\s+agent rather than build/.test(LEAD_MAGNET_OPPORTUNITY_ARBITER_SYSTEM))

  await new Promise((res) => setTimeout(res, 50))
  check(`every background rejection (${backgroundRejections.length}) is the kernel's fire-and-forget audit echo, none from the package's code`, backgroundRejections.every((st) => /write-sentinel\.ts|emit\.ts|server-only/.test(st)), backgroundRejections.slice(0, 2).join("\n"))
  return finish()
}

function finish() {
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed) { console.log("❌ LEAD_MAGNET_PACKAGE_FAIL"); for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
  console.log("✅ LEAD_MAGNET_PACKAGE_PASS — the package writes the magnet first (a topic that attracts the persona), then the landing page on the tenant's own site with the situation's questions, then the funnel + QR; the creator is stored; no fixed timeline; the arbiter decides when one is needed")
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
