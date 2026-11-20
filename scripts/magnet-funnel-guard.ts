#!/usr/bin/env tsx
/**
 * scripts/magnet-funnel-guard.ts   (run: tsx scripts/magnet-funnel-guard.ts — key to add: test:magnet-funnel)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 148, LANE 148G — owner ruling 11 (2026-11-01: "the lead magnets first create the landing pages, forms … and then what
 * the deliverables will need to be … it could be an education video and deliverables can be a funnel with a thank-you, video
 * along with a calendar link … Some magnet assets can be staged") and contract C21 createMagnetFunnel. In memory, no network:
 * the model, the renderer and the video director are seams; the kernel (createLeadMagnet / publishLeadMagnet /
 * captureFormSubmission), the AI-draft survivor, C11, C4, C5, video staging's verdict and the action ledger run for real.
 *
 *   A. THE CONTRACT — vocabularies (deliverable kinds spread from C4's; the timeline options = the live contacts CHECK), m921
 *      (either line-1 stamp: table, CHECK lists = the code, ready / arranged / promised shapes, RLS, the extended trigger).
 *   B. THE BUILD — brief → expert planner → landing page INSIDE the tenant site (draft) → form (C15 spec + identity + situation +
 *      owner; a protected-characteristic question dropped) → the PRIMARY created with the magnet (C11, the real checklist
 *      producer) → secondaries: a video STAGED (not promised), a consultation ARRANGED on the agent's calendar, a webinar
 *      PLANNED (no session — not promised), a mini-course ARRANGED on a real sequence → the page promises only ready / arranged
 *      items → items recorded under the action ledger. Planner down / escalated, fair-housing line, entitlement refusal, one unit.
 *   C. THE PUBLISH GATE — a non-approver refused (C5); a promised STAGED video refuses by name; a promised PLANNED item refuses
 *      (positive control); once the video's assigned approver approves it (video staging) the gate passes and the approval
 *      lands on every promised item; tenant-pinned.
 *   D. THE JOURNEY — the real capture door: the person is assigned to the form's agent, the promise is the funnel's primary,
 *      the follow-through runs ONCE (agent task, portal card; a double post repeats nothing).
 *   E. RETRY + UNDELIVERED-ASSET RECOVERY — the first delivery fails (no provider in a proof) → the sweep retries failed steps
 *      and delivers the bundle (primary + video + arrangements); a promised secondary that goes missing → asset_missing → the
 *      sweep's recovery re-produces it FIRST and the same sweep delivers; a staged video PRIMARY keeps the page unpublished,
 *      the recovery backs off, then records it ready and tells the agent — and never publishes.
 *   F. EXPERT PROMPTS — planner, checklist writer, video script writer (compliance-first) carry the preamble standard.
 *   G. WIRING (stripped source) — the gate before the ledgered activation; recovery before the promise loop; follow-through
 *      only for a new promise; the ledger action; the session-gated action. Positive controls on every scan.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { createMagnetFunnel, funnelBundleFor, recoverMagnetFunnelAssets, FUNNEL_DELIVERABLE_KINDS, FUNNEL_STEP_KINDS, FUNNEL_ITEM_ROLES, FUNNEL_ITEM_FULFILMENTS, FUNNEL_ITEM_STATUSES, FUNNEL_TIMELINE_OPTIONS, MAGNET_FUNNEL_PLANNER_SYSTEM, FUNNEL_CHECKLIST_SYSTEM, FUNNEL_VIDEO_SCRIPT_SYSTEM, type FunnelDeps, type MagnetFunnelPlanDraft, type ChecklistDraft, type MagnetFunnelBrief } from "../lib/lead-magnets/magnet-funnel"
import { PROMISE_ASSET_KINDS, recordPromisedDeliverable, sweepUndeliveredPromises, type PromiseDeps } from "../lib/lead-magnets/promised-deliverables"
import { publishLeadMagnet, captureFormSubmission } from "../lib/kernel/lead-magnets"

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
// The kernel's fire-and-forget audit echoes (createLeadMagnet → sentinelWrite → emitKernelEvent) reach server-only modules that
// cannot load under tsx; Node 22 raises an UNHANDLED rejection as a crash. The established pattern (test:lead-magnet-creation,
// test:autonomous-marketing): RECORD them — and here, prove every one is that echo, never this lane's code.
// A proof never reaches the live database: the service client's two variables are removed for this process (names only — no
// value is read or printed), so a default that would build one (enrollContact) fails deterministically and is RETRIED with a seam.
delete process.env.NEXT_PUBLIC_SUPABASE_URL
delete process.env.SUPABASE_SERVICE_ROLE_KEY
const backgroundRejections: string[] = []
Error.stackTraceLimit = 60 // the echo's own frame (write-sentinel) sits below the module loader's frames
process.on("unhandledRejection", (e) => { backgroundRejections.push(String((e as Error)?.stack ?? e)) })

const B1 = "00000000-0000-4000-8000-0000000000b1", B2 = "00000000-0000-4000-8000-0000000000b2"
const AG = "00000000-0000-4000-8000-0000000000d1", U1 = "00000000-0000-4000-8000-0000000000a1", U2 = "00000000-0000-4000-8000-0000000000a2"
const SEQ = "00000000-0000-4000-8000-00000000005e"
const C9 = "00000000-0000-4000-8000-0000000000c9"
const NOW = new Date()
const later = (min: number) => new Date(NOW.getTime() + min * 60_000)
const ORIGIN = "https://app.example.com"

/** SQL comments out (`--` to end of line, outside single-quoted strings) — scripts/strip-comments.ts is a TS scanner. */
function stripSqlComments(sql: string): string {
  return sql.split("\n").map((l) => { let s = false; for (let i = 0; i < l.length; i++) { if (l[i] === "'") s = !s; else if (!s && l[i] === "-" && l[i + 1] === "-") return l.slice(0, i) } return l }).join("\n")
}

