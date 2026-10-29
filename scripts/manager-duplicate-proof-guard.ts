#!/usr/bin/env tsx
/**
 * scripts/manager-duplicate-proof-guard.ts — test:manager-duplicate-proofs (wave 146, lane 146G; owner ruling 15:
 * "Duplicate actions that don't have a provable survivor shouldn't be retired until there is proof they aren't
 * beneficial").
 *
 * THE CENSUS (re-derived every run, never pinned): every name exported as a function by MORE THAN ONE module under
 * app/actions/** ("use server" doors), read from STRIPPED source; importers resolved module-aware across runtime
 * code (named, barrel, dynamic `await import`, `import(...).x`, namespace) — the method of lanes 144I / 145I.
 * THE LEDGER (DUPLICATE_ACTION_LEDGER below): one row per name, the proof of what was done with it.
 *   L1 every CURRENT duplicate name has a row — a new duplicate cannot appear unrecorded;
 *   L2 a name whose row says RETIRED is not a duplicate again (a deleted twin is not back);
 *   L3 every retired TWIN carries the eight steps (file/function → intended behaviour → candidate survivor → proof the
 *      survivor covers it → callers migrated → unique behaviour preserved → retired with a tombstone → guards re-run),
 *      no longer exports the name, and leaves a TOMBSTONE COMMENT (not a string) naming `survivor file:line` where that
 *      file exports the name on exactly that line (LAW 1's tombstone-survivor rule, derived);
 *   L4 every KEPT row names its class and its dependency; a `both_wired` row must still have ≥ 2 wired sides, so a side
 *      that lost its importers is re-triaged instead of sitting here mislabelled;
 *   L5 a kept name that stopped being a duplicate is printed BURNED (the row is stale — remove it), never failed:
 *      the rule is "every duplicate has a proof", not "these 36 names exist" (no waypoint pin).
 * POSITIVE CONTROLS: an unrecorded synthetic name is caught (L1); a twin that still exports is caught (L3); a tombstone
 * naming the wrong line is caught; a tombstone inside a string literal is not accepted as a tombstone.
 * BLIND SPOTS (published): name-level, app/actions only (a duplicate under lib/** or with a different name is not
 * seen); an action reached only through a string-keyed registry ("send-message": sendMessage) reads as unimported —
 * those are classed self_used by hand; importers counted from runtime code only (scripts excluded) for L4.
 */
import { readFileSync, existsSync } from "node:fs"
import { join, dirname, resolve, relative } from "node:path"
import { stripComments } from "./strip-comments"
import { walkTs, runtimeFiles } from "./runtime-roots"

let pass = 0, fail = 0
const fails: string[] = []
const check = (name: string, cond: unknown, detail?: string) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; fails.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const ROOT = process.cwd()

// ── THE LEDGER ──────────────────────────────────────────────────────────────────────────────────
type KeptClass = "both_wired" | "homonym" | "self_used" | "lane_domain" | "money_legal" | "owner_decision"
interface RetiredTwin {
  /** The deleted twin's module. */
  twin: string
  /** `file:line` of the survivor's export — the tombstone names exactly this. */
  survivor: string
  steps: { file_function: string; intended_behaviour: string; candidate_survivor: string; survivor_covers: string; callers_migrated: string; unique_behaviour: string; retired_with_tombstone: string; guards_rerun: string }
}
interface LedgerRow {
  verdict: "kept" | "retired"
  /** kept: why it stays. */
  class?: KeptClass
  dependency?: string
  /** The candidate survivor if one exists, else null. */
  survivor?: string | null
  retiredTwins?: RetiredTwin[]
}

