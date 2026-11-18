#!/usr/bin/env tsx
/**
 * scripts/content-command-center-guard.ts — THE CONTENT AND CHANNEL COMMAND CENTER (wave 154, lane 154G2; directive G7,
 * owner ruling R8). npm run test:content-command-center   ·   --write regenerates docs/architecture/CONTENT-COMMAND-CENTER-CENSUS.md
 *
 *   0  THE CAPABILITY CENSUS, GENERATED: every G7.1 format → its candidate canonical tables → LIVE (scripts/schema-snapshot.ts)
 *      and a real code WRITER (stripped app/ + lib/ source). A format with no live writer is "not available" and may not be
 *      catalogued; a format WITH a producer is either indexed by lib/marketing/content-catalog.ts or carries a stated reason.
 *      Every catalog column exists live, every owner column's FK class (agents vs users) matches SCHEMA_FK_MAP, the topic-use
 *      map equals the live CHECK, the approver mirror equals the Command Center door, and every action names an existing
 *      exported writer that the session door (app/api/marketing/content-command/route.ts) really imports and calls.
 *   1  ONE SEARCH: one topic → a video, an email, a social image, a post and a postcard draft, each with its own id and status.
 *   2  SCOPE: solo agent, team seat, team lead, multi-office head, brokerage owner — the right rows, nothing cross-tenant,
 *      provider cost only for a finance admin, fail closed on an unreadable seat.
 *   3  VIDEO: a failed render is never offered as sendable; a playable one becomes eligible through the REAL Asset Manager →
 *      Campaign Orchestrator signal (lib/kernel/video-coordination.ts publishVideoCoordinationSignals, executed).
 *   4  QR: a changed destination (lib/marketing/qr-governance.ts editQrDestination, executed) stays on the same minted code;
 *      a mail piece printing a QR with no live destination is not releasable.
 *   5  APPROVE / REJECT / PUBLISH: the plan names the exact canonical writer; the writer's own update is proved on its source;
 *      the readback shows the real status (a ready draft never reads as sent).
 *   6  SECURED DOCUMENTS: a deal document is listed only as a link, only when lib/auth/deal-work-ownership.ts says read.
 *   7  THE UI: the component's real calls, read from STRIPPED source, with a positive control for a decorative button.
 * Every execution proof is SIMULATED (scripts/in-memory-supabase.ts; no provider, no network).
 *
 * BLIND SPOTS (published): the writer scan sees `.from("t").insert/upsert(` — writers through an .rpc(), a trigger or a
 * migration backfill read as absent (CLAUDE.md §3), so a "not available" verdict is re-checked by hand in the lane notes;
 * the catalog reads at most `perSourceLimit` (default 60, cap 200) newest rows per source and says so; ownerless
 * admin-only sources (agent_client_messages, lead_magnet_deliverables) are visible only at brokerage scope.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments, blankComments, blankStrings } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { SCHEMA_FK_MAP } from "./schema-fk-map"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import {
  CONTENT_CATALOG_SOURCES, TOPIC_USE_ASSET_TABLE, CATALOG_ACTION_WRITERS,
  resolveCatalogViewer, readContentCatalog, planContentAction, type CatalogRow, type CatalogViewer,
} from "../lib/marketing/content-catalog"
import { publishVideoCoordinationSignals } from "../lib/kernel/video-coordination"
import { mintGovernedQr, editQrDestination, type QrActor } from "../lib/marketing/qr-governance"
import { loadDealWorkAccess } from "../lib/auth/deal-work-ownership"
import { BROKERAGE_FINANCE_ADMIN_USER_TYPES } from "../lib/auth/resolve-user-role"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (p: string) => readFileSync(join(root, p), "utf8")
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) } else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ═══ 0 · THE CENSUS ═══════════════════════════════════════════════════════════════════════════════════════════
interface FormatEntry { group: string; format: string; tables: string[]; catalog?: string[]; excluded?: string }
const FORMAT_CENSUS: FormatEntry[] = [
  { group: "ideas", format: "Topic pool entries / research briefs / source-grounded trends", tables: ["content_topic_bank"], catalog: ["content_topic_bank"] },
  { group: "ideas", format: "Competitor-concept briefs (Refurbish origins, ideas only)", tables: ["competitor_content"], catalog: ["competitor_content"] },
  { group: "ideas", format: "Content Lab idea list", tables: ["content_ideas"], excluded: "PARTIAL — Content Lab idea scratch list (app/actions/content-studio.ts); not yet indexed" },
  { group: "text", format: "AI text drafts (generation history)", tables: ["ai_generated_content"], excluded: "PARTIAL — generation history; the saved artifact is the channel row that IS indexed" },
  { group: "text", format: "Conversation reply drafts (email / SMS / in-app)", tables: ["ai_message_drafts"], catalog: ["ai_message_drafts"] },
  { group: "text", format: "Personal 1:1 messages proposed by managers (email, SMS, voice drop, portal)", tables: ["agent_client_messages"], catalog: ["agent_client_messages"] },
  { group: "text", format: "Sent SMS / message transport log", tables: ["messages"], excluded: "conversation transport (recipient data) — the draft and the proposal are indexed, not the wire log" },
  { group: "text", format: "Live / AI voice and video scripts", tables: ["video_scripts_library"], catalog: ["video_scripts_library"] },
  { group: "text", format: "Agent coaching messages", tables: ["buyer_stage_coaching", "seller_stage_coaching", "call_coaching_insights"], excluded: "coaching addressed to the agent, not tenant-facing content — read on the coaching screens" },
  { group: "email", format: "Branded email campaigns", tables: ["email_campaigns"], catalog: ["email_campaigns"] },
  { group: "email", format: "Newsletters", tables: ["newsletter_campaigns"], catalog: ["newsletter_campaigns"] },
  { group: "social", format: "Social posts per platform (incl. YouTube)", tables: ["social_posts"], catalog: ["social_posts"] },
  { group: "social", format: "Platform's own product posts", tables: ["platform_social_drafts"], excluded: "the platform's own marketing (superadmin), never a tenant's content" },
  { group: "web", format: "Blogs / articles", tables: ["blog_posts"], catalog: ["blog_posts"] },
  { group: "web", format: "SEO / AI-searchable listing landing pages", tables: ["listing_landing_pages"], catalog: ["listing_landing_pages"] },
  { group: "web", format: "Home-value page configuration", tables: ["home_value_page_configs"], excluded: "page configuration, not an artifact" },
  { group: "web", format: "Lead-magnet deliverables (guides, checklists, reports, books)", tables: ["lead_magnet_deliverables"], catalog: ["lead_magnet_deliverables"] },
  { group: "web", format: "Event invitations", tables: ["open_house_invitations"], excluded: "PARTIAL — per-recipient rows of an open-house event (lane 154G3 owns events); not yet indexed" },
  { group: "qr", format: "QR destinations", tables: ["qr_codes"], catalog: ["qr_codes"] },
  { group: "print", format: "Images, carousels, graphics, mailer designs, generated media", tables: ["marketing_assets"], catalog: ["marketing_assets"] },
  { group: "print", format: "Reusable blank templates", tables: ["brand_templates", "content_templates"], excluded: "template library (no audience, no delivery)" },
  { group: "print", format: "Letters, postcards, greeting / handwritten cards, mail pieces", tables: ["direct_mail_campaigns"], catalog: ["direct_mail_campaigns"] },
  { group: "video", format: "D-ID avatar and personalized videos", tables: ["ai_video_projects"], catalog: ["ai_video_projects"] },
  { group: "video", format: "Remotion compositions", tables: ["remotion_composition_renders"], catalog: ["remotion_composition_renders"] },
  { group: "video", format: "Snippets / clips (with thumbnail + caption columns)", tables: ["video_snippets"], catalog: ["video_snippets"] },
  { group: "video", format: "Persona variant renders", tables: ["asset_persona_renders"], excluded: "PARTIAL — per-persona variant of a marketing_assets row; not yet joined onto the asset" },
  { group: "video", format: "Newsletter video renders", tables: ["newsletter_video_renders"], excluded: "PARTIAL — render of a newsletter; not yet indexed" },
  { group: "video", format: "Webinar / TV / CTV creative", tables: [] },
  { group: "audio", format: "Podcast episodes / scripts", tables: ["podcast_episodes"], catalog: ["podcast_episodes"] },
  { group: "book", format: "Books / chapters", tables: ["book_projects"], catalog: ["book_projects"] },
  { group: "report", format: "Market reports (neighborhood market statistics)", tables: ["neighborhood_reports"], catalog: ["neighborhood_reports"] },
  { group: "report", format: "Seller weekly reports / CMA reports", tables: ["seller_weekly_reports", "cma_reports"], excluded: "a per-client valuation / report (financial, recipient data) — read on the listing / contact" },
  { group: "document", format: "Client and deal documents (secured, LINK only)", tables: ["generated_documents"], catalog: ["generated_documents"] },
  { group: "campaign", format: "Campaign bundles", tables: ["campaign_bundles"], catalog: ["campaign_bundles"] },
  { group: "campaign", format: "Bundle dispatch receipts", tables: ["campaign_bundle_dispatches"], excluded: "PARTIAL — a bundle's delivery receipts; not yet joined onto the bundle row" },
  { group: "campaign", format: "Omnipresence / Refurbish variants", tables: ["repurposed_content_log"], catalog: ["repurposed_content_log"] },
  { group: "campaign", format: "Omnipresence pipeline configuration", tables: ["repurpose_pipelines"], excluded: "configuration — its OUTPUTS are indexed (repurposed_content_log)" },
  { group: "campaign", format: "Paid ad creative variations", tables: ["ad_creative_variations"], excluded: "PARTIAL — the Ad OS tab owns paid creative; not yet indexed" },
  { group: "campaign", format: "Listing marketing copy", tables: ["listing_marketing_content"], excluded: "PARTIAL — listing description copy; read on the listing" },
  { group: "journey", format: "Lifetime / anniversary / Ghost touchpoints", tables: ["lifetime_customer_touchpoints"], catalog: ["lifetime_customer_touchpoints"] },
  { group: "journey", format: "Equity report / refinance opportunity", tables: [], excluded: "a manager SIGNAL (equity_milestone), not an artifact — shown as the next action on the linked item" },
  { group: "campaign", format: "Zillow campaign", tables: [] },
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}
function writerFinder(table: string): RegExp { return new RegExp(`from\\(\\s*["'\`]${table}["'\`]\\s*\\)\\s*\\.\\s*(insert|upsert)\\(`) }
// comment-blanked (a tombstone is not a writer, §2) but NOT string-blanked — the table name is a string literal.
const commentFree = [...walk(join(root, "app")), ...walk(join(root, "lib"))].map((f) => ({ f: f.replace(root + "/", ""), code: blankComments(readFileSync(f, "utf8")) }))
function writersOf(table: string): string[] { const re = writerFinder(table); return commentFree.filter((x) => re.test(x.code)).map((x) => x.f) }

function buildCensus() {
  const catalogTables = new Set(CONTENT_CATALOG_SOURCES.map((s) => s.table))
  return FORMAT_CENSUS.map((e) => {
    const tables = e.tables.map((t) => ({ table: t, live: t in SCHEMA_SNAPSHOT, writers: writersOf(t) }))
    const available = tables.some((t) => t.live && t.writers.length > 0)
    return { ...e, tableFacts: tables, available, catalogued: (e.catalog ?? []).filter((t) => catalogTables.has(t)) }
  })
}
function renderCensusDoc(census: ReturnType<typeof buildCensus>): string {
  const lines = [
    "# Content and Channel Command Center — capability census",
    "",
    "GENERATED by `scripts/content-command-center-guard.ts --write` (wave 154, lane 154G2). Do not hand-edit; the guard fails when this file and the code disagree.",
    "",
    "A format is AVAILABLE only when one of its canonical tables is live AND has a code writer (`.from(\"t\").insert/upsert(` in stripped app/ + lib/ source).",
    "Writers through an `.rpc()`, a trigger or a migration backfill are invisible to that scan (CLAUDE.md §3) — a \"no producer\" row is a finding to re-check, not a verdict.",
    "",
    "| Group | Format | Canonical tables (live · has writer) | Available | In the catalog |",
    "|---|---|---|---|---|",
  ]
  for (const c of census) {
    const t = c.tableFacts.length ? c.tableFacts.map((x) => `\`${x.table}\` (${x.live ? "live" : "NOT LIVE"} · ${x.writers.length ? "writer" : "no writer"})`).join("<br>") : "— none —"
    lines.push(`| ${c.group} | ${c.format} | ${t} | ${c.available ? "yes" : "**no producer — not offered**"} | ${c.catalogued.length ? c.catalogued.map((x) => `\`${x}\``).join(", ") : c.excluded ? `no — ${c.excluded}` : "no"} |`)
  }
  lines.push("", `Catalog sources: ${CONTENT_CATALOG_SOURCES.length}. Formats: ${census.length} (${census.filter((c) => c.available).length} available, ${census.filter((c) => !c.available).length} without a producer).`, "")
  return lines.join("\n")
}

function censusSection() {
  console.log("\n[0 · THE CAPABILITY CENSUS — generated from the code]")
  const census = buildCensus()
  for (const c of census) console.log(`    ${c.available ? "●" : "○"} ${c.format.padEnd(78).slice(0, 78)} ${c.tableFacts.map((t) => `${t.table}:${t.live ? "live" : "absent"}/${t.writers.length}w`).join(" ") || "(no table)"}${c.catalogued.length ? "  → catalog" : c.excluded ? "  (excluded, reason stated)" : ""}`)
  const docPath = join(root, "docs/architecture/CONTENT-COMMAND-CENTER-CENSUS.md")
  const doc = renderCensusDoc(census)
  if (process.argv.includes("--write")) { writeFileSync(docPath, doc); console.log(`    wrote ${docPath.replace(root + "/", "")}`) }
  check("the census document is the generator's output (no hand edit, no drift)", existsSync(docPath) && readFileSync(docPath, "utf8") === doc, "run: npx tsx scripts/content-command-center-guard.ts --write")
  check("CONTROL: the writer finder recognises a real writer shape and ignores a tombstone that names one", writerFinder("social_posts").test(blankComments(`await db.from("social_posts").insert({ a: 1 })`)) && !writerFinder("social_posts").test(blankComments(`// TOMBSTONE: was db.from("social_posts").insert(row)`)))

  for (const s of CONTENT_CATALOG_SOURCES) {
    const live = SCHEMA_SNAPSHOT[s.table]
    const missing = live ? s.columns.filter((c) => !live.includes(c)) : s.columns
    check(`catalog source ${s.table}: LIVE, every selected column exists live`, !!live && missing.length === 0, missing.join(", "))
    check(`catalog source ${s.table}: has a real code writer (a format with no producer is never listed)`, writersOf(s.table).length > 0)
    if (s.owner) {
      const fk = SCHEMA_FK_MAP[s.table]?.[s.owner.column]
      check(`catalog source ${s.table}: owner ${s.owner.column} is ${s.owner.kind === "agent" ? "agents.id" : "users.id"} per the live FK map (§3 disjoint ids)`, fk === (s.owner.kind === "agent" ? "agents" : "users"), `fk=${fk ?? "none"}`)
    } else check(`catalog source ${s.table}: ownerless rows declare who may see them`, s.ownerless === "tenant_shared" || s.ownerless === "admin_only")
    check(`catalog source ${s.table}: selects no credential / secret / blob column`, !s.columns.some((c) => /token|secret|password|api_key|credential|blob/i.test(c)))
  }
  const catalogTables = CONTENT_CATALOG_SOURCES.map((s) => s.table)
  for (const c of census) {
    if (c.available) check(`format "${c.format}" has a producer → indexed or a stated reason`, c.catalogued.length > 0 || !!c.excluded)
    else check(`format "${c.format}" has NO producer → not catalogued (not offered as available)`, c.catalogued.length === 0)
  }
  check("every catalog source appears in the census", catalogTables.every((t) => census.some((c) => c.catalogued.includes(t))), catalogTables.filter((t) => !census.some((c) => c.catalogued.includes(t))).join(", "))
  check("no catalog source is a billing / credential table", !catalogTables.some((t) => /billing|invoice|subscription|credential|connection|stripe/i.test(t)))

  const topicVocab = CHECK_VOCABULARIES.content_topic_uses?.asset_type ?? []
  check("the topic-use map covers EXACTLY the live content_topic_uses.asset_type CHECK", [...topicVocab].sort().join() === Object.keys(TOPIC_USE_ASSET_TABLE).sort().join(), `live=${topicVocab.join(",")}`)
  check("every mapped topic-use table is a catalog source", Object.values(TOPIC_USE_ASSET_TABLE).every((t) => t === null || catalogTables.includes(t)))

  const catalogSrc = stripComments(src("lib/marketing/content-catalog.ts"))
  const doorSrc = stripComments(src("app/actions/command-center.ts"))
  const mirror = /COMMAND_CENTER_APPROVER_TYPES[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(catalogSrc)?.[1]
  const door = /async function requireApprover[\s\S]{0,1600}?if \(!\[([^\]]*)\]\.includes\(role\)\)/.exec(doorSrc)?.[1]
  const norm = (x?: string) => (x ?? "").replace(/["'\s]/g, "").split(",").filter(Boolean).sort().join()
  check("the approver mirror equals the Command Center door's own seat list (no button the writer always refuses)", !!mirror && !!door && norm(mirror) === norm(door), `catalog=${norm(mirror)} door=${norm(door)}`)

  const reg = stripComments(src("lib/marketing/campaign-registry.ts"))
  const route = stripComments(src("app/api/marketing/content-command/route.ts"))
  const callsBlock = route.slice(route.indexOf("const CATALOG_WRITER_CALLS"), route.indexOf("function sameOrigin"))
  const entryFinder = (id: string, mod: string, exp: string, text: string) => {
    const m = new RegExp(`\\n\\s*${id}:\\s*async[\\s\\S]*?(?=\\n\\s*[a-z_]+:\\s*async|\\n\\}$)`).exec(text + "\n}")
    const body = m?.[0] ?? ""
    const spec = mod.replace(/\.tsx?$/, "")
    return body.includes(`import("@/${spec}")`) && new RegExp(`\\b${exp}\\(`).test(body)
  }
  for (const [id, w] of Object.entries(CATALOG_ACTION_WRITERS)) {
    const file = join(root, w.module)
    const body = existsSync(file) ? stripComments(readFileSync(file, "utf8")) : ""
    check(`writer ${id}: ${w.module} exports async ${w.exportName}`, new RegExp(`export async function ${w.exportName}\\(`).test(body))
    const entryId = id === "route_omnipresence_run" ? "route_omnipresence" : id
    check(`writer ${id}: the session door imports ${w.module} and calls ${w.exportName}`, entryFinder(entryId, w.module, w.exportName, callsBlock))
  }
  check("CONTROL: the door finder refuses an entry that imports the module but calls a different export", !entryFinder("approve_asset", "app/actions/marketing-studio.ts", "approveAsset", `\n  approve_asset: async (a) => (await import("@/app/actions/marketing-studio")).rejectAsset(a.id),\n`))
  check("the door re-reads the row under the session and refuses anything not offered before a writer runs", /const before = await readContentCatalog\(db, viewer, \{ sourceType: input\.sourceType, sourceId: input\.sourceId[\s\S]{0,200}planContentAction\(before\.rows\[0\][\s\S]{0,120}if \(!plan\.ok\) return/.test(route))
  check("the door is same-origin only and fails closed without an Origin", /if \(!sameOrigin\(req\)\) return[\s\S]{0,160}status: 403/.test(route) && /if \(!origin \|\| !host\) return false/.test(route))
  check("tenant + seat come from the session (getAgentContext) in both the read and the door — never the body", /async function sessionCatalogViewer\(\)[\s\S]{0,200}getAgentContext\(\)/.test(reg) && /const ctx = await getAgentContext\(\)[\s\S]{0,1400}resolveCatalogViewer\(db, \{ userId: ctx\.userId, brokerageId: ctx\.brokerageId/.test(route) && !/input\.brokerageId|body\.brokerageId/.test(route) && !/export async function getContentCommandCenter\([^)]*brokerageId/.test(reg))
  check("the door reads back the canonical row after the writer (the refresh is the record's status, not the button's)", /const after = await readContentCatalog\(/.test(route))
}

// ═══ FIXTURES ═══════════════════════════════════════════════════════════════════════════════════════════════
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const TOPIC = U(1), V_OK = U(2), E1 = U(3), I1 = U(4), P1 = U(5), M1 = U(6), V_FAIL = U(7), V_REEL = U(8), I_RIGHTS = U(9), M2 = U(10), BLOG = U(11)
const CONTACT = U(20), TX_OTHER = U(30), TX_MINE = U(31), D_OTHER = U(40), D_MINE_FOREIGN_DEAL = U(41), D_MINE = U(42)
const B_TOPIC = U(50), B_POST = U(51), I_REJECT = U(12)
const ORIGIN = "https://app.example.test"
const now = "2026-11-18T12:00:00.000Z"

function mainDb() {
  return memSupabase({
    brokerages: [{ id: "bA", plan_tier: "brokerage", website: null }, { id: "bB", plan_tier: "brokerage", website: null }],
    locations: [],
    users: [
      { id: "uA", brokerage_id: "bA", user_type: "agent", team_id: null, location_id: null, first_name: "Ann" },
      { id: "uOther", brokerage_id: "bA", user_type: "agent", team_id: null, location_id: null },
      { id: "uAdmin", brokerage_id: "bA", user_type: "broker_owner", team_id: null, location_id: null },
      { id: "uB", brokerage_id: "bB", user_type: "agent", team_id: null, location_id: null },
    ],
    agents: [
      { id: "agA", user_id: "uA", brokerage_id: "bA", team_id: null, location_id: null, is_active: true },
      { id: "agOther", user_id: "uOther", brokerage_id: "bA", team_id: null, location_id: null, is_active: true },
      { id: "agB", user_id: "uB", brokerage_id: "bB", team_id: null, location_id: null, is_active: true },
    ],
    teams: [], organization_members: [], user_role_assignments: [], transaction_coordinators: [], transaction_assignments: [],
    tenant_custom_domains: [], brokerage_brand_settings: [], marketing_campaigns: [{ id: U(60), brokerage_id: "bA", campaign_name: "Spring rates push" }], listings: [],
    campaign_roi: [],
    content_topic_bank: [
      { id: TOPIC, brokerage_id: "bA", topic_title: "Should I sell before rates drop?", value_angle: "A plain answer for homeowners weighing timing", status: "fresh", scraped_at: now },
      { id: B_TOPIC, brokerage_id: "bB", topic_title: "Should I sell before rates drop?", status: "fresh", scraped_at: now },
    ],
    competitor_content: [],
    ai_video_projects: [
      { id: V_OK, brokerage_id: "bA", agent_id: "agA", title: "Rates explainer", status: "completed", approval_status: "approved", video_url: "https://cdn.example.test/v-ok.mp4", created_at: now },
      { id: V_FAIL, brokerage_id: "bA", agent_id: "agA", title: "Anniversary reel", status: "failed", error_message: "provider render error", contact_id: CONTACT, created_at: now },
      { id: V_REEL, brokerage_id: "bA", agent_id: "agA", title: "Your equity this year", status: "completed", approval_status: "approved", video_url: "https://cdn.example.test/v-reel.mp4", thumbnail_url: "https://cdn.example.test/v-reel.jpg", contact_id: CONTACT, video_type: "home_anniversary", created_at: now },
    ],
    newsletter_campaigns: [{ id: E1, brokerage_id: "bA", created_by: "uA", campaign_name: "May homeowner letter", subject_line: "Timing your sale", status: "draft", approval_status: "pending_review", created_at: now }],
    marketing_assets: [
      { id: I1, brokerage_id: "bA", agent_user_id: "uA", asset_type: "image", asset_name: "Timing graphic", approval_status: "pending", source_table: "content_topic_bank", source_id: TOPIC, visibility_scope: "agent", created_at: now },
      { id: I_RIGHTS, brokerage_id: "bA", agent_user_id: "uA", asset_type: "image", asset_name: "Found photo", approval_status: "approved", rights: { source: "external" }, visibility_scope: "agent", created_at: now },
      { id: I_REJECT, brokerage_id: "bA", agent_user_id: "uA", asset_type: "graphic", asset_name: "Old flyer", approval_status: "pending", visibility_scope: "agent", created_at: now },
    ],
    social_posts: [
      { id: P1, brokerage_id: "bA", agent_id: "agA", user_id: "uA", content: "Thinking about timing your sale this spring?", platform: "facebook", status: "published", approval_status: "approved", external_post_id: "fb_123", published_at: now, created_at: now },
      { id: B_POST, brokerage_id: "bB", agent_id: "agB", content: "Other tenant post", platform: "facebook", status: "draft", approval_status: "pending", created_at: now },
    ],
    direct_mail_campaigns: [
      { id: M1, brokerage_id: "bA", created_by: "uA", agent_id: "agA", campaign_name: "Timing postcard", status: "planning", mail_format: "postcard", created_at: now },
    ],
    blog_posts: [{ id: BLOG, brokerage_id: "bA", agent_user_id: "uA", title: "Selling in a shifting market", publish_status: "approved", visibility_scope: "agent", created_at: now }],
    content_topic_uses: [
      { id: U(70), brokerage_id: "bA", topic_id: TOPIC, asset_id: V_OK, asset_type: "situational_reel" },
      { id: U(71), brokerage_id: "bA", topic_id: TOPIC, asset_id: E1, asset_type: "newsletter_campaign" },
      { id: U(72), brokerage_id: "bA", topic_id: TOPIC, asset_id: P1, asset_type: "social_post" },
      { id: U(73), brokerage_id: "bA", topic_id: TOPIC, asset_id: M1, asset_type: "direct_mail_postcard" },
      { id: U(74), brokerage_id: "bB", topic_id: B_TOPIC, asset_id: B_POST, asset_type: "social_post" },
    ],
    transactions: [
      { id: TX_OTHER, brokerage_id: "bA", agent_id: "agOther", coordinator_id: null, status: "active", stage: "under_contract" },
      { id: TX_MINE, brokerage_id: "bA", agent_id: "agA", coordinator_id: null, status: "active", stage: "under_contract" },
    ],
    generated_documents: [
      { id: D_OTHER, brokerage_id: "bA", agent_id: "agOther", transaction_id: TX_OTHER, document_type: "closing_disclosure", blob_url: "https://blob.example.test/secret.pdf", created_at: now },
      { id: D_MINE_FOREIGN_DEAL, brokerage_id: "bA", agent_id: "agA", transaction_id: TX_OTHER, document_type: "commission_statement", blob_url: "https://blob.example.test/c.pdf", created_at: now },
      { id: D_MINE, brokerage_id: "bA", agent_id: "agA", transaction_id: TX_MINE, document_type: "purchase_contract", blob_url: "https://blob.example.test/p.pdf", created_at: now },
    ],
    manager_signals: [], agent_action_ledger: [], agent_client_messages: [], marketing_agent_actions: [], asset_manager_actions: [], social_publish_log: [],
    qr_codes: [], qr_scan_events: [], marketing_asset_qr_links: [],
    remotion_composition_renders: [], video_snippets: [], video_scripts_library: [], email_campaigns: [], podcast_episodes: [], repurposed_content_log: [],
    campaign_bundles: [], lifetime_customer_touchpoints: [], lead_magnet_deliverables: [], book_projects: [], listing_landing_pages: [], neighborhood_reports: [], ai_message_drafts: [],
  }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]], qr_codes: [["slug"]] } })
}
type Db = ReturnType<typeof mainDb>
const viewerFor = (db: Db, userId: string, brokerageId: string, userType: string) => resolveCatalogViewer(db, { userId, brokerageId, userType })
const keys = (rows: CatalogRow[]) => rows.map((r) => r.key)
const byKey = (rows: CatalogRow[], k: string) => rows.find((r) => r.key === k) ?? null

async function topicSearchSection() {
  console.log("\n[1 · ONE SEARCH — a topic and every artifact made from it, each with its own id and status]  SIMULATED")
  const db = mainDb()
  const ann = await viewerFor(db, "uA", "bA", "agent")
  const res = await readContentCatalog(db, ann, { search: "sell before rates" })
  const want = [`content_topic_bank:${TOPIC}`, `ai_video_projects:${V_OK}`, `newsletter_campaigns:${E1}`, `marketing_assets:${I1}`, `social_posts:${P1}`, `direct_mail_campaigns:${M1}`]
  check("one search returns the topic + video + email + social image + post + postcard draft — exactly those", want.every((k) => keys(res.rows).includes(k)) && res.rows.length === want.length, keys(res.rows).join(" "))
  const st = Object.fromEntries(res.rows.map((r) => [r.sourceType, r.status]))
  check("each keeps its OWN status: video ready · email awaiting approval · image awaiting approval · post posted · postcard draft",
    st.ai_video_projects === "ready" && st.newsletter_campaigns === "awaiting_approval" && st.marketing_assets === "awaiting_approval" && st.social_posts === "posted" && st.direct_mail_campaigns === "draft", JSON.stringify(st))
  check("each row carries its REAL canonical id (sourceType:sourceId), never a catalog id", res.rows.every((r) => r.key === `${r.sourceType}:${r.sourceId}` && want.includes(r.key)))
  check("CONTROL: the video's own title does not contain the phrase — it is found through the topic link, not by luck", !/sell before rates/i.test(byKey(res.rows, `ai_video_projects:${V_OK}`)?.title ?? "x") && byKey(res.rows, `ai_video_projects:${V_OK}`)!.topics.some((t) => t.id === TOPIC))
  check("the other tenant's identical topic and its post never appear", !res.rows.some((r) => r.tenantId !== "bA") && !keys(res.rows).includes(`social_posts:${B_POST}`) && !keys(res.rows).includes(`content_topic_bank:${B_TOPIC}`))
  check("CONTROL: an unrelated search finds nothing (the filter is live)", (await readContentCatalog(db, ann, { search: "zzz-no-such-topic" })).rows.length === 0)
  check("a field with no source is null (rendered 'unknown'), never a default: the email's engagement and the image's brand voice", byKey(res.rows, `newsletter_campaigns:${E1}`)!.engagement === null && byKey(res.rows, `marketing_assets:${I1}`)!.brandVoice === null)
  check("the topic view filter returns the same family by topic id", (await readContentCatalog(db, ann, { topicId: TOPIC })).rows.length === want.length)
}

function scopeDb() {
  return memSupabase({
    brokerages: [{ id: "bS", plan_tier: "solo_agent" }, { id: "bT", plan_tier: "team" }, { id: "bM", plan_tier: "multi_location" }, { id: "bU", plan_tier: "brokerage" }],
    locations: [
      { id: "oT", brokerage_id: "bT", status: "active", managing_broker_user_id: null },
      { id: "oM1", brokerage_id: "bM", status: "active", managing_broker_user_id: "uOffice1" },
      { id: "oM2", brokerage_id: "bM", status: "active", managing_broker_user_id: "uOffice2" },
    ],
    teams: [{ id: "tT", brokerage_id: "bT", team_lead_id: "uLeadT", location_id: null, deleted_at: null }],
    // C34 (wave 150): the multi-location all-office view needs an explicit tenant LEADERSHIP grant; user_type never widens it.
    organization_members: [{ brokerage_id: "bM", user_id: "uOwnerM", scope_kind: "tenant", location_id: null, team_id: null, access_level: "leadership", revoked_at: null }],
    user_role_assignments: [],
    users: [
      { id: "uBrokerNoGrant", brokerage_id: "bM", user_type: "broker_owner", team_id: null, location_id: null },
      { id: "uS", brokerage_id: "bS", user_type: "agent", team_id: null, location_id: null },
      { id: "uLeadT", brokerage_id: "bT", user_type: "team_lead", team_id: "tT", location_id: null },
      { id: "uSeat1", brokerage_id: "bT", user_type: "agent", team_id: "tT", location_id: null },
      { id: "uSeat2", brokerage_id: "bT", user_type: "agent", team_id: null, location_id: null },
      { id: "uAdminT", brokerage_id: "bT", user_type: "broker_owner", team_id: null, location_id: null },
      { id: "uOwnerM", brokerage_id: "bM", user_type: "broker_owner", team_id: null, location_id: null },
      { id: "uOffice1", brokerage_id: "bM", user_type: "broker", team_id: null, location_id: "oM1" },
      { id: "uOffice2", brokerage_id: "bM", user_type: "broker", team_id: null, location_id: "oM2" },
      { id: "uAgentM1", brokerage_id: "bM", user_type: "agent", team_id: null, location_id: "oM1" },
      { id: "uAgentM2", brokerage_id: "bM", user_type: "agent", team_id: null, location_id: "oM2" },
      { id: "uU", brokerage_id: "bU", user_type: "agent", team_id: null, location_id: null },
    ],
    agents: [
      { id: "agS", user_id: "uS", brokerage_id: "bS", team_id: null, location_id: null },
      { id: "agLead", user_id: "uLeadT", brokerage_id: "bT", team_id: "tT", location_id: null },
      { id: "agSeat1", user_id: "uSeat1", brokerage_id: "bT", team_id: "tT", location_id: null },
      { id: "agSeat2", user_id: "uSeat2", brokerage_id: "bT", team_id: null, location_id: null },
      { id: "agM1", user_id: "uAgentM1", brokerage_id: "bM", team_id: null, location_id: "oM1" },
      { id: "agM2", user_id: "uAgentM2", brokerage_id: "bM", team_id: null, location_id: "oM2" },
      { id: "agU", user_id: "uU", brokerage_id: "bU", team_id: null, location_id: null },
    ],
    social_posts: [
      { id: U(100), brokerage_id: "bS", agent_id: "agS", content: "Solo post", platform: "instagram", status: "draft", approval_status: "pending", created_at: now },
      { id: U(101), brokerage_id: "bM", agent_id: "agM1", content: "Office one post", platform: "facebook", status: "draft", approval_status: "pending", created_at: now },
      { id: U(102), brokerage_id: "bM", agent_id: "agM2", content: "Office two post", platform: "facebook", status: "draft", approval_status: "pending", created_at: now },
      { id: U(103), brokerage_id: "bU", agent_id: "agU", content: "Unrelated tenant post", platform: "facebook", status: "draft", approval_status: "pending", created_at: now },
    ],
    marketing_assets: [
      { id: U(110), brokerage_id: "bT", agent_user_id: "uSeat1", asset_type: "image", asset_name: "Seat one image", approval_status: "pending", visibility_scope: "agent", cost_usd: 3.5, created_at: now },
      { id: U(111), brokerage_id: "bT", agent_user_id: "uSeat2", asset_type: "image", asset_name: "Seat two image", approval_status: "pending", visibility_scope: "agent", created_at: now },
      { id: U(112), brokerage_id: "bT", agent_user_id: "uAdminT", asset_type: "template", asset_name: "Brokerage template", approval_status: "approved", visibility_scope: "brokerage", created_at: now },
      { id: U(113), brokerage_id: "bU", agent_user_id: "uU", asset_type: "image", asset_name: "Unrelated recipient card", approval_status: "pending", visibility_scope: "brokerage", contact_id: U(199), created_at: now },
    ],
  }, { uuidIds: true })
}

async function scopeSection() {
  console.log("\n[2 · SCOPE — solo, team seat, team lead, office head, owner; nothing crosses tenants]  SIMULATED")
  const db = scopeDb()
  const read = async (u: string, b: string, t: string) => { const v = await viewerFor(db as any, u, b, t); return { v, rows: (await readContentCatalog(db as any, v)).rows } }
  const solo = await read("uS", "bS", "agent")
  check("solo agent: their own post, nothing else", keys(solo.rows).join() === `social_posts:${U(100)}`, keys(solo.rows).join(" "))
  const seat = await read("uSeat1", "bT", "agent")
  check("team seat: own image + the brokerage-shared template; not a teammate-outside-team's image", keys(seat.rows).sort().join() === [`marketing_assets:${U(110)}`, `marketing_assets:${U(112)}`].sort().join(), keys(seat.rows).join(" "))
  check("team seat: provider cost is RESTRICTED (not shown, not zero)", seat.rows.every((r) => r.providerCostUsd === null && r.providerCostVisibility === "restricted"))
  const lead = await read("uLeadT", "bT", "team_lead")
  check("team lead: the team's work (seat one) + shared; not the agent outside the team", keys(lead.rows).includes(`marketing_assets:${U(110)}`) && keys(lead.rows).includes(`marketing_assets:${U(112)}`) && !keys(lead.rows).includes(`marketing_assets:${U(111)}`), `${lead.v.scopeLabel}: ${keys(lead.rows).join(" ")}`)
  const adminT = await read("uAdminT", "bT", "broker_owner")
  check("brokerage owner: every row in the tenant", adminT.rows.length === 3)
  check(`owner (a finance admin: ${BROKERAGE_FINANCE_ADMIN_USER_TYPES.has("broker_owner")}) sees the measured provider cost; an unmeasured one reads unknown`, byKey(adminT.rows, `marketing_assets:${U(110)}`)?.providerCostUsd === 3.5 && byKey(adminT.rows, `marketing_assets:${U(111)}`)?.providerCostVisibility === "unknown")
  const office = await read("uOffice1", "bM", "broker")
  check("multi-office head of office one: office one's post only", keys(office.rows).join() === `social_posts:${U(101)}`, `${office.v.scopeLabel}: ${keys(office.rows).join(" ")}`)
  const ownerM = await read("uOwnerM", "bM", "broker_owner")
  check("multi-location owner WITH the tenant leadership grant: both offices", keys(ownerM.rows).sort().join() === [`social_posts:${U(101)}`, `social_posts:${U(102)}`].sort().join(), keys(ownerM.rows).join(" "))
  const noGrant = await read("uBrokerNoGrant", "bM", "broker_owner")
  check("multi-location broker_owner WITHOUT a grant or office: own work only (user_type never widens a multi-location row)", noGrant.rows.length === 0 && noGrant.v.memberUserIds?.join() === "uBrokerNoGrant", `${noGrant.v.scopeLabel}: ${keys(noGrant.rows).join(" ")}`)
  const all = [solo, seat, lead, adminT, office, ownerM, noGrant]
  check("no read returns another tenant's creative or recipient", all.every((x) => x.rows.every((r) => r.tenantId === x.v.brokerageId)) && !all.some((x) => x.rows.some((r) => r.recipientContactId === U(199))))
  const forged: CatalogViewer = { ...seat.v, memberUserIds: null, memberAgentIds: null }
  check("CONTROL: the same read with the scope removed WOULD show the hidden image (the filter is what hides it)", keys((await readContentCatalog(db as any, forged)).rows).includes(`marketing_assets:${U(111)}`))
  const refusing = memSupabase({ users: [] }, { refuse: { users: "permission denied for table users" } })
  const closed = await viewerFor(refusing as any, "uSeat1", "bT", "broker_owner")
  check("FAIL CLOSED: an unreadable seat narrows even a broker_owner to their own work, and says so", closed.memberUserIds?.join() === "uSeat1" && !!closed.refusal && /own work/.test(closed.refusal))
}

async function videoSection() {
  console.log("\n[3 · VIDEO — a failed render is never sendable; a playable one becomes eligible through the REAL hand-off]  SIMULATED")
  const db = mainDb()
  const ann = await viewerFor(db, "uA", "bA", "agent")
  const admin = await viewerFor(db, "uAdmin", "bA", "broker_owner")
  const failedRow = byKey((await readContentCatalog(db, ann, { sourceType: "ai_video_projects" })).rows, `ai_video_projects:${V_FAIL}`)!
  check("failed render: status failed, no send action, a stated reason, and the door refuses the send", failedRow.status === "failed" && !failedRow.actions.some((a) => a.kind === "send_personal_email") && failedRow.blocked.some((b) => b.kind === "send_personal_email" && /failed/.test(b.reason)) && !planContentAction(failedRow, { sourceType: "ai_video_projects", sourceId: V_FAIL, action: "send_personal_email" }).ok)
  const fsig = await publishVideoCoordinationSignals(V_FAIL, db as any)
  const failedAfter = byKey((await readContentCatalog(db, admin, { sourceType: "ai_video_projects" })).rows, `ai_video_projects:${V_FAIL}`)!
  check("the failed render's real signal is the compliance escalation — it never makes the video sendable", fsig.escalated && db.tables.manager_signals.some((s: any) => s.entity_id === V_FAIL && s.signal_type === "video_compliance_failed") && failedAfter.sendable === false)
  const before = byKey((await readContentCatalog(db, admin, { sourceType: "ai_video_projects" })).rows, `ai_video_projects:${V_REEL}`)!
  check("playable reel BEFORE the hand-off: not sendable, the missing link named", before.sendable === false && before.dependencies.some((d) => d.kind === "asset_to_campaign_handoff" && !d.satisfied) && !before.actions.some((a) => a.kind === "send_personal_email"))
  const pub = await publishVideoCoordinationSignals(V_REEL, db as any)
  check("publishVideoCoordinationSignals (executed) hands the reel to the Campaign Orchestrator: contact_outreach_ready on the bus", pub.ok && db.tables.manager_signals.some((s: any) => s.entity_id === V_REEL && s.signal_type === "contact_outreach_ready" && s.from_manager === "asset_manager" && s.to_manager === "campaign_orchestrator"))
  const mid = byKey((await readContentCatalog(db, admin, { sourceType: "ai_video_projects" })).rows, `ai_video_projects:${V_REEL}`)!
  check("after the real hand-off the reel is ELIGIBLE (sendable) and the decision reads the signal", mid.sendable === true && mid.lastDecision?.what === "contact_outreach_ready")
  // The Campaign Orchestrator's handler (lib/kernel/manager-signals.ts contact_outreach_ready) proposes the gated email in
  // agent_client_messages; it calls a model, so its OUTPUT row is seeded here exactly as proposeClientMessage writes it.
  db.tables.agent_client_messages.push({ id: U(80), brokerage_id: "bA", channel: "email", subject: "Your equity this year", status: "proposed", audience: "seller", recipient_contact_id: CONTACT, entity_type: "video_project", entity_id: V_REEL, rationale: "Situational reel finished — propose the gated 1:1 email", created_at: now })
  const ready = byKey((await readContentCatalog(db, admin, { sourceType: "ai_video_projects" })).rows, `ai_video_projects:${V_REEL}`)!
  const plan = planContentAction(ready, { sourceType: "ai_video_projects", sourceId: V_REEL, action: "send_personal_email" })
  check("the send reaches the EXISTING decision door: approveAgentAction({ queue: client_message, actionId: the proposal })", plan.ok && plan.writer === "approve_queue" && (plan.args as any).queue === "client_message" && (plan.args as any).actionId === U(80) && ready.nextAction?.manager === "campaign_orchestrator")
  const annReady = byKey((await readContentCatalog(db, ann, { sourceType: "ai_video_projects" })).rows, `ai_video_projects:${V_REEL}`)!
  check("an agent seat is not offered a send the door would refuse (the approver seats decide), and is told why", !annReady.actions.some((a) => a.kind === "send_personal_email") && annReady.blocked.some((b) => b.kind === "send_personal_email"))
}

async function qrSection() {
  console.log("\n[4 · QR — a changed destination stays on the minted code; a mail piece needs a live QR]  SIMULATED")
  const db = mainDb()
  const A: QrActor = { brokerageId: "bA", userId: "uA", agentId: "agA", userType: "agent" }
  const deps = { client: db, ledgerClient: db, origin: ORIGIN, appOrigins: [ORIGIN] }
  const m = await mintGovernedQr({ purpose: "general", destinationType: "landing_page", idempotencyKey: "g2-mail-qr-0001", label: "Postcard QR" } as any, A, deps as any)
  if (!m.ok) { check("mint the QR for the mail piece", false, (m as any).message); return }
  const qrId = m.code.id
  db.tables.marketing_asset_qr_links.push({ id: U(90), brokerage_id: "bA", marketing_asset_id: I1, qr_code_id: qrId, placement_type: "mailer" })
  db.tables.direct_mail_campaigns.push({ id: M2, brokerage_id: "bA", created_by: "uA", agent_id: "agA", campaign_name: "QR postcard", status: "approved", mail_format: "postcard", qr_code_id: qrId, created_at: now })
  const ann = await viewerFor(db, "uA", "bA", "agent")
  const pre = await readContentCatalog(db, ann)
  const mail = byKey(pre.rows, `direct_mail_campaigns:${M2}`)!
  check("the mail piece shows its QR link and is releasable while the code is live", mail.qrLinks[0]?.qrCodeId === qrId && mail.actions.some((a) => a.kind === "release_direct_mail"))
  const qrRow = byKey(pre.rows, `qr_codes:${qrId}`)!
  check("the QR itself is in the catalog with a one-flow destination change", qrRow?.actions.some((a) => a.kind === "change_qr_destination"))
  const plan = planContentAction(qrRow, { sourceType: "qr_codes", sourceId: qrId, action: "change_qr_destination", targetUrl: "/home-value", reason: "spring funnel" })
  check("the change plans onto editQrDestination", plan.ok && plan.writer === "change_qr_destination")
  const countBefore = db.tables.qr_codes.length
  const edit = await editQrDestination({ qrCodeId: qrId, targetUrl: "/home-value", reason: "spring funnel" }, A, deps as any)
  check("editQrDestination (executed) saves a new VERSION", edit.ok && !edit.unchanged && edit.history.length === 2, edit.ok ? "" : (edit as any).message)
  const post = await readContentCatalog(db, ann)
  const mail2 = byKey(post.rows, `direct_mail_campaigns:${M2}`)!, img2 = byKey(post.rows, `marketing_assets:${I1}`)!
  check("no duplicate QR record: same row count, same id, same printed slug", db.tables.qr_codes.length === countBefore && mail2.qrLinks[0].qrCodeId === qrId && mail2.qrLinks[0].slug === m.code.slug)
  check("both the mail piece and the image follow the new destination (v2) on the SAME code", mail2.qrLinks[0].targetUrl === "/home-value" && mail2.qrLinks[0].version === 2 && img2.qrLinks[0]?.qrCodeId === qrId && img2.qrLinks[0].targetUrl === "/home-value")
  const row = db.tables.qr_codes.find((r: any) => r.id === qrId) as any
  row.retired_at = now
  const retired = byKey((await readContentCatalog(db, ann)).rows, `direct_mail_campaigns:${M2}`)!
  check("a retired QR blocks the release, says why, and the door refuses it", !retired.actions.some((a) => a.kind === "release_direct_mail") && retired.blocked.some((b) => b.kind === "release_direct_mail") && !planContentAction(retired, { sourceType: "direct_mail_campaigns", sourceId: M2, action: "release_direct_mail" }).ok)
}

async function decisionSection() {
  console.log("\n[5 · APPROVE / REJECT / PUBLISH — the exact canonical writer, then the real status on readback]  SIMULATED")
  const db = mainDb()
  const ann = await viewerFor(db, "uA", "bA", "agent")
  const admin = await viewerFor(db, "uAdmin", "bA", "broker_owner")
  const studio = stripComments(src("app/actions/marketing-studio.ts"))
  const fnBody = (text: string, name: string) => { const i = text.indexOf(`export async function ${name}(`); const j = text.indexOf("\nexport ", i + 10); return i < 0 ? "" : text.slice(i, j < 0 ? undefined : j) }
  const approveBody = fnBody(studio, "approveAsset"), rejectBody = fnBody(studio, "rejectAsset")
  check("approveAsset (the writer) updates marketing_assets.approval_status = 'approved' under the tenant, counted", /from\("marketing_assets"\)[\s\S]{0,40}\.update\(\{[\s\S]{0,60}approval_status: "approved"/.test(approveBody) && /\.eq\("brokerage_id", brokerageId\)/.test(approveBody) && /approved\.length === 0/.test(approveBody))
  check("rejectAsset (the writer) updates marketing_assets.approval_status = 'rejected' under the tenant", /from\("marketing_assets"\)[\s\S]{0,40}\.update\(\{[\s\S]{0,60}approval_status: "rejected"/.test(rejectBody) && /\.eq\("brokerage_id", brokerageId\)/.test(rejectBody))
  const img = byKey((await readContentCatalog(db, ann)).rows, `marketing_assets:${I1}`)!
  const ap = planContentAction(img, { sourceType: "marketing_assets", sourceId: I1, action: "approve" })
  check("approve plans onto approveAsset with the real id", ap.ok && ap.writer === "approve_asset" && (ap.args as any).id === I1 && CATALOG_ACTION_WRITERS.approve_asset.exportName === "approveAsset")
  // the writer's own update, applied as proved above
  ;(db.tables.marketing_assets.find((r: any) => r.id === I1) as any).approval_status = "approved"
  const img2 = byKey((await readContentCatalog(db, ann)).rows, `marketing_assets:${I1}`)!
  check("readback after approval: READY (not sent, not posted) and no longer offering approve", img2.status === "ready" && img2.statusLabel === "Ready (not sent)" && !img2.actions.some((a) => a.kind === "approve"))
  const rj = planContentAction(byKey((await readContentCatalog(db, ann)).rows, `marketing_assets:${I_REJECT}`), { sourceType: "marketing_assets", sourceId: I_REJECT, action: "reject", reason: "off brand" })
  check("reject plans onto rejectAsset with the reason", rj.ok && rj.writer === "reject_asset" && (rj.args as any).reason === "off brand")
  ;(db.tables.marketing_assets.find((r: any) => r.id === I_REJECT) as any).approval_status = "rejected"
  check("readback after rejection: REJECTED", byKey((await readContentCatalog(db, ann)).rows, `marketing_assets:${I_REJECT}`)?.status === "rejected")
  const blocked = byKey((await readContentCatalog(db, ann)).rows, `marketing_assets:${I_RIGHTS}`)!
  check("an asset that fails the ONE rights judge (rightsVerdict) is BLOCKED BY RIGHTS whatever its approval says", blocked.status === "blocked_by_rights" && !!blocked.rightsVerdict && /licen/i.test(blocked.rightsVerdict))
  const blogBody = fnBody(stripComments(src("app/actions/blog.ts")), "publishBlogPost")
  check("publishBlogPost (the writer) moves blog_posts.publish_status to 'published'", /publish_status: "published"/.test(blogBody))
  const blog = byKey((await readContentCatalog(db, ann)).rows, `blog_posts:${BLOG}`)!
  const pb = planContentAction(blog, { sourceType: "blog_posts", sourceId: BLOG, action: "publish" })
  check("publish plans onto publishBlogPost; before it runs the post reads READY, never posted", pb.ok && pb.writer === "publish_blog" && blog.status === "ready")
  ;(db.tables.blog_posts.find((r: any) => r.id === BLOG) as any).publish_status = "published"
  check("readback after publication: POSTED", byKey((await readContentCatalog(db, ann)).rows, `blog_posts:${BLOG}`)?.status === "posted")
  const nl = byKey((await readContentCatalog(db, admin)).rows, `newsletter_campaigns:${E1}`)!
  const nlPlan = planContentAction(nl, { sourceType: "newsletter_campaigns", sourceId: E1, action: "approve" })
  check("a newsletter approval goes through the Command Center door (approveAgentAction, queue newsletter)", nlPlan.ok && nlPlan.writer === "approve_queue" && (nlPlan.args as any).queue === "newsletter")
  const nlAnn = byKey((await readContentCatalog(db, ann)).rows, `newsletter_campaigns:${E1}`)!
  check("an agent seat is not shown that approval (the door admits only its approver seats) and is told who decides", !nlAnn.actions.some((a) => a.kind === "approve") && nlAnn.blocked.some((b) => b.kind === "approve"))
  check("CONTROL: an action that is not offered is refused by the plan even when asked for", !planContentAction(img2, { sourceType: "marketing_assets", sourceId: I1, action: "release_direct_mail" }).ok)
  db.tables.marketing_agent_actions.push({ id: U(81), brokerage_id: "bA", action_type: "omnipresence_topic_fanout", action_input: { topic_id: TOPIC }, rationale: "the topic that drove scans", status: "proposed", proposed_at: now })
  const topicRow = byKey((await readContentCatalog(db, admin)).rows, `content_topic_bank:${TOPIC}`)!
  const decline = planContentAction(topicRow, { sourceType: "content_topic_bank", sourceId: TOPIC, action: "decline_proposal" })
  check("the arbiter's proposal shows as the next action (manager, why, trigger) and 'decide to do nothing' reaches rejectAgentAction", topicRow.nextAction?.manager === "marketing_agent" && topicRow.nextAction.trigger === "omnipresence_topic_fanout" && decline.ok && decline.writer === "reject_queue" && (decline.args as any).queue === "marketing" && (decline.args as any).actionId === U(81))
}

async function securedSection() {
  console.log("\n[6 · SECURED DOCUMENTS — a checked LINK, never the file; deal access decides]  SIMULATED")
  const db = mainDb()
  const ann = await viewerFor(db, "uA", "bA", "agent")
  const admin = await viewerFor(db, "uAdmin", "bA", "broker_owner")
  const annRows = (await readContentCatalog(db, ann, { sourceType: "generated_documents" })).rows
  check("the owning agent of the deal sees its document as a link to the deal workspace", byKey(annRows, `generated_documents:${D_MINE}`)?.link === `/dashboard/transactions/${TX_MINE}` && byKey(annRows, `generated_documents:${D_MINE}`)!.secured)
  check("a document the agent made on SOMEONE ELSE's deal is hidden (deal access says no)", !keys(annRows).includes(`generated_documents:${D_MINE_FOREIGN_DEAL}`))
  check("another agent's deal document never reaches this agent", !keys(annRows).includes(`generated_documents:${D_OTHER}`))
  const deny = await loadDealWorkAccess(db as any, { userId: "uA", brokerageId: "bA", userType: "agent", transactionId: TX_OTHER })
  const allow = await loadDealWorkAccess(db as any, { userId: "uA", brokerageId: "bA", userType: "agent", transactionId: TX_MINE })
  check("CONTROL: the predicate itself answers no / yes on the two deals (the hiding is its verdict)", deny.ok && !deny.access.capabilities.read && allow.ok && allow.access.capabilities.read)
  const adminRows = (await readContentCatalog(db, admin, { sourceType: "generated_documents" })).rows
  check("a tenant admin (deal read) sees the links", keys(adminRows).includes(`generated_documents:${D_OTHER}`))
  check("no catalog row carries the stored file (no blob URL, no thumbnail) and secured rows offer no actions", [...annRows, ...adminRows].every((r) => !JSON.stringify(r).includes("blob.example.test") && r.thumbnailUrl === null && r.actions.length === 0))
}

function uiSection() {
  console.log("\n[7 · THE UI — the component's real calls (stripped source, positive control)]")
  const comp = stripComments(src("app/dashboard/marketing/studio/components/content-command-center.tsx"))
  const compCode = blankStrings(comp)
  check("the workspace reads through getContentCommandCenter and acts through the ONE door route", /getContentCommandCenter\(\{/.test(comp) && /const CONTENT_COMMAND_DOOR = "\/api\/marketing\/content-command"/.test(comp) && /fetch\(CONTENT_COMMAND_DOOR, \{[\s\S]{0,160}JSON\.stringify\(\{ sourceType: row\.sourceType, sourceId: row\.sourceId, action: kind/.test(comp))
  check("the component writes nothing itself (no .from(, one fetch — to the door — and no other server action)", !/\.from\(/.test(compCode) && (compCode.match(/fetch\(/g) ?? []).length === 1 && (comp.match(/from "@\/(app\/actions|lib)\/[^"]+"/g) ?? []).every((m) => /campaign-registry|content-catalog/.test(m)))
  check("its only content-catalog import is type-only (no server module in the client bundle)", /import type \{[^}]*\} from "@\/lib\/marketing\/content-catalog"/.test(comp) && !/^import \{[^}]*\} from "@\/lib\/marketing\/content-catalog"/m.test(comp))
  const decorative = (code: string) => (code.match(/<Button[^>]*onClick=\{\(\) => \{?\s*\}?\}/g) ?? []).length + (code.match(/<Button(?![^>]*onClick)[^>]*>/g) ?? []).length
  check("no decorative button: every Button has a handler that does work", decorative(comp) === 0, String(decorative(comp)))
  check("CONTROL: the decorative-button finder catches an empty handler and a handler-less button", decorative(`<Button onClick={() => {}}>Approve</Button><Button size="sm">Send</Button>`) === 2)
  check("each action button calls act() with the offered kind; null fields render 'unknown'", /onClick=\{\(\) => void act\(selected, a\.kind\)\}/.test(comp) && /const unknown = /.test(comp))
  check("all eight views exist (campaign, topic, channel, artifact, recipient/journey, creator, status, result)", ["campaign", "topic", "channel", "artifact", "recipient", "creator", "status", "result"].every((v) => new RegExp(`value: "${v}"`).test(comp)))
  const studio = stripComments(src("app/dashboard/marketing/studio/marketing-studio-client.tsx"))
  check("mounted in the EXISTING Marketing Studio as a lazily loaded tab", /dynamic\(\(\) => import\("\.\/components\/content-command-center"\), \{ ssr: false \}\)/.test(studio) && /<TabsContent value="command"[\s\S]{0,200}<ContentCommandCenter \/>/.test(studio))
  check("the page accepts ?tab=command", /"lab", "command"/.test(stripComments(src("app/dashboard/marketing/studio/page.tsx"))))
}

async function main() {
  console.log("content-command-center-guard — wave 154 lane 154G2 (G7 / R8)")
  censusSection()
  await topicSearchSection()
  await scopeSection()
  await videoSection()
  await qrSection()
  await decisionSection()
  await securedSection()
  uiSection()
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