function world(extra: Record<string, any[]> = {}, opts: Parameters<typeof memSupabase>[1] = {}) {
  const db = memSupabase({
    brokerages: [{ id: B1, name: "Elm Realty", slug: "elm-realty", deleted_at: null }, { id: B2, name: "Other Realty", slug: "other", deleted_at: null }],
    agents: [{ id: AG, brokerage_id: B1, user_id: U1, is_active: true }],
    users: [{ id: U1, brokerage_id: B1, first_name: "Ann", user_type: "agent" }, { id: U2, brokerage_id: B1, first_name: "Uma", user_type: "agent" }],
    calendar_provider_accounts: [{ id: "cal-1", brokerage_id: B1, user_id: U1, is_active: true }],
    campaign_sequences: [{ id: SEQ, brokerage_id: B1, name: "First-time buyer basics", is_active: true }],
    campaign_sequence_steps: [1, 2, 3, 4].map((i) => ({ id: `step-${i}`, sequence_id: SEQ })),
    market_data: [{ id: "md-1", brokerage_id: B1, zip_code: "78704", city: "Austin", data_date: "2026-10-20", source_type: "rentcast" }],
    contacts: [{ id: C9, brokerage_id: B1, email: "vic@visitor.test", first_name: "Vic", has_login: false, city: "Austin" }],
    lead_capture_forms: [], lead_magnet_deliverables: [], lead_magnet_funnel_items: [], lead_magnet_promises: [], ai_video_projects: [],
    agent_action_ledger: [], lifecycle_events: [], notifications: [], tasks: [], transparency_updates: [], form_submissions: [], manager_signals: [], activities: [],
    ...extra,
  }, { uuidIds: true, stampCreatedAt: true, ...opts })
  ;(db as any).rpc = async () => ({ data: null, error: null })
  return db
}
const rows = (db: any, t: string) => (db.tables[t] ?? []) as any[]

const CHECKLIST: ChecklistDraft = {
  insufficient: false, insufficient_reason: null, title: "The First-Home Readiness Checklist", intro: "Five moves that make your first home search calmer. Tick them off at your pace.",
  sections: [
    { heading: "Before you shop", items: [{ text: "Check your credit report", why: "so nothing surprises a lender" }, { text: "Set a monthly budget you are comfortable with", why: "it frames every search" }, { text: "Gather two years of income documents", why: "pre-approval goes faster" }] },
    { heading: "Getting ready", items: [{ text: "Talk to a lender about pre-approval", why: "sellers take it seriously" }, { text: "List your must-haves and nice-to-haves", why: "it keeps tours focused" }, { text: "Ask your agent how offers work locally", why: "rules vary by state" }] },
  ],
  closing: "Questions? Reply any time — I'm happy to help.",
}

const PLAN: MagnetFunnelPlanDraft = {
  insufficient: false, insufficient_reason: null,
  name: "Your First-Home Head Start", magnet_type: "buyer_guide",
  big_promise: "Walk into your first home search knowing exactly what to do",
  angle: "Renting feels simpler until you see how simple the first steps really are", awareness_stage: "problem_aware",
  landing: { headline: "Know your first five moves before you tour a single home", subhead: "A one-page plan, a short video and a no-pressure chat — built for renters ready to buy.", cta: "Send my head start", description: "Practical first steps from Elm Realty.", faq: [{ question: "Do I need to be pre-approved first?", answer: "It helps — the checklist shows when and why." }] },
  situation_keys: ["timeline", "move_side", "current_home"],
  extra_questions: [{ label: "How old are you?", type: "number", options: [] }, { label: "What price range feels comfortable?", type: "text", options: [] }],
  deliverables: [
    { key: "readiness_checklist", kind: "checklist", role: "primary", title: "The First-Home Readiness Checklist", promise_line: "The First-Home Readiness Checklist — your first five moves on one page", outline: ["credit", "budget", "pre-approval"], why: "a quick, specific win first (reciprocity)" },
    { key: "preapproval_video", kind: "video", role: "deliverable", title: "What pre-approval really means", promise_line: "Save $10,000 with this 90-second video", outline: ["what it is", "what lenders look at"], why: "authority" },
    { key: "first_chat", kind: "consultation", role: "deliverable", title: "A no-pressure first conversation", promise_line: "Book now — only 3 spots left!", outline: [], why: "commitment" },
    { key: "live_qa", kind: "webinar", role: "deliverable", title: "Live first-time buyer Q&A", promise_line: "Join our live Q&A", outline: [], why: "social proof" },
    { key: "buyer_course", kind: "mini_course", role: "deliverable", title: "First-time buyer basics", promise_line: "A short email course", outline: [], why: "consistency" },
  ],
  thank_you: { headline: "Your head start is on its way", message: "Check your inbox — your checklist is there now.", next_step_line: "Want a hand? Ann is happy to help." },
  steps: { personal_video: false, calendar_link: true, portal_task: { title: "Tick off your first move", summary: "Start with step one on your checklist." }, education_sequence: true },
  follow_up: { first_value_moment: "the checklist arrives", signals_to_watch: ["opened the checklist", "watched the video"], handoff_when: "they ask about a specific home or book a chat" },
  learning: { hypothesis: "renters convert on a one-page plan before a call", primary_metric: "visit_to_submit" },
}

const BRIEF: MagnetFunnelBrief = { brokerageId: B1, agentId: AG, createdBy: U1, audience: "First-time buyers who rent in Austin", benefit: "Know exactly what to do before you shop", outcome: "Buy a first home with confidence", area: "Austin", territory: { zip: "78704", city: "Austin", state: "TX" }, baseUrl: ORIGIN }

/** Every funnel seam over the same in-memory client, recording calls. The video director seam writes a pending project row. */
function seams(db: any, over: Partial<FunnelDeps> = {}) {
  const calls = { prompts: [] as string[], checklists: 0, renders: [] as any[], scripts: 0, commissions: [] as any[], enroll: [] as any[], personal: [] as any[] }
  const projectFor = new Map<string, string>()
  let n = 0
  const deps: FunnelDeps = {
    now: NOW, client: db,
    entitlement: async () => ({ allowed: true, reason: "ok" }),
    plan: async (a) => { calls.prompts.push(a.prompt); return PLAN },
    writeChecklist: async () => { calls.checklists++; return CHECKLIST },
    finalize: async (a) => ({ ok: true, texts: a.texts }),
    renderDocument: async (a) => { calls.renders.push(a); n++; return { ok: true, pdfUrl: `https://cdn.example.com/client-docs/b1/checklist-${n}.pdf`, documentId: null, error: null } },
    writeVideoScript: async () => { calls.scripts++; return { insufficient: false, insufficient_reason: null, title: "What pre-approval really means", script: "Hi, I'm Ann with Elm Realty. Pre-approval sounds formal, but it is simply a lender looking at your income, savings and credit before you shop, so you know your comfortable range. Here is what they look at, and what to bring. If anything is unclear, reply and ask me — I'm happy to help. Elm Realty.", on_screen: ["Income", "Savings", "Credit"] } },
    commissionVideo: async (a) => {
      calls.commissions.push(a)
      let id = projectFor.get(a.discriminator)
      if (!id) { id = randomUUID(); projectFor.set(a.discriminator, id); db.tables.ai_video_projects.push({ id, brokerage_id: B1, agent_id: AG, video_type: "education", status: "pending_review", approval_status: "pending_review", compliance_status: "pending", video_url: null, contact_id: null, learning_module_id: null, audience_type: null, usage_intent: null, approved_by: null, is_published: false, video_metadata: {} }) }
      return { ok: true, status: "staged", videoProjectId: id }
    },
    enroll: async (a) => { calls.enroll.push(a); return { success: true, enrollmentId: "enr-1" } },
    commissionPersonalVideo: async (a) => { calls.personal.push(a); return { ok: true, status: "staged", videoProjectId: "pv-1" } },
    draftBrand: async () => ({}),
    ...over,
  }
  deps.deliverable = { now: NOW, funnel: deps, ...(over.deliverable ?? {}) }
  return { deps, calls }
}