const RERUN = "test:manager-duplicate-proofs, test:no-orphan-actions, test:use-server-exports, test:sessionless-use-server-census and every proof naming the touched file, run one at a time (lane 146G notes)"
/** @proofSeam the census is held to this ledger; lane 146G's notes carry the same rows as a table. */
export const DUPLICATE_ACTION_LEDGER: Readonly<Record<string, LedgerRow>> = {
  addContactNote: { verdict: "kept", class: "owner_decision", survivor: "app/actions/contacts.ts:559", dependency: "communications.ts:391 (0 importers) pushes the note to GoHighLevel (syncContactToGHL + addGHLContactNote) before the local save; contacts.ts:559 is the canonical contact_notes writer (2 importers). Whether notes still sync to GHL is an owner decision (144I Still open 3): merging adds a vendor egress to the canonical writer, retiring drops it." },
  approveSocialPost: { verdict: "kept", class: "lane_domain", survivor: null, dependency: "both wired — listing-media.ts:329 (listing social panel) and social-media-automation.ts:464 (command center, social dashboard); app/actions/social* is lane 146E's domain and the approval door is contract C5 (approverFor)." },
  checkCompliance: { verdict: "kept", class: "homonym", survivor: null, dependency: "different functions: ai-content-generation.tsx:1953 fair-housing-scans generated TEXT and writes ai_generated_content.compliance_*; link-to-video.ts:251 runs an AI compliance review of a VIDEO SCRIPT (used twice in its own file). Neither covers the other; the text scan's caller is the content composer (routing, not retirement)." },
  checkInAttendee: { verdict: "retired", retiredTwins: [{
    twin: "app/actions/open-house-automation.ts", survivor: "app/actions/seller-open-house.ts:661",
    steps: {
      file_function: "app/actions/open-house-automation.ts:1651 checkInAttendee (wave-146 base bf67aa63)",
      intended_behaviour: "record an open-house attendee check-in against the event's brokerage",
      candidate_survivor: "app/actions/seller-open-house.ts:661 checkInAttendee — the kiosk check-in the event-day tab calls",
      survivor_covers: "same open_house_attendees insert with the event-derived brokerage and the (event, email) dedupe, plus: refuses a completed / cancelled event, REQUIRES TCPA consent, records it on contact_consent_events, emits OPEN_HOUSE_ATTENDEE_CAPTURED",
      callers_migrated: "the twin had 0 importers (named / dynamic / namespace / barrel, runtime and scripts) and no string-keyed mention — nothing to migrate",
      unique_behaviour: "two behaviours only, both deliberately NOT merged: tcpa_consent defaulted to TRUE when optInFollowUp was omitted (consent without an affirmative act — the survivor refuses it) and an interest level stamped at sign-in (the survivor leaves it NULL by design; the follow-up path scores interest). mapInterestLevelText stays (recordVisitor uses it)",
      retired_with_tombstone: "open-house-automation.ts DIGITAL CHECK-IN block — tombstone names app/actions/seller-open-house.ts:661",
      guards_rerun: RERUN,
    } }] },
  completeMilestone: { verdict: "kept", class: "money_legal", survivor: "lib/kernel/transactions.ts:913 completeTransactionMilestone", dependency: "both twins are unwired (copilot.ts:425 user-client update by id; transactions.ts:165 → TransactionService). The kernel command is the convergence target but is NOT yet a provable survivor for a public door: it updates transaction_milestones by id on the service client with no tenant predicate. deal_coordinator: pin the tenant first, then converge (deal domain, consequential)." },
  completeTask: { verdict: "kept", class: "homonym", survivor: null, dependency: "journey-tasks.ts:79 completes a CONTACT PORTAL journey task (client_portal_activity + client_documents; 0 importers — its caller is the portal journey, lane 146C's app/portal/**); tasks.ts:364 completes a staff task row (tasks; 1 importer). Different tables, different audiences." },
  connectSocialAccount: { verdict: "kept", class: "lane_domain", survivor: null, dependency: "both twins (social-media-automation.ts:114, social-publishing.ts:153) are in app/actions/social*, lane 146E's domain, and hold social credentials (OAuth) — a credential surface is consequential (ruling 14); lane E decides." },
  createOpenHouseEvent: { verdict: "kept", class: "both_wired", survivor: null, dependency: "open-house-automation.ts:1090 (acquisition open-house card) and seller-open-house.ts:589 (seller listing marketing tab) — two surfaces; consolidation is a product decision (listing_concierge)." },
  deleteSocialPost: { verdict: "kept", class: "lane_domain", survivor: null, dependency: "three implementations; listing-media.ts:346 and social-media-automation.ts:1328 are wired, social-publishing.ts:425 is not — app/actions/social* is lane 146E's domain." },
  disconnectProvider: { verdict: "kept", class: "both_wired", survivor: null, dependency: "accounting-sync.ts:89 and connections/connection-center.ts:397 are both imported by the accounting provider card (and the connection center); accounting books are Finance's (consequential) — converge with finance_manager, not here." },
  disconnectSocialAccount: { verdict: "kept", class: "lane_domain", survivor: null, dependency: "social-media-automation.ts:217 (0 importers) vs social-publishing.ts:204 (profile settings) — lane 146E's domain, credential surface." },
  executeAITool: { verdict: "kept", class: "self_used", survivor: "app/actions/ai-tools-hub.ts:96", dependency: "workflows.ts:32 is called by executeWorkflow in its own file (:975); the workflow runner must move to the hub's tenanted-spend door first (campaign_orchestrator)." },
  executeWorkflow: { verdict: "kept", class: "both_wired", survivor: null, dependency: "multi-persona.ts:584 (admin automations) and workflows.ts:973 (content studio) — both wired surfaces." },
  generateBlogPost: { verdict: "kept", class: "self_used", survivor: "app/actions/blog.ts:69", dependency: "ai-content-generation.tsx:1404 is called by bulkGenerateContent in its own file (:2766); bulk generation must call blog.ts's writer first (blog-writer-merge rail)." },
  generateVideoScript: { verdict: "kept", class: "both_wired", survivor: null, dependency: "three wired doors: link-to-video.ts:87 (content studio), video/generate-script.ts:143 (video create), video-generation.ts:1260 (agent superpowers, video assistant)." },
  getClosingChecklist: { verdict: "kept", class: "money_legal", survivor: null, dependency: "transactions.ts:195 (0 importers) → TransactionService; ai-closing-workflow.ts:193 (closing workflow tab). Closing / compliance checklists are deal_coordinator's consequential domain." },
  getContactDocuments: { verdict: "kept", class: "homonym", survivor: null, dependency: "both unwired; they read DIFFERENT tables (documents.ts says so beside its copy) — no survivor covers both; routing, not retirement." },
  getContentCalendar: { verdict: "kept", class: "homonym", survivor: null, dependency: "ai-content-generation.tsx:2263 is the only reader of content_calendar (written by generateContentPlan in the same file); content-studio.ts:283 reads content_ideas. Retiring the first would leave content_calendar readerless (orphan doctrine: wire the reader)." },
  getDocumentFolders: { verdict: "kept", class: "homonym", survivor: null, dependency: "documents.ts:1375 counts virtual category folders over a contact's client_documents; dotloop-integration.ts:1036 lists document_folders rows for the tenant. Different questions." },
  getNeighborhoodData: { verdict: "kept", class: "self_used", survivor: null, dependency: "ai-content-generation.tsx:2948 is called by enhancedGenerateListingDescription (:3152); listing-landing.ts:260 serves the public listing page." },
  getShowingRequests: { verdict: "kept", class: "both_wired", survivor: null, dependency: "seller-showings.ts:335 (listing showings page) and smart-insights.ts:750 (portal showings manager) — seller vs buyer audiences." },
  getSocialAccounts: { verdict: "kept", class: "both_wired", survivor: null, dependency: "listing-media.ts:290 (listing media page) and social-publishing.ts:114 (profile page); social-publishing is lane 146E's domain." },
  getSocialPosts: { verdict: "kept", class: "lane_domain", survivor: null, dependency: "listing-media.ts:280 is wired; social-publishing.ts:225 is not — lane 146E's domain." },
  getVendorRecommendations: { verdict: "kept", class: "homonym", survivor: null, dependency: "ai-vendor-management.ts:102 is a per-JOB AI matcher (unwired; the partners panel note records why it was unhooked); marketing-package-automation.ts:319 is a transaction's bench read (wired). Different functions; the matcher's caller is the vendor booking flow." },
  getVideoProjects: { verdict: "kept", class: "homonym", survivor: null, dependency: "three distinct reads remain: listing-media.ts:233 (one listing's projects; 2 importers), podcast-generation.ts:909 (finished videos for the snippet / podcast wizards; 2 importers), video/create-video-project.ts:490 (the tenant's projects, optional agent; survivor of the retired listing-video twin).",
    retiredTwins: [{
      twin: "app/actions/listing-video.ts", survivor: "app/actions/video/create-video-project.ts:490",
      steps: {
        file_function: "app/actions/listing-video.ts:413 getVideoProjects(agentId) (wave-146 base bf67aa63)",
        intended_behaviour: "list an agent's ai_video_projects, newest first",
        candidate_survivor: "app/actions/video/create-video-project.ts:490 getVideoProjects(_brokerageId, agentId)",
        survivor_covers: "the same read of ai_video_projects with the same agent filter and order, plus requireCaller, the SESSION brokerage predicate and a 50-row bound",
        callers_migrated: "the twin had 0 importers and no string-keyed runtime mention (scripts/video-repurpose-wiring-simulator.ts pins the SURVIVOR's export) — nothing to migrate",
        unique_behaviour: "none worth keeping: no session gate, no tenant predicate (a caller-supplied agent id), unbounded result",
        retired_with_tombstone: "listing-video.ts GET VIDEO PROJECTS block — tombstone names app/actions/video/create-video-project.ts:490",
        guards_rerun: RERUN,
      } }] },
  getVideoQueue: { verdict: "retired", retiredTwins: [{
    twin: "app/actions/video-generation.ts", survivor: "app/actions/link-to-video.ts:507",
    steps: {
      file_function: "app/actions/video-generation.ts:631 getVideoQueue(_agentId) (wave-146 base bf67aa63)",
      intended_behaviour: "read the caller's video generation queue",
      candidate_survivor: "app/actions/link-to-video.ts:507 getVideoQueue — the content studio's queue reader",
      survivor_covers: "session-gated, tenant-scoped read of video_generation_queue (brokerage + its teams) with the project's rendered file embedded",
      callers_migrated: "the twin had 0 importers and no string-keyed mention — nothing to migrate",
      unique_behaviour: "none: after its auth gate it always returned [] (its own note: the queue has no agent_id column)",
      retired_with_tombstone: "video-generation.ts — tombstone names app/actions/link-to-video.ts:507",
      guards_rerun: RERUN,
    } }] },
  getVideoTemplates: { verdict: "kept", class: "both_wired", survivor: null, dependency: "listing-media.ts:243 (listing media page) and video-generation.ts:447 (video templates page)." },
  markAllRead: { verdict: "kept", class: "both_wired", survivor: null, dependency: "notification-actions.ts:17 (notifications page) and notifications.ts:115 (notification bell) — one capability on two doors; converging them is a presentation change for the notifications owner." },
  recordSellerResponse: { verdict: "kept", class: "homonym", survivor: null, dependency: "track-offer-lifecycle.ts:401 is the activities-derived lifecycle mirror, documented there (:396-399) as a DIFFERENT function from the wired record-seller-response.ts:122; offer domain (consequential — an acceptance propagates into the transaction lane)." },
  requestShowing: { verdict: "kept", class: "both_wired", survivor: null, dependency: "showings.ts:20 (7 importers incl. portal client-action dispatch and voice) and smart-insights.ts:714 (3 portal / CRM importers)." },
  saveProperty: { verdict: "kept", class: "both_wired", survivor: null, dependency: "idx-search.ts:199 (property search / detail pages) and smart-insights.ts:843 (portal property detail)." },
  scheduleContent: { verdict: "kept", class: "homonym", survivor: null, dependency: "ai-content-generation.tsx:2289 writes content_calendar from generated content; content-studio.ts:312 writes campaign_calendar (workflows dynamic import). Different tables." },
  scheduleListingAppointment: { verdict: "kept", class: "homonym", survivor: null, dependency: "listing-lifecycle.ts:40 books a CONTACT appointment (optional real Zoom on the booker's scope, starts listing prep); seller-listing/execution-engine.ts:214 books the listing-stage appointment ≥ 5 days out (voice). Different behaviour; listing_concierge decides convergence." },
  scheduleOpenHouse: { verdict: "kept", class: "homonym", survivor: null, dependency: "open-house-automation.ts:27 creates an open-house event with times; seller-listing/execution-engine.ts:2150 transitions the listing MLS_ACTIVE → OPEN_HOUSE_EVENT (voice). Different behaviour." },
  sendMessage: { verdict: "kept", class: "self_used", survivor: "app/actions/ai-communication-hub.ts:54", dependency: "workflows.ts:502 is the workflow tool map's \"send-message\" step (string-keyed in its own file); the step must route through the comms hub's dispatch gates first (lane 146B's communications)." },
  submitVendorInvoice: { verdict: "kept", class: "money_legal", survivor: null, dependency: "vendor-payments.ts:297 flips an existing invoice draft → submitted (0 importers); multi-persona.ts:1967 creates an invoice from a booking (vendor bookings panel). Different money operations — Finance." },
  unsaveProperty: { verdict: "kept", class: "both_wired", survivor: null, dependency: "idx-search.ts:322 (persona properties dashboard) and smart-insights.ts:888 (portal property detail)." },
  updateSocialPost: { verdict: "kept", class: "lane_domain", survivor: null, dependency: "social-media-automation.ts:1371 is wired (post composer); social-publishing.ts:374 is not — lane 146E's domain." },
}
const KEPT_CLASSES: readonly KeptClass[] = ["both_wired", "homonym", "self_used", "lane_domain", "money_legal", "owner_decision"]