/** What video staging needs to say "approved by an assigned approver" (lib/video/video-staging.ts stagedPublicationVerdict). */
function approveVideo(db: any, id: string, url = "https://cdn.example.com/videos/preapproval.mp4") {
  const r = rows(db, "ai_video_projects").find((v) => v.id === id)
  Object.assign(r, { status: "completed", approval_status: "approved", approved_by: U1, compliance_status: "passed", video_url: url, video_metadata: { staging: { version: 1, staged_at: NOW.toISOString(), playable: { ok: true, basis: "finished" }, rights: { ok: true, checks: [] }, branding: { ok: true, violations: [], basis: "brand-compliance" }, audience: "public_marketing", channels: ["landing_page"], approver: { user_ids: [U1], primary_user_ids: [U1], basis: "owner", assigned_at: NOW.toISOString() }, blockers: [] } } })
}

function promiseDeps(emails: any[], over: Partial<PromiseDeps> = {}): PromiseDeps {
  return {
    prepare: async () => { throw new Error("a per-person render must not run for a funnel") },
    sendEmail: async (p) => { emails.push(p); return { success: true, providerKey: "sendgrid", messageId: `m-${emails.length}` } },
    recordActivity: async () => ({ ok: true }), finalize: async (a) => ({ ok: true, text: a.text }), publishSignal: async () => ({ ok: true }),
    ...over,
  }
}

async function main() {
  // ── A ────────────────────────────────────────────────────────────────────
  section("A. the contract: vocabularies and the database gate (m921)")
  check("deliverable kinds = C4's asset kinds (spread, never restated) + calculator, webinar, mini_course, consultation", PROMISE_ASSET_KINDS.every((k) => (FUNNEL_DELIVERABLE_KINDS as readonly string[]).includes(k)) && ["calculator", "webinar", "mini_course", "consultation"].every((k) => (FUNNEL_DELIVERABLE_KINDS as readonly string[]).includes(k)) && FUNNEL_DELIVERABLE_KINDS.length === PROMISE_ASSET_KINDS.length + 4)
  {
    const vocab = raw("scripts/check-vocabularies.ts")
    const m = vocab.match(/\n  contacts: \{[\s\S]*?\n    timeline: \[([^\]]*)\]/)
    const live = (m?.[1] ?? "").split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean).sort()
    check("the form's timeline options store EXACTLY the live contacts_timeline_check buckets (derived from the generated cache — never 30/60/90)", live.length > 0 && JSON.stringify(FUNNEL_TIMELINE_OPTIONS.map((o) => o.value).sort()) === JSON.stringify(live), `${live.join(",")}`)
  }
  {
    const files = ["supabase/migrations/m921-lead-magnet-funnel-items-c21.sql"]
    const sqlRaw = raw(files[0])
    const sql = stripSqlComments(sqlRaw)
    const line1 = sqlRaw.split("\n")[0]
    check("m921 line 1 is the lane stamp OR the applied stamp (the rule, not the waypoint)", /^-- WRITTEN, NOT APPLIED \(wave 148, lane 148G\) — the integrator applies via Supabase MCP; DROP INDEX \/ DROP COLUMN are owner SQL-editor$/.test(line1) || /^-- ── APPLIED LIVE /.test(line1), line1)
    const list = (name: string) => { const mm = sql.match(new RegExp(`${name}\\s+CHECK \\(\\w+ IN \\(([^)]*)\\)\\)`)); return (mm?.[1] ?? "").split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean) }
    const eq = (a: readonly string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
    check("m921 kind CHECK = deliverable kinds + step kinds (code and database hold one list)", eq([...FUNNEL_DELIVERABLE_KINDS, ...FUNNEL_STEP_KINDS], list("lead_magnet_funnel_items_kind_check")), list("lead_magnet_funnel_items_kind_check").join(","))
    check("m921 role / fulfilment / status CHECKs = the code's vocabularies", eq(FUNNEL_ITEM_ROLES, list("lead_magnet_funnel_items_role_check")) && eq(FUNNEL_ITEM_FULFILMENTS, list("lead_magnet_funnel_items_fulfilment_check")) && eq(FUNNEL_ITEM_STATUSES, list("lead_magnet_funnel_items_status_check")))
    check("m921: ready is validated + hosted; arranged carries a mechanism; a planned / withdrawn item is never promised", /lead_magnet_funnel_items_ready_shape[\s\S]*validation ->> 'ok'\) = 'true'[\s\S]*asset_url ~ '\^https:\/\/'/.test(sql) && /lead_magnet_funnel_items_arranged_shape[\s\S]*arrangement \? 'mechanism'/.test(sql) && /lead_magnet_funnel_items_promised_shape[\s\S]*NOT promised OR status NOT IN \('planned', 'withdrawn'\)/.test(sql))
    check("m921: tenant RLS read, writes revoked from authenticated / anon, UNIQUE (form_id, item_key), FKs to the produced assets", /ENABLE ROW LEVEL SECURITY/.test(sql) && /brokerage_id = public\.current_user_brokerage_id\(\)/.test(sql) && /REVOKE INSERT, UPDATE, DELETE ON public\.lead_magnet_funnel_items FROM authenticated, anon/.test(sql) && /UNIQUE \(form_id, item_key\)/.test(sql) && /REFERENCES public\.ai_video_projects/.test(sql) && /REFERENCES public\.lead_magnet_deliverables/.test(sql))
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.lead_capture_forms_require_ready_deliverable"))
    check("m921 trigger function: m898's magnet-type rule kept, a declared funnel primary needs its READY deliverable, and no promised item may be unready", /NEW\.magnet_type IN \('buyer_guide', 'seller_guide', 'market_report', 'home_valuation'\)/.test(fn) && /NEW\.settings -> 'funnel' -> 'primary'\) IS NOT NULL/.test(fn) && /i\.promised AND i\.status NOT IN \('ready', 'arranged'\)/.test(fn) && /SECURITY DEFINER/.test(fn))
    check("positive control: the vocabulary parser reads a planted list", eq(["x", "y"], (() => { const s = "foo_check CHECK (kind IN ('x', 'y'))"; const mm = s.match(/foo_check\s+CHECK \(\w+ IN \(([^)]*)\)\)/); return (mm?.[1] ?? "").split(",").map((v) => v.trim().replace(/^'|'$/g, "")) })()))
  }

  // ── B ────────────────────────────────────────────────────────────────────
  section("B. the build: brief → planner → landing page in the tenant site → form → primary (C11) → secondaries → ledger")
  const db = world()
  const s1 = seams(db)
  const r1 = await createMagnetFunnel(BRIEF, s1.deps)
  if (!r1.ok) { check("the funnel is built", false, JSON.stringify(r1)); return finish() }
  const pkg = r1.package
  const form = rows(db, "lead_capture_forms").find((f) => f.id === pkg.landing_page.form_id)
  const items = rows(db, "lead_magnet_funnel_items").filter((i) => i.form_id === pkg.landing_page.form_id)
  const item = (k: string) => items.find((i) => i.item_key === k)
  check("the planner was handed the AVAILABILITY facts it may promise against (calendar, no session, the sequence with its lessons, market data)", /Agent calendar connected: yes/.test(s1.calls.prompts[0] ?? "") && /Live session scheduled: no/.test(s1.calls.prompts[0] ?? "") && /First-time buyer basics \(4 lessons\)/.test(s1.calls.prompts[0] ?? "") && /Verified market data for the territory: yes/.test(s1.calls.prompts[0] ?? ""))
  check("LANDING PAGE inside the tenant's website (/site/<brokerage>/lm/<slug>), with the funnel's attribution, as a DRAFT (inactive)", pkg.landing_page.path === `/site/elm-realty/lm/${pkg.landing_page.slug}` && (pkg.landing_page.url ?? "").startsWith(`${ORIGIN}/site/elm-realty/lm/${pkg.landing_page.slug}?utm_campaign=magnet-`) && form?.is_active === false && form?.settings?.lifecycle?.state === "draft")
  const fieldNames = pkg.form.fields.map((f) => f.name)
  // RE-ASSERTED (wave 149, lane 149D — owner ruling 16): the waypoint "their one question" (biggest_question, an open textarea) is
  // gone; the RULE is identity + the situation facts + the situation's OWN qualifying questions, and no generic open question.
  check("FORM: identity (first, last, email, phone) + the situation facts (timeline, buying/selling, own/rent) + the situation's own qualifying questions — never a generic open question (ruling 16)", ["first_name", "last_name", "email", "phone", "timeline", "move_side", "current_home", "buy_before_sell", "financing_stage"].every((n) => fieldNames.includes(n)) && !fieldNames.includes("biggest_question") && !pkg.form.fields.some((f) => f.type === "textarea") && JSON.stringify(rows(db, "lead_capture_forms")[0]?.fields?.map((f: any) => f.name)) === JSON.stringify(fieldNames))
  check("FORM: the timeline answer maps onto contacts.timeline buckets; buying/selling onto contacts.contact_type", (() => { const t = pkg.form.fields.find((f) => f.name === "timeline")!; const s = pkg.form.fields.find((f) => f.name === "move_side")!; return t.maps_to?.column === "contacts.timeline" && t.maps_to.values["In the next 1–3 months"] === "1-3_months" && s.maps_to?.column === "contacts.contact_type" && s.maps_to.values.Selling === "seller" })())
  check("FORM: a question about a protected characteristic (age) is DROPPED and said; a fair qualifier is kept", !pkg.form.fields.some((f) => /old are you/i.test(f.label)) && pkg.form.fields.some((f) => /price range/i.test(f.label) && f.purpose === "qualifier") && pkg.notes.some((n) => /How old are you\?" asks about a protected characteristic/.test(n)))
  check("FORM: the C15 consent spec (service delivery required, marketing optional, every channel explicit, the creator) and the OWNER (agents.id + users.id) → assignment", pkg.form.consent.contract === "C15" && pkg.form.consent.purposes.service_delivery.required === true && pkg.form.consent.purposes.marketing.required === false && JSON.stringify(pkg.form.consent.channels) === JSON.stringify(["email", "sms", "voice", "direct_mail"]) && pkg.form.consent.creator_user_id === U1 && pkg.form.owner.agent_id === AG && pkg.form.owner.agent_user_id === U1 && form?.agent_id === AG)
  const d1 = rows(db, "lead_magnet_deliverables").find((d) => d.form_id === pkg.landing_page.form_id)
  check("PRIMARY created WITH the magnet (C11): the real checklist producer wrote a tenant-branded, validated PDF — READY", d1?.kind === "checklist" && d1?.status === "ready" && /^https:\/\//.test(d1?.asset_url ?? "") && s1.calls.checklists === 1 && s1.calls.renders.length === 1 && /Equal Housing Opportunity/.test(s1.calls.renders[0].spec.disclaimer) && s1.calls.renders[0].spec.sections.some((x: any) => (x.bullets ?? []).some((b: string) => b.startsWith("☐ Check your credit report"))), JSON.stringify(d1))
  check("…and the funnel's primary item mirrors it (ready, deliverable_id), promised", item("readiness_checklist")?.role === "primary" && item("readiness_checklist")?.status === "ready" && item("readiness_checklist")?.deliverable_id === d1?.id && item("readiness_checklist")?.promised === true)
  check("VIDEO: a compliance-first script commissioned through the director → STAGED (awaiting its approver) and NOT promised", item("preapproval_video")?.status === "staged" && item("preapproval_video")?.promised === false && !!item("preapproval_video")?.video_project_id && s1.calls.commissions.length === 1 && /staged/.test(item("preapproval_video")?.error ?? ""))
  check("…its promise line carried an invented figure ($10,000) — replaced, and said", !/\$/.test(item("preapproval_video")?.promise_line ?? "") && pkg.notes.some((n) => /carried a figure/.test(n)))
  check("CONSULTATION: ARRANGED on the agent's connected calendar — the promise line is the arrangement's own sentence (not the model's fake scarcity)", item("first_chat")?.status === "arranged" && item("first_chat")?.promised === true && item("first_chat")?.arrangement?.mechanism === "calendar_offer" && /Ann will send you a few open times from their calendar within one business day/.test(item("first_chat")?.promise_line ?? "") && !/spots left/i.test(item("first_chat")?.promise_line ?? ""))
  check("WEBINAR: no session scheduled → PLANNED with the reason, never promised", item("live_qa")?.status === "planned" && item("live_qa")?.promised === false && /no live session is scheduled/.test(item("live_qa")?.error ?? ""))
  check("MINI-COURSE: ARRANGED on the real 4-lesson sequence (enrolment at capture)", item("buyer_course")?.status === "arranged" && item("buyer_course")?.arrangement?.mechanism === "sequence_enrollment" && item("buyer_course")?.arrangement?.sequence_id === SEQ && /4-lesson/.test(item("buyer_course")?.promise_line ?? ""))
  check("STEPS: no calendar step duplicating the consultation, no education step duplicating the mini-course; the portal task arranged (not promised)", !items.some((i) => i.kind === "calendar_link" || i.kind === "education_sequence") && items.find((i) => i.kind === "portal_task")?.status === "arranged" && items.find((i) => i.kind === "portal_task")?.promised === false)
  check("THE PAGE PROMISES ONLY WHAT IS REAL: its 'what you get' lines = the primary + the arranged consultation + the mini-course (no staged video, no planned webinar)", JSON.stringify(form?.landing_content?.bullets) === JSON.stringify([item("readiness_checklist")?.promise_line, item("first_chat")?.promise_line, item("buyer_course")?.promise_line]), JSON.stringify(form?.landing_content?.bullets))
  check("the package reports publishable (every promised item ready / arranged) with the follow-up policy (arbiter, no fixed timetable), attribution and learning", pkg.publishable.ok === true && pkg.follow_up_policy.fixed_schedule === false && /arbiter/.test(String(pkg.follow_up_policy.decided_by)) && /magnet-/.test(String(pkg.attribution.utm_campaign)) && pkg.learning.primary_metric === "visit_to_submit" && pkg.portal_task?.status === "arranged")
  check("EVIDENCE: the funnel's items recorded under the ledger (marketing.lead_magnet_funnel.create) beside the draft's own ledger row", rows(db, "agent_action_ledger").some((l) => l.action === "marketing.lead_magnet_funnel.create" && l.status === "executed") && rows(db, "agent_action_ledger").some((l) => l.action === "marketing.lead_magnet.ai_draft"))
  {
    const dbx = world()
    const before = rows(dbx, "lead_capture_forms").length
    const refused = await createMagnetFunnel(BRIEF, seams(dbx, { entitlement: async () => ({ allowed: false, reason: "budget", message: "AI budget reached" }) }).deps)
    check("ENTITLEMENT refused → nothing written (fail closed)", !refused.ok && refused.stage === "entitlement" && rows(dbx, "lead_capture_forms").length === before && rows(dbx, "lead_magnet_funnel_items").length === 0)
    const dby = world({}, { refuse: { lead_magnet_funnel_items: "permission denied for table lead_magnet_funnel_items" } })
    const unit = await createMagnetFunnel(BRIEF, seams(dby).deps)
    check("ONE UNIT: the items cannot be recorded → the landing page is not kept (counted delete)", !unit.ok && unit.stage === "items" && rows(dby, "lead_capture_forms").length === 0 && /not kept/.test(unit.ok ? "" : unit.error), unit.ok ? "" : unit.error)
    const dbz = world()
    const down = await createMagnetFunnel(BRIEF, seams(dbz, { plan: async () => { throw new Error("gateway down") }, deliverable: { produceGuide: async () => ({ status: "ready", assetUrl: "https://cdn.example.com/g.pdf", title: "Guide", coverNote: { subject: "Your guide", title: "Guide", body: "Here it is." }, validation: { ok: true } }) } }).deps)
    check("PLANNER DOWN → the deterministic baseline funnel still stands (primary for a buyer brief = the guide, the consultation arranged), said", down.ok && down.package.from_ai === false && down.package.deliverables.find((d) => d.role === "primary")?.kind === "guide" && down.package.deliverables.some((d) => d.kind === "consultation" && d.status === "arranged") && down.package.notes.some((n) => /planner was unavailable/.test(n)), down.ok ? "" : down.error)
    const dbf = world()
    const fh = await createMagnetFunnel(BRIEF, seams(dbf, { plan: async () => ({ ...PLAN, landing: { ...PLAN.landing, headline: "Perfect for families — the safest neighborhood checklist" } }) }).deps)
    check("FAIR HOUSING in the writing path: a flagged headline falls back to the baseline line, said (never shipped)", fh.ok && !/families|safest/i.test(fh.package.landing_page.headline) && fh.package.notes.some((n) => /headline: fair-housing finding/.test(n)))
    const esc = await createMagnetFunnel(BRIEF, seams(world(), { plan: async () => ({ ...PLAN, insufficient: true, insufficient_reason: "the audience is defined by a protected characteristic" }), deliverable: { produceGuide: async () => ({ status: "ready", assetUrl: "https://cdn.example.com/g.pdf", title: "Guide", coverNote: { subject: "Your guide", title: "Guide", body: "Here it is." }, validation: { ok: true } }) } }).deps)
    check("ESCALATION: the planner refusing the brief is said and the honest baseline stands for a person to review", esc.ok && esc.package.from_ai === false && esc.package.notes.some((n) => /planner escalated: the audience is defined by a protected characteristic/.test(n)))
  }

  // ── C ────────────────────────────────────────────────────────────────────
  section("C. the publish gate: promised = ready or truthfully arranged; the publisher is a C5 approver")
  const formId = pkg.landing_page.form_id
  const pub = (actor: string, b = B1) => publishLeadMagnet({ magnetId: formId, brokerageId: b, channels: ["landing_page"], actorUserId: actor, baseUrl: ORIGIN }, { client: db as never })
  const p0 = await pub(U2)
  check("a publisher C5 does not permit is refused", !p0.success && /not an approver/.test(p0.error ?? ""), p0.error)
  item("preapproval_video").promised = true
  const p1 = await pub(U1)
  check("a PROMISED video that is still STAGED refuses the publish, by name — nothing activates", !p1.success && /What pre-approval really means \(video\): staged/.test(p1.error ?? "") && form?.is_active === false, p1.error)
  item("preapproval_video").promised = false
  item("live_qa").promised = true
  const p2 = await pub(U1)
  check("positive control: a PROMISED planned webinar refuses too (the verdict is not blind)", !p2.success && /Live first-time buyer Q&A \(webinar\): planned/.test(p2.error ?? ""), p2.error)
  item("live_qa").promised = false
  const p3 = await pub(U1, B2)
  check("tenant-pinned: another tenant cannot publish (or even see) this funnel", !p3.success && form?.is_active === false)
  item("preapproval_video").promised = true
  approveVideo(db, item("preapproval_video").video_project_id)
  const p4 = await pub(U1)
  check("once the video's ASSIGNED approver approves it (video staging), the gate re-reads it READY and the page publishes", p4.success && form?.is_active === true && item("preapproval_video")?.status === "ready" && item("preapproval_video")?.asset_url === "https://cdn.example.com/videos/preapproval.mp4", p4.error)
  check("the approval lands on EVERY promised item (counted) and the publish ledger names the funnel", items.filter((i) => i.promised).length === 4 && items.filter((i) => i.promised).every((i) => i.approved_by === U1) && rows(db, "agent_action_ledger").some((l) => l.action === "marketing.lead_magnet.publish" && (l.detail?.funnel?.promised ?? []).length === 4))

  // ── D ────────────────────────────────────────────────────────────────────
  section("D. the journey: the real capture door → assignment → the funnel's promise → follow-through once")
  const cap = await captureFormSubmission({ formId, brokerageId: B1, source: "landing_page", tcpaConsentGiven: true, submissionData: { first_name: "Pat", last_name: "Renter", email: "pat@renter.test", timeline: "In the next 1–3 months", move_side: "Buying", financing_stage: "Talking to a lender" } }, { client: db as never })
  const pat = rows(db, "contacts").find((c) => c.email === "pat@renter.test")
  check("the capture lands and the NEW contact is assigned to the form's agent (ownership drives assignment)", cap.success && pat?.agent_id === AG, JSON.stringify(cap))
  check("the person's situation answers are kept with the submission (the specific data about the requester)", rows(db, "form_submissions").some((s) => s.contact_id === pat?.id && s.submission_data?.financing_stage === "Talking to a lender" && s.submission_data?.timeline === "In the next 1–3 months"))
  const prom = rows(db, "lead_magnet_promises").find((p) => p.contact_id === pat?.id)
  check("the promise is the FUNNEL's primary (a checklist, not the type's guide), made against its ready deliverable", prom?.asset_kind === "checklist" && prom?.asset_ref?.deliverable_id === d1?.id && prom?.asset_ref?.funnel === true, JSON.stringify(prom))
  const steps0 = prom?.asset_ref?.funnel_steps?.steps ?? []
  check("FOLLOW-THROUGH ran at capture: the agent's consultation task (due in 24h), ONE portal card; the enrolment failed with no service client in a proof (recorded, retried below)", rows(db, "tasks").filter((t) => t.contact_id === pat?.id && t.assigned_to_agent_id === AG && /Offer Pat a time to talk/.test(t.title)).length === 1 && rows(db, "transparency_updates").filter((t) => t.contact_id === pat?.id && t.update_type === "lead_magnet_next_step").length === 1 && steps0.some((x: any) => x.key === "first_chat" && x.status === "done") && steps0.some((x: any) => x.key === "buyer_course" && x.status === "failed"), JSON.stringify(steps0))
  const tasksBefore = rows(db, "tasks").length
  await captureFormSubmission({ formId, brokerageId: B1, source: "landing_page", tcpaConsentGiven: true, submissionData: { first_name: "Pat", last_name: "Renter", email: "pat@renter.test" } }, { client: db as never })
  check("a double post is ONE request: the promise is reused and no step repeats (no second task, no second card)", rows(db, "lead_magnet_promises").filter((p) => p.contact_id === pat?.id).length === 1 && rows(db, "tasks").length === tasksBefore)

  // ── E ────────────────────────────────────────────────────────────────────
  section("E. retry + undelivered-asset recovery")
  const emails: any[] = []
  const firstStatus = rows(db, "lead_magnet_promises").find((p) => p.id === prom?.id)?.status
  check("the capture's own delivery attempt did not claim success without a provider (failed / missing, retried — never 'delivered')", firstStatus !== "delivered", firstStatus)
  const s2 = seams(db)
  const sweep1 = await sweepUndeliveredPromises(db as never, { now: later(30), deps: promiseDeps(emails), funnel: s2.deps })
  const prom1 = rows(db, "lead_magnet_promises").find((p) => p.id === prom?.id)
  check("RETRY: the sweep re-ran the failed step (the enrolment now lands on the real sequence)", (sweep1.funnel?.stepRetries ?? 0) >= 1 && s2.calls.enroll.some((e) => e.sequenceId === SEQ && e.contactId === pat?.id) && (prom1?.asset_ref?.funnel_steps?.steps ?? []).every((x: any) => x.status === "done"), JSON.stringify(sweep1))
  check("RETRY: …and delivered THE BUNDLE in one send — the checklist, the approved video, the consultation and the course lines", prom1?.status === "delivered" && emails.length === 1 && emails[0].text.includes(d1.asset_url) && emails[0].text.includes("https://cdn.example.com/videos/preapproval.mp4") && /Ann will send you a few open times/.test(emails[0].text) && /4-lesson email course/.test(emails[0].text), JSON.stringify(prom1?.status))
  check("EVIDENCE closes the chain per item (funnel_items: the video url, each arrangement's mechanism)", (prom1?.evidence?.funnel_items ?? []).some((x: any) => x.key === "preapproval_video" && x.url) && (prom1?.evidence?.funnel_items ?? []).some((x: any) => x.key === "first_chat" && x.mechanism === "calendar_offer"))
  // a PROMISED secondary goes missing (its hosted file is lost) → the promise is never delivered without it
  Object.assign(item("preapproval_video"), { status: "failed", error: "the hosted file was removed", attempts: 0, next_attempt_at: null })
  await captureFormSubmission({ formId, brokerageId: B1, source: "landing_page", tcpaConsentGiven: true, submissionData: { first_name: "Quinn", last_name: "Q", email: "quinn@q.test" } }, { client: db as never })
  const quinn = rows(db, "contacts").find((c) => c.email === "quinn@q.test")
  const pq = rows(db, "lead_magnet_promises").find((p) => p.contact_id === quinn?.id)
  check("a PROMISED secondary that is missing holds the delivery: asset_missing, named — never 'delivered'", pq?.status === "asset_missing" && /the funnel promised what is not ready yet: What pre-approval really means \(video: failed/.test(pq?.last_error ?? ""), `${pq?.status}: ${pq?.last_error}`)
  const emailsBefore = emails.length
  const sweep2 = await sweepUndeliveredPromises(db as never, { now: later(60), deps: promiseDeps(emails), funnel: seams(db).deps })
  check("RECOVERY FIRST: the sweep re-checked the video against staging (approved) → ready, told the agent", (sweep2.funnel?.recovered ?? 0) >= 1 && item("preapproval_video")?.status === "ready" && rows(db, "notifications").some((nn) => nn.type === "lead_magnet_asset_recovered" && nn.user_id === U1), JSON.stringify(sweep2.funnel))
  check("…and the SAME sweep delivered the held promise", rows(db, "lead_magnet_promises").find((p) => p.id === pq?.id)?.status === "delivered" && emails.length === emailsBefore + 1, JSON.stringify(sweep2))
  // a staged video PRIMARY: the page stays unpublished; recovery backs off, then records it ready — and never publishes
  const db2 = world()
  const PLAN2: MagnetFunnelPlanDraft = { ...PLAN, name: "Pre-approval in 90 seconds", deliverables: [{ key: "video_primary", kind: "video", role: "primary", title: "Pre-approval, explained in 90 seconds", promise_line: "A 90-second video from Ann", outline: ["what it is"], why: "authority" }], steps: { personal_video: true, calendar_link: false, portal_task: null, education_sequence: false } }
  const s3 = seams(db2, { plan: async () => PLAN2 })
  const r2 = await createMagnetFunnel({ ...BRIEF, preferredDeliverables: ["video"] }, s3.deps)
  if (!r2.ok) { check("the video-primary funnel is built", false, JSON.stringify(r2)); return finish() }
  const f2 = r2.package.landing_page.form_id
  const prim2 = () => rows(db2, "lead_magnet_funnel_items").find((i) => i.form_id === f2 && i.role === "primary")
  const form2 = () => rows(db2, "lead_capture_forms").find((f) => f.id === f2)
  check("a video PRIMARY is created STAGED with the magnet; the package says it cannot publish yet, by name", prim2()?.status === "staged" && rows(db2, "lead_magnet_deliverables").some((d) => d.form_id === f2 && d.status === "staged" && d.kind === "video") && r2.package.publishable.ok === false)
  const pp = await publishLeadMagnet({ magnetId: f2, brokerageId: B1, channels: ["landing_page"], actorUserId: U1, baseUrl: ORIGIN }, { client: db2 as never, deliverable: { now: NOW, funnel: s3.deps } })
  check("…the publish refuses (C11: the asset this page promises is not ready)", !pp.success && /not ready/.test(pp.error ?? "") && form2()?.is_active === false, pp.error)
  const rec1 = await recoverMagnetFunnelAssets(db2 as never, { now: later(5), deps: s3.deps })
  check("RECOVERY BACKS OFF while the video awaits its approver (attempt recorded, next attempt scheduled, the same project re-checked — no second commission row)", rec1.stillOpen >= 1 && (prim2()?.attempts ?? 0) >= 1 && !!prim2()?.next_attempt_at && rows(db2, "ai_video_projects").length === 1, JSON.stringify(rec1))
  approveVideo(db2, rows(db2, "ai_video_projects")[0].id, "https://cdn.example.com/videos/primary.mp4")
  const rec2 = await recoverMagnetFunnelAssets(db2 as never, { now: later(24 * 60), deps: s3.deps })
  check("once approved, the recovery records the primary READY (its C11 deliverable too) and tells the agent", rec2.recovered >= 1 && prim2()?.status === "ready" && rows(db2, "lead_magnet_deliverables").some((d) => d.form_id === f2 && d.status === "ready" && d.kind === "video") && rows(db2, "notifications").some((nn) => nn.type === "lead_magnet_asset_recovered"), JSON.stringify(rec2))
  check("…and NEVER publishes: the page is still a draft until a person publishes it", form2()?.is_active === false)
  const pp2 = await publishLeadMagnet({ magnetId: f2, brokerageId: B1, channels: ["landing_page"], actorUserId: U1, baseUrl: ORIGIN }, { client: db2 as never, deliverable: { now: NOW, funnel: s3.deps } })
  check("the person publishes once the asset is real", pp2.success && form2()?.is_active === true, pp2.error)
  const pr2 = await recordPromisedDeliverable(db2 as never, { brokerageId: B1, formId: f2, submissionId: randomUUID(), contactId: C9, magnetType: form2()?.magnet_type, now: NOW, funnel: s3.deps })
  check("the PERSONAL VIDEO step: a reel commissioned for THIS person, STAGED for the agent's approval — never auto-sent", pr2.ok && pr2.promised && s3.calls.personal.length === 1 && s3.calls.personal[0].contactId === C9 && (rows(db2, "lead_magnet_promises")[0]?.asset_ref?.funnel_steps?.steps ?? []).some((x: any) => x.kind === "personal_video" && /never auto-sent/.test(x.reason ?? "")))
  {
    const b = await funnelBundleFor(db as never, { brokerageId: B2, formId })
    check("tenant-pinned: another tenant's read of this funnel's bundle sees nothing", b.bundle.assets.length === 0 && b.bundle.arrangements.length === 0)
  }

  // ── F ────────────────────────────────────────────────────────────────────
  section("F. expert prompts (the wave-148 standard: a brilliant marketer, grounded facts)")
  check("planner: ROLE · MANDATE · BUSINESS CONTEXT · THE PERSON YOU SERVE · FACTS · CREATIVE BRIEF · DECISION · OUTPUT CONTRACT · COMPLIANCE BOUNDARY · ESCALATION", ["ROLE", "MANDATE", "BUSINESS CONTEXT", "THE PERSON YOU SERVE", "THE FACTS YOU MAY RELY ON", "CREATIVE BRIEF", "THE DECISION YOU OWN", "OUTPUT CONTRACT", "COMPLIANCE BOUNDARY", "ESCALATION RULE"].every((h) => MAGNET_FUNNEL_PLANNER_SYSTEM.includes(h)))
  check("planner: any kind (not a book), promises only against the availability block, no invented figure, no protected question, no dark patterns, consent is not its own", /Not a book/.test(MAGNET_FUNNEL_PLANNER_SYSTEM) && /webinar ONLY if a session is scheduled/.test(MAGNET_FUNNEL_PLANNER_SYSTEM) && /Never invent a statistic/.test(MAGNET_FUNNEL_PLANNER_SYSTEM) && /Never ask about age, marital or family status/.test(MAGNET_FUNNEL_PLANNER_SYSTEM) && /No dark patterns/.test(MAGNET_FUNNEL_PLANNER_SYSTEM) && /Consent wording is NOT yours/.test(MAGNET_FUNNEL_PLANNER_SYSTEM))
  for (const [name, p] of [["checklist writer", FUNNEL_CHECKLIST_SYSTEM], ["video script writer", FUNNEL_VIDEO_SCRIPT_SYSTEM]] as const) {
    check(`${name}: ROLE · BUSINESS CONTEXT · FACTS · DECISION · OUTPUT CONTRACT · COMPLIANCE BOUNDARY · ESCALATION`, ["ROLE", "BUSINESS CONTEXT", "THE FACTS YOU MAY RELY ON", "THE DECISION YOU OWN", "OUTPUT CONTRACT", "COMPLIANCE BOUNDARY", "ESCALATION RULE"].every((h) => p.includes(h)))
  }
  check("video script: compliance-first — fair housing WRITTEN IN, not scanned after (CLAUDE.md §5)", /WRITTEN IN, NOT SCANNED AFTER/.test(FUNNEL_VIDEO_SCRIPT_SYSTEM) && /No legal, tax or lending advice/.test(FUNNEL_CHECKLIST_SYSTEM))

  // ── G ────────────────────────────────────────────────────────────────────
  section("G. wiring (stripped source)")
  const kern = code("lib/kernel/lead-magnets.ts")
  const pubBody = kern.slice(kern.indexOf("export async function publishLeadMagnet("), kern.indexOf("KERNEL COMMAND 2b") > 0 ? kern.indexOf("async function enqueueLeadMagnetCard(") : undefined)
  const gateAt = pubBody.indexOf("funnelPublishGate("), ledgerAt = pubBody.indexOf("withActionLedger<"), approvalAt = pubBody.indexOf("recordFunnelApproval(")
  check("publishLeadMagnet runs the C21 gate BEFORE the ledgered activation and records the funnel approval INSIDE it", gateAt > 0 && ledgerAt > gateAt && approvalAt > ledgerAt && approvalAt < pubBody.indexOf(".update({ is_active: true"))
  const pd = code("lib/lead-magnets/promised-deliverables.ts")
  const sweepBody = pd.slice(pd.indexOf("export async function sweepUndeliveredPromises("))
  check("the sweep runs the asset RECOVERY before its promise loop (a recovered asset is delivered by the same sweep)", sweepBody.indexOf("recoverMagnetFunnelAssets(") > 0 && sweepBody.indexOf("recoverMagnetFunnelAssets(") < sweepBody.indexOf("for (const p of"))
  const recBody = pd.slice(pd.indexOf("export async function recordPromisedDeliverable("), pd.indexOf("export type PromiseEmailSender"))
  check("the follow-through runs only for a NEW promise (after the insert, never on a reused one)", recBody.indexOf("followThroughMagnetFunnel(") > recBody.indexOf("from(\"lead_magnet_promises\").insert(") && recBody.indexOf("followThroughMagnetFunnel(") > recBody.lastIndexOf("reused: true"))
  const fn = code("lib/lead-magnets/magnet-funnel.ts")
  check("createMagnetFunnel: entitlement before the planner; the items under withActionLedger('marketing.lead_magnet_funnel.create'); routed features only", fn.indexOf("mayUseAndAfford(") > 0 && fn.indexOf("mayUseAndAfford(") < fn.indexOf("MAGNET_FUNNEL_PLANNER_SYSTEM, prompt") && /action: "marketing\.lead_magnet_funnel\.create"/.test(fn) && /feature: "lead_magnet_draft"/.test(fn) && /feature: "video_script_generation"/.test(fn) && !/generateText\(|new OpenAI|anthropic\.messages/.test(fn))
  check("NEVER PUBLISHES from the recovery: no is_active write in the funnel module", !/is_active:\s*true/.test(fn))
  check("positive control: the same scan sees a planted activation", /is_active:\s*true/.test(fn + "\nawait svc.from('lead_capture_forms').update({ is_active: true })"))
  const act = code("app/actions/lead-magnets-actions.ts")
  const actBody = act.slice(act.indexOf("export async function createMagnetFunnelAction("), act.indexOf("export async function cloneLeadMagnetAction("))
  check("the action is session-gated: tenant, agent and creator from getAgentContext — no tenant in its input", /getAgentContext\(\)/.test(actBody) && /brokerageId: ctx\.brokerageId, agentId: ctx\.agentId, createdBy: ctx\.userId/.test(actBody) && !/input\.brokerage/.test(actBody))
  const mr = ["topics", "producer", "research", "prompts"].map((f) => code(`lib/market-reports/${f}.ts`)).join("\n")
  check("ruling 10 cross-check: no market-report module reads the topic bank (the full proof is test:market-report-producer §E)", !/["'`]content_topic_bank["'`]|pickTopics\(/.test(mr))
  // WAVE 148Z (lane 148G Outside-lane 1a): the funnel form's DECLARED consent (FunnelConsentSpec, wording "rendered_by_c15")
  // reaches the ONE component — the landing page reads settings.funnel.consent and the form hands its channels to useConsentBoxes.
  const lm = code("app/lm/[slug]/page.tsx"), gcf = code("app/components/lead-magnet-forms/GenericCaptureForm.tsx")
  const lmWires = (s: string) => /settings\?\.funnel\?\.consent/.test(s) && /wording === "rendered_by_c15"/.test(s) && /consentChannels=\{funnelChannels/.test(s)
  check("the funnel's C15 consent spec reaches the ONE component: /lm/[slug] reads settings.funnel.consent (wording rendered_by_c15) and GenericCaptureForm renders its channels through useConsentBoxes",
    lmWires(lm) && /"id, name, slug, fields[^"]*settings"/.test(lm) && /useConsentBoxes\("lead_magnet", consentBrandName, consentChannels/.test(gcf) && /<ConsentBoxes\b/.test(gcf))
  check("positive control: the wiring finder rejects a page that reads the spec but never hands it to the form", !lmWires(lm.replace(/consentChannels=\{funnelChannels/g, "data-x={funnelChannels")))
  await new Promise((r) => setTimeout(r, 50))
  check(`every background rejection (${backgroundRejections.length}) is the kernel's fire-and-forget audit echo (write-sentinel), none from the funnel's own code`, backgroundRejections.every((s) => /write-sentinel\.ts/.test(s)), backgroundRejections.find((s) => !/write-sentinel\.ts/.test(s))?.split("\n").slice(0, 6).join(" | "))

  finish()
}

function finish() {
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  console.log("\nBlind spots (published beside the number):")
  for (const b of [
    "the model, the PDF renderer and the video director are seams; their own proofs cover them (test:asset-production, test:video-pipeline-truth, test:ai-routing-coverage) — the live AI output quality of the planner is not measured here",
    "m921's trigger is proven from its SQL text; the in-memory client runs no triggers (the integrator's VERIFY block reads pg_proc / pg_trigger live)",
    "the capture door's own first delivery uses the real dispatchEmail, which has no provider in a proof — the delivered email is proven through the sweep's seamed sender",
    "the enrolment's default (enrollContact) needs the service client — in memory it fails and is RETRIED with a seam; the sequence engine's sending is its own proof",
    "the situation answers are stored on form_submissions; mapping them onto contacts.timeline / contact_type is lane 148B's door (Outside-lane) — the form declares maps_to",
    "a staged video that becomes ready AFTER a person's promise was delivered is not re-sent to them (it is delivered to later requests) — recorded as Still open",
    "the calendar 'offer' is an agent task + the AI ISA's appointment finder — there is no public self-serve booking page in the repo (MISSING, recorded); the promise line says exactly that",
  ]) console.log(`  · ${b}`)
  if (failed) { console.log("\nFAILURES:"); for (const f of failures) console.log(`  - ${f}`); console.log("\n❌ MAGNET_FUNNEL_FAIL"); process.exit(1) }
  console.log("\n✅ MAGNET_FUNNEL_PASS — a lead magnet is a complete, creative conversion funnel: landing page in the tenant site, a consented form with identity + situation + owner, deliverables of any kind (staged allowed, promised only when ready or truthfully arranged), thank-you and follow-through, retried and recovered — and nothing publishes or is delivered that does not exist")
}

main().catch((e) => { console.error(e); process.exit(1) })