// ── THE CENSUS ──────────────────────────────────────────────────────────────────────────────────
const rel = (p: string) => relative(ROOT, resolve(ROOT, p)).split("\\").join("/")
const runtime = runtimeFiles(".").map(rel)
const src = new Map<string, string>()
const read = (f: string) => { let s = src.get(f); if (s === undefined) { s = stripComments(readFileSync(join(ROOT, f), "utf8")); src.set(f, s) } return s }
function resolveSpec(from: string, spec: string, known: Set<string>): string | null {
  let base: string
  if (spec.startsWith("@/")) base = spec.slice(2)
  else if (spec.startsWith(".")) base = rel(join(dirname(from), spec))
  else return null
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (known.has(c)) return c
  return null
}
/** target file → name → importer files (runtime only). */
function importerMap(files: readonly string[]): Map<string, Map<string, Set<string>>> {
  const known = new Set(files)
  const out = new Map<string, Map<string, Set<string>>>()
  const add = (t: string, n: string, by: string) => { const m = out.get(t) ?? new Map(); out.set(t, m); const s = m.get(n) ?? new Set(); m.set(n, s); s.add(by) }
  for (const f of files) {
    const s = read(f)
    if (!/import|export\s*\{/.test(s)) continue
    for (const m of s.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) { const t = resolveSpec(f, m[2], known); if (t) for (const n of m[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, "")).filter(Boolean)) add(t, n, f) }
    for (const m of s.matchAll(/export\s+\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) { const t = resolveSpec(f, m[2], known); if (t) for (const n of m[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)) add(t, n, f) }
    for (const m of s.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g)) { const t = resolveSpec(f, m[2], known); if (t) for (const n of m[1].split(",").map((x) => x.trim().split(/\s*:\s*/)[0]).filter(Boolean)) add(t, n, f) }
    for (const m of s.matchAll(/import\(\s*["']([^"']+)["']\s*\)\s*\)?\s*\.\s*([A-Za-z0-9_]+)/g)) { const t = resolveSpec(f, m[1], known); if (t) add(t, m[2], f) }
    for (const m of s.matchAll(/import\s+\*\s+as\s+([A-Za-z0-9_]+)\s+from\s*["']([^"']+)["']/g)) { const t = resolveSpec(f, m[2], known); if (t) for (const u of s.matchAll(new RegExp(`\\b${m[1]}\\.([A-Za-z0-9_]+)`, "g"))) add(t, u[1], f) }
  }
  return out
}
const exportsFn = (text: string, name: string) => new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b|export\\s+const\\s+${name}\\s*=`).test(text)
/** name → modules exporting it as a function (stripped source). */
function census(files: readonly string[], textOf: (f: string) => string): Map<string, string[]> {
  const by = new Map<string, string[]>()
  for (const f of files) for (const m of textOf(f).matchAll(/export\s+async\s+function\s+(\w+)/g)) by.set(m[1], [...(by.get(m[1]) ?? []), f])
  return new Map([...by].filter(([, v]) => v.length > 1))
}
/** L3 for one twin over the given texts. */
function twinProblems(name: string, t: RetiredTwin, rawOf: (f: string) => string | null): string[] {
  const out: string[] = []
  const twinRaw = rawOf(t.twin)
  if (twinRaw === null) return [`${t.twin} does not exist`]
  const twinStripped = stripComments(twinRaw)
  if (exportsFn(twinStripped, name)) out.push(`${t.twin} still exports ${name}`)
  if (!twinRaw.includes(t.survivor)) out.push(`${t.twin} has no tombstone naming ${t.survivor}`)
  else if (twinStripped.includes(t.survivor)) out.push(`${t.twin} names ${t.survivor} in CODE (a string), not in a tombstone comment`)
  if (!/TOMBSTONE/.test(twinRaw)) out.push(`${t.twin} carries no TOMBSTONE marker`)
  const [sf, sl] = [t.survivor.slice(0, t.survivor.lastIndexOf(":")), Number(t.survivor.slice(t.survivor.lastIndexOf(":") + 1))]
  const survRaw = rawOf(sf)
  if (survRaw === null) out.push(`survivor ${sf} does not exist`)
  else {
    const line = survRaw.split("\n")[sl - 1] ?? ""
    if (!new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).test(line)) out.push(`survivor ${t.survivor} is not where ${name} is exported (line reads: ${line.trim().slice(0, 80)})`)
  }
  const missingSteps = Object.entries(t.steps).filter(([, v]) => typeof v !== "string" || v.trim().length < 20).map(([k]) => k)
  if (missingSteps.length || Object.keys(t.steps).length !== 8) out.push(`eight-step proof incomplete (${missingSteps.join(", ") || `${Object.keys(t.steps).length} steps`})`)
  return out
}

function main() {
  console.log("\nmanager-duplicate-proof-guard — wave 146G, owner ruling 15\n")
  const actionFiles = walkTs(join(ROOT, "app/actions")).map(rel).sort()
  const dups = census(actionFiles, read)
  const ledgerNames = Object.keys(DUPLICATE_ACTION_LEDGER)
  console.log(`census: ${dups.size} names exported by > 1 action module (denominator: ${actionFiles.length} files under app/actions, stripped); ledger: ${ledgerNames.length} rows\n`)

  console.log("L1 — every current duplicate has a proof row")
  const unrecorded = [...dups.keys()].filter((n) => !DUPLICATE_ACTION_LEDGER[n])
  check(`L1 every one of the ${dups.size} duplicate names (derived) has a ledger row`, unrecorded.length === 0, unrecorded.join(", "))
  const synth = new Map(dups); synth.set("__plantedDuplicate", ["app/actions/a.ts", "app/actions/b.ts"])
  check("L1 positive control: a planted unrecorded duplicate is caught", [...synth.keys()].some((n) => !DUPLICATE_ACTION_LEDGER[n]))

  console.log("\nL2/L3 — a retirement carries its proof, its twin is gone, its tombstone names the survivor")
  const rawOf = (f: string) => existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f), "utf8") : null
  for (const [name, row] of Object.entries(DUPLICATE_ACTION_LEDGER)) {
    if (row.verdict === "retired") check(`L2 ${name}: retired — not a duplicate again`, !dups.has(name), (dups.get(name) ?? []).join(", "))
    for (const t of row.retiredTwins ?? []) {
      const p = twinProblems(name, t, rawOf)
      check(`L3 ${name} @ ${t.twin} → ${t.survivor}: eight steps, twin gone, tombstone comment names the survivor's export line`, p.length === 0, p.join("; "))
    }
  }
  const ctlTwin: RetiredTwin = { twin: "app/actions/x.ts", survivor: "app/actions/y.ts:3", steps: { file_function: "x".repeat(25), intended_behaviour: "x".repeat(25), candidate_survivor: "x".repeat(25), survivor_covers: "x".repeat(25), callers_migrated: "x".repeat(25), unique_behaviour: "x".repeat(25), retired_with_tombstone: "x".repeat(25), guards_rerun: "x".repeat(25) } }
  const yFile = "\"use server\"\n\nexport async function doIt() { return 1 }\n"
  const fixture = (xFile: string) => (f: string) => f === "app/actions/x.ts" ? xFile : f === "app/actions/y.ts" ? yFile : null
  check("L3 control: a well-formed retirement passes the same check", twinProblems("doIt", ctlTwin, fixture("// TOMBSTONE: doIt DELETED → survivor\n// app/actions/y.ts:3 doIt\nexport async function other() {}\n")).length === 0, twinProblems("doIt", ctlTwin, fixture("// TOMBSTONE: doIt DELETED → survivor\n// app/actions/y.ts:3 doIt\nexport async function other() {}\n")).join("; "))
  check("L3 positive control: a twin that still exports the name is caught", twinProblems("doIt", ctlTwin, fixture("// TOMBSTONE → app/actions/y.ts:3\nexport async function doIt() {}\n")).some((p) => /still exports/.test(p)))
  check("L3 positive control: a tombstone naming the wrong line is caught", twinProblems("doIt", { ...ctlTwin, survivor: "app/actions/y.ts:1" }, fixture("// TOMBSTONE → app/actions/y.ts:1\n")).some((p) => /is not where/.test(p)))
  check("L3 positive control: a 'tombstone' inside a string literal is not a tombstone", twinProblems("doIt", ctlTwin, fixture("const note = \"TOMBSTONE app/actions/y.ts:3\"\n")).some((p) => /in CODE/.test(p)))

  console.log("\nL4/L5 — a kept duplicate names its class and its dependency")
  const imp = importerMap(runtime)
  const wiredSides = (name: string) => (dups.get(name) ?? []).filter((f) => (imp.get(f)?.get(name)?.size ?? 0) > 0)
  const burned: string[] = []
  for (const [name, row] of Object.entries(DUPLICATE_ACTION_LEDGER)) {
    if (row.verdict !== "kept") continue
    if (!dups.has(name)) { burned.push(name); continue }
    const okClass = !!row.class && KEPT_CLASSES.includes(row.class) && (row.dependency ?? "").length >= 30
    const wired = row.class === "both_wired" ? wiredSides(name) : null
    check(`L4 ${name}: kept — ${row.class}${wired ? ` (${wired.length} wired sides)` : ""}`, okClass && (wired === null || wired.length >= 2), wired && wired.length < 2 ? `only ${wired.join(", ") || "none"} still wired — re-triage` : row.dependency)
  }
  console.log(`  ${burned.length ? `BURNED (no longer duplicates — remove the row): ${burned.join(", ")}` : "BURNED: none"}`)

  const retiredTwins = Object.values(DUPLICATE_ACTION_LEDGER).flatMap((r) => r.retiredTwins ?? []).length
  const kept = Object.values(DUPLICATE_ACTION_LEDGER).filter((r) => r.verdict === "kept").length
  const byClass = KEPT_CLASSES.map((c) => `${c} ${Object.values(DUPLICATE_ACTION_LEDGER).filter((r) => r.verdict === "kept" && r.class === c).length}`).join(" · ")
  console.log(`\ncoverage: ${dups.size} current duplicate names · ${kept} kept (${byClass}) · ${retiredTwins} twins retired with proof`)
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log(`❌ MANAGER_DUPLICATE_PROOFS_FAIL — ${fails.join(" | ")}`); process.exit(1) }
  console.log("✅ MANAGER_DUPLICATE_PROOFS_PASS — every duplicate action has a proof row; every retirement carries its eight steps and a tombstone naming a live survivor")
}

main()
