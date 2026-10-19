#!/usr/bin/env tsx
/**
 * scripts/autonomous-marketing-guard.ts  (npm run test:autonomous-marketing) — in memory, no DB, no network.
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 142, LANE 142E — AUTONOMOUS MARKETING: MARKET SIGNAL → OPPORTUNITY → CREATIVE IDEA → STRATEGY →
 * REAL ASSET → HUMAN APPROVAL → PUBLISH → OMNIPRESENCE DISTRIBUTION → FOLLOW-UP → ATTRIBUTION → LEARNING,
 * the public-copy FAIR-HOUSING REWRITE LOOP, the Forms-Manager → lead-magnet consolidation and the BOOK
 * pipeline hop by hop. Every rule drives the REAL survivors (lib/kernel/lead-magnets.ts, lib/lead-magnets/
 * {ai-draft,suggestions,book-creator}.ts, lib/kernel/marketing/public-copy-rewrite.ts, lib/documents/
 * client-pdf.ts) over scripts/in-memory-supabase.ts; the pure halves are called directly; every absence
 * assertion carries a POSITIVE CONTROL (CLAUDE.md §2); wiring is asserted on STRIPPED source.
 *
 *   A. SIGNAL SOURCES — suggestLeadMagnetIdeas ranks the three intelligence survivors (topic bank incl.
 *      competitor promotions, keyword intelligence, AI-search citation gaps) ahead of the calendar, one idea
 *      per source, the best-scored of each; a competitor idea is INSPIRATION ONLY; the runner reads the live
 *      tables tenant-pinned (expired keywords, old observations and another tenant's rows never surface) and
 *      an unreadable source is REPORTED, never thrown.
 *   B. THE REWRITE LOOP — pure: clean copy passes untouched; a flagged draft is rewritten WITH the findings
 *      and rechecked; the cap (PUBLIC_COPY_MAX_REWRITES) ESCALATES; a null / throwing rewriter ends the loop
 *      honestly. Real scan: the ONE pattern list's phrase → fix → reference; POSITIVE CONTROL: the same text
 *      on a CDA / settlement / internal-form surface is NOT moderated. Integrated: the AI draft lands the
 *      REWRITTEN copy (fromAi) with the trail recorded; a stubborn draft falls to the baseline, escalates
 *      with an in-app bell and the ledger says so; the human's publish re-scans the page and refuses a hard
 *      flag; an unfinished or human-review-pending book cannot publish.
 *   C. OMNIPRESENCE — the approved magnet is PROPOSED (never auto-run) as one omnipresence_topic_fanout; the
 *      handler pins the tenant, refuses a draft, and carries the creative reference into each channel's
 *      staging (control: the topic path survives).
 *   D. CREATIVE ACCESSIBLE TO FOLLOW-UP — leadMagnetBookRefOf is the one reader; the capture hands the
 *      finished book to delivery; the delivery activity carries magnet / PDF / document refs the AI ISA's
 *      activity readers see.
 *   E. THE BOOK — concept → research → outline → ORIGINAL chapters → fact check (deterministic figure scan +
 *      model) → edit (fact findings resolved, fair-housing loop per chapter, cap + escalate) → cover + TOC +
 *      layout → REAL multi-page PDF bytes → ready for review → human revises the escalated chapter (a
 *      steering revision is refused) → re-layout → publish → capture; entitlement first; every stage a
 *      counted write with a ledger row; the sweep advances only a STALE project.
 *   F. CONSOLIDATION — the admin Forms Manager's lead-capture half is gone; its one unique piece (the
 *      declared persona) is honoured by the ONE capture command; the two admin doors are thin doors onto the
 *      kernel; /forms/[slug] captures through the kernel and sends the consent it collects.
 *   G. WIRING — package.json + chain membership, MAINTENANCE_DOMAINS ownership, the routing rows named
 *      literally, the cron safety net, the builder / review surfaces.
 *
 * BLIND SPOTS (published): the in-memory client models supabase-js grammar, not PostgREST / RLS / live
 * CHECKs (vocabulary values come from the generated cache); the model lanes, the search rail, the brand
 * resolver and the document host are seams here (their production survivors are proven by
 * test:ai-routing-coverage / test:cost-completeness / test:asset-production); delivery and the kernel events
 * are server-only (asserted on stripped source); the real compliance gate's own blockers are exercised only
 * through the pattern list (the gate's rules have test:compliance-gate).
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { PDFDocument } from "pdf-lib"
import { memSupabase } from "./in-memory-supabase"
import { blankComments } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { createLeadMagnet, publishLeadMagnet, captureFormSubmission, leadMagnetBookRefOf, FORM_DECLARABLE_CONTACT_TYPES, type LeadMagnetBookRef } from "../lib/kernel/lead-magnets"
import { draftLeadMagnetFromConcept } from "../lib/lead-magnets/ai-draft"
import { suggestLeadMagnetIdeas, runLeadMagnetSuggestions, type TopicSignal, type SuggestionReaders } from "../lib/lead-magnets/suggestions"
import {
  rewritePublicCopyUntilCompliant, scanPublicCopy, isPublicMarketingSurface, renderFindingsForRewrite, PUBLIC_COPY_MAX_REWRITES,
  type CopyScan, type CopySurface, type CopyRewriter, type RewriteLoopResult,
} from "../lib/kernel/marketing/public-copy-rewrite"
import {
  startBookProject, advanceBookProject, reviseBookChapter, sweepStalledBookProjects, nextBookStage, unsupportedFigures, workingTitle, composeBookPdfData,
  wordCount, parseJsonObject, BOOK_STAGES, BOOK_MIN_CHAPTERS, BOOK_MAX_CHAPTERS, BOOK_CHAPTERS_PER_ADVANCE, BOOK_MIN_CHAPTER_WORDS,
  type BookDeps, type BookProject, type BookStage, type BookAudience,
} from "../lib/lead-magnets/book-creator"
import { bookPdfSpec, renderClientPdf, type ClientPdfBrand } from "../lib/documents/client-pdf"
import { declarableContactType } from "../lib/lead-magnets/form-contact-types"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const root = process.cwd()
const raw = (rel: string) => readFileSync(join(root, rel), "utf8")
const code = (rel: string) => blankComments(raw(rel))

const ORIGIN = "https://proof.autonomous-marketing.test"
process.env.NEXT_PUBLIC_APP_URL = ORIGIN

const A = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa"
const B = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb"
const AGENT_A = "aaaaaaaa-1111-4aaa-8aaa-000000000a01"
const USER_A = "aaaaaaaa-1111-4aaa-8aaa-000000000u01"
const AGENT_B = "bbbbbbbb-2222-4bbb-8bbb-000000000b01"
const USER_B = "bbbbbbbb-2222-4bbb-8bbb-000000000u01"
const NOW = new Date("2026-01-15T12:00:00Z")

function fixture(opts: { refuse?: Record<string, string> } = {}) {
  const client = memSupabase({
    brokerages: [
      { id: A, name: "Alpha Realty", logo_url: null, license_number: "A-1", license_state: "TX" },
      { id: B, name: "Beta Homes", logo_url: null, license_number: "B-1", license_state: "FL" },
    ],
    users: [
      { id: USER_A, brokerage_id: A, first_name: "Ann", last_name: "Agent", email: "ann@alpha.test", phone: null },
      { id: USER_B, brokerage_id: B, first_name: "Bob", last_name: "Broker", email: "bob@beta.test", phone: null },
    ],
    agents: [{ id: AGENT_A, user_id: USER_A, brokerage_id: A }, { id: AGENT_B, user_id: USER_B, brokerage_id: B }],
    marketing_campaigns: [],
    lead_capture_forms: [], form_submissions: [], contacts: [], contact_consent_events: [], marketing_campaign_touchpoints: [],
    lifecycle_events: [], agent_action_ledger: [], qr_codes: [], qr_scan_events: [], manager_signals: [], farm_territories: [],
    remotion_composition_renders: [], notifications: [], campaign_sequences: [], sequence_enrollments: [],
    generated_documents: [], activities: [], keyword_intelligence: [], ai_search_citation_observations: [],
  }, { uuidIds: true, stampCreatedAt: true, refuse: opts.refuse })
  ;(client as any).rpc = async () => ({ data: null, error: null })
  return client
}
type Client = ReturnType<typeof fixture>
const rows = (c: Client, t: string) => (c.tables[t] ?? []) as Array<Record<string, any>>
const ledger = (c: Client, action: string) => rows(c, "agent_action_ledger").filter((r) => r.action === action)
const formRow = (c: Client, id: string | undefined) => rows(c, "lead_capture_forms").find((r) => r.id === id)!

// Quiet the kernel's best-effort warnings (every refusal is still asserted through the rows); background
// fire-and-forget work reaches server-only modules that cannot load under tsx — recorded, never a crash.
const realWarn = console.warn, realError = console.error
console.warn = () => {}
console.error = () => {}
const backgroundRejections: string[] = []
process.on("unhandledRejection", (e) => { backgroundRejections.push(String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join(" | ")) })

/** Every .ts/.tsx under a tree (the importer census's denominator). */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const allow: NonNullable<BookDeps["entitlement"]> = async (ask) => ({ allowed: ask.brokerageId === A && ask.estTokens > 0, reason: "subscription_current" })

async function main() {
  // ── A. SIGNAL SOURCES ──────────────────────────────────────────────────────
  console.log("\n── A. ideas pull from the topic bank, competitor intelligence, keyword demand and AI-search gaps ──")
  const signals: TopicSignal[] = [
    { id: "t-low", source: "topic_bank", title: "What closing costs look like", angle: "a line-by-line walk", score: 40, evidence: { is_brokerage_local: false, categories: ["education"] } },
    { id: "t-high", source: "topic_bank", title: "Why pre-approval matters before you tour", angle: "the buyer's first move", score: 88, evidence: { is_brokerage_local: true, categories: ["buyer"] } },
    { id: "t-comp", source: "competitor_intel", title: "Sell in thirty days: the pricing playbook", angle: "a competitor's ad theme", score: 70, evidence: { is_brokerage_local: false, categories: ["competitor_intel"] } },
    { id: "k1", source: "keyword", title: "first time home buyer programs", angle: null, score: 45, evidence: { search_volume_monthly: 2400, trend_change_pct: 38, intent_category: "buyer", zip_code: "78701" } },
    { id: null, source: "ai_search_gap", title: "how to sell a house fast", angle: null, score: 32, evidence: { competitors: ["otherbroker.com", "rivalhomes.com"], observations: 3 } },
  ]
  const base = { now: NOW, magnets: [], contactMix: { buyers: 0, sellers: 0 }, territories: [] }
  const ideas = suggestLeadMagnetIdeas({ ...base, signals })
  const kinds = ideas.map((i) => i.kind)
  const gapIdea = ideas.find((i) => i.kind === "ai_search_gap")
  check("A1 an AI-search gap (competitors cited, we are not) becomes the FIRST idea, naming the query and the competitors as evidence",
    !!gapIdea && kinds.indexOf("ai_search_gap") === 0 && /otherbroker\.com and rivalhomes\.com/.test(gapIdea.concept) && gapIdea.evidence.source === "ai_search_gap" && gapIdea.evidence.query === "how to sell a house fast", JSON.stringify(gapIdea))
  check("A2 the topic bank yields ONE idea — its BEST-scored topic (t-high), never the weaker one",
    ideas.filter((i) => i.kind === "trending_topic").length === 1 && ideas.some((i) => i.key === "trending_topic:t-high") && !ideas.some((i) => i.key === "trending_topic:t-low"))
  const comp = ideas.find((i) => i.kind === "competitor_insight")
  check("A3 a competitor promotion is INSPIRATION / EVIDENCE only — the concept asks for an ORIGINAL angle and the evidence says so",
    !!comp && /ORIGINAL/.test(comp.concept) && /evidence, never a template/.test(comp.concept) && comp.evidence.inspiration_only === true && comp.evidence.topic_id === "t-comp")
  check("A4 at most three intelligence ideas per sweep (the keyword is the fourth source here and waits); the calendar idea ranks AFTER the market facts",
    !kinds.includes("search_demand") && kinds.indexOf("seasonal") > kinds.indexOf("competitor_insight") && ideas.length <= 7)
  const demand = suggestLeadMagnetIdeas({ ...base, signals: signals.filter((s) => s.source !== "competitor_intel") }).find((i) => i.kind === "search_demand")
  check("A5 rising search demand → a magnet typed by the keyword's own intent (buyer) with the trend as the why",
    !!demand && demand.magnetType === "buyer_guide" && /\+38% trend/.test(demand.why) && demand.evidence.keyword === "first time home buyer programs")
  check("A5 control — no signals, no intelligence ideas (the tenant's own evidence still ranks)",
    !suggestLeadMagnetIdeas(base).some((i) => ["trending_topic", "competitor_insight", "search_demand", "ai_search_gap"].includes(i.kind)))

  const r = fixture()
  r.tables.keyword_intelligence.push(
    { id: "k-live", brokerage_id: A, keyword: "sell my house fast", search_volume_monthly: 1900, trend_change_pct: 52, trend_direction: "rising", intent_category: "seller", zip_code: null, expires_at: "2026-03-01T00:00:00Z" },
    { id: "k-expired", brokerage_id: A, keyword: "stale keyword", search_volume_monthly: 9000, trend_change_pct: 99, trend_direction: "rising", intent_category: "seller", zip_code: null, expires_at: "2025-12-01T00:00:00Z" },
    { id: "k-other", brokerage_id: B, keyword: "other tenant keyword", search_volume_monthly: 9000, trend_change_pct: 99, trend_direction: "rising", intent_category: "seller", zip_code: null, expires_at: null },
  )
  r.tables.ai_search_citation_observations.push(
    { id: "o1", brokerage_id: A, query: "best agent to sell a condo", competitors_cited: ["rivalhomes.com"], outcome: "not_cited", observed_on: "2026-01-10" },
    { id: "o2", brokerage_id: A, query: "best agent to sell a condo", competitors_cited: ["rivalhomes.com", "otherbroker.com"], outcome: "not_cited", observed_on: "2026-01-12" },
    { id: "o3", brokerage_id: A, query: "an old gap", competitors_cited: ["rivalhomes.com"], outcome: "not_cited", observed_on: "2025-11-01" },
    { id: "o4", brokerage_id: A, query: "we are cited here", competitors_cited: ["rivalhomes.com"], outcome: "cited", observed_on: "2026-01-12" },
    { id: "o5", brokerage_id: B, query: "other tenant gap", competitors_cited: ["x.com"], outcome: "not_cited", observed_on: "2026-01-12" },
  )
  const readers: SuggestionReaders = { topicBank: async (_svc, b) => b === A ? [{ id: "tb-1", topic_title: "Staging that photographs well", value_angle: "what buyers notice first", categories: ["competitor_intel"], engagement_score: 50, is_brokerage_local: true }] : [] }
  const run = await runLeadMagnetSuggestions(r, A, { now: NOW, publish: false, readers })
  check("A6 the runner reads the three sources tenant-pinned: 1 competitor promotion, 1 live keyword (the expired one filtered), 1 AI-search gap (30 days, not_cited only) — nothing of tenant B",
    run.ok && run.sources?.competitor_intel === 1 && run.sources?.keyword === 1 && run.sources?.ai_search_gap === 1 && run.sources?.topic_bank === 0 && (run.sourceNotes ?? []).length === 0
    && !JSON.stringify(run.suggestions).includes("other tenant") && !JSON.stringify(run.suggestions).includes("stale keyword") && !JSON.stringify(run.suggestions).includes("an old gap"), JSON.stringify({ sources: run.sources, notes: run.sourceNotes }))
  check("A7 the gap aggregates its observations per query (2 observations, both competitors) and the keyword idea names the live keyword",
    run.suggestions.some((s) => s.kind === "ai_search_gap" && s.evidence.observations === 2 && JSON.stringify(s.evidence.competitors) === JSON.stringify(["otherbroker.com", "rivalhomes.com"]))
    && run.suggestions.some((s) => s.kind === "search_demand" && s.evidence.keyword === "sell my house fast" && s.magnetType === "seller_guide"))
  const refused = fixture({ refuse: { keyword_intelligence: "permission denied for table keyword_intelligence" } })
  refused.tables.ai_search_citation_observations.push({ id: "o1", brokerage_id: A, query: "best agent to sell a condo", competitors_cited: ["rivalhomes.com"], outcome: "not_cited", observed_on: "2026-01-10" })
  const runRefused = await runLeadMagnetSuggestions(refused, A, { now: NOW, publish: false, readers })
  check("A8 control — an unreadable source is REPORTED (sourceNotes) and the others still feed the sweep; the runner never throws",
    runRefused.ok && (runRefused.sourceNotes ?? []).some((n) => /keyword_intelligence read refused/.test(n)) && runRefused.sources?.keyword === 0 && runRefused.sources?.ai_search_gap === 1 && runRefused.sources?.competitor_intel === 1)
  const sug = code("lib/lead-magnets/suggestions.ts")
  check("A9 wiring: the runner reads the topic bank through the ONE picker (pickTopics — no direct content_topic_bank read; control: topic-bank.ts has it), pins keyword_intelligence + ai_search_citation_observations to the tenant, keys competitor rows on the category promote-to-topic-bank stamps",
    /import\("@\/lib\/content-intel\/topic-bank"\)/.test(sug) && /pickTopics\(\{\s*brokerageId:\s*b,/.test(sug) && !/from\("content_topic_bank"\)/.test(sug) && /from\("content_topic_bank"\)/.test(code("lib/content-intel/topic-bank.ts"))
    && /from\("keyword_intelligence"\)[\s\S]{0,400}?\.eq\("brokerage_id",\s*brokerageId\)/.test(sug) && /from\("ai_search_citation_observations"\)[\s\S]{0,400}?\.eq\("brokerage_id",\s*brokerageId\)[\s\S]{0,200}?\.eq\("outcome",\s*"not_cited"\)/.test(sug)
    && /"competitor_intel"/.test(code("lib/competitive-intel/promote-to-topic-bank.ts")))

  // ── B. THE FAIR-HOUSING REWRITE LOOP ──────────────────────────────────────
  console.log("\n── B. a flagged PUBLIC copy is rewritten WITH the findings, rechecked, capped, then escalated — private records are not moderated ──")
  const steerGate = (bad: string) => async (t: string): Promise<CopyScan> => t.includes(bad)
    ? { ok: false, findings: [{ phrase: bad, fix: "Describe the home, not who should want it", reference: "proof", severity: "high" }], warnings: [] }
    : { ok: true, findings: [], warnings: [] }
  const never: CopyRewriter = async () => { throw new Error("the rewriter must not run on clean copy") }
  const clean = await rewritePublicCopyUntilCompliant({ text: "A bright three-bedroom home near the park", surface: "ad", gate: steerGate("steer"), rewrite: never })
  check("B1 clean copy passes untouched — no rewrite, one scan in the trail", clean.ok && clean.rewrites === 0 && clean.escalated === false && clean.trail.length === 1 && clean.text === "A bright three-bedroom home near the park")
  const handed: { v: { phrase: string; fix: string; attempt: number } | null } = { v: null }
  const fixed = await rewritePublicCopyUntilCompliant({ text: "steer the buyer here", surface: "lead_magnet", gate: steerGate("steer"), rewrite: async (t, f, attempt) => { handed.v = { phrase: f[0].phrase, fix: f[0].fix, attempt }; return t.replace("steer", "show") } })
  check("B2 a flagged copy goes BACK with the specific findings (phrase + fix, attempt 1) and the rewritten copy passes: 1 rewrite, not escalated, trail 2",
    fixed.ok && fixed.rewrites === 1 && fixed.escalated === false && fixed.text === "show the buyer here" && handed.v?.phrase === "steer" && /Describe the home/.test(handed.v?.fix ?? "") && handed.v?.attempt === 1 && fixed.trail.length === 2 && fixed.trail[1].findings.length === 0)
  const stubborn = await rewritePublicCopyUntilCompliant({ text: "steer one", surface: "book", gate: steerGate("steer"), rewrite: async (t) => `${t} and steer again` })
  check(`B3 the cap: ${PUBLIC_COPY_MAX_REWRITES} rewrites that still fail → ESCALATED to a human with the findings and the whole trail kept`,
    !stubborn.ok && stubborn.rewrites === PUBLIC_COPY_MAX_REWRITES && stubborn.escalated === true && stubborn.findings.length === 1 && stubborn.trail.length === PUBLIC_COPY_MAX_REWRITES + 1)
  const gaveUp = await rewritePublicCopyUntilCompliant({ text: "steer two", surface: "social", gate: steerGate("steer"), rewrite: async () => null })
  const threw = await rewritePublicCopyUntilCompliant({ text: "steer three", surface: "listing", gate: steerGate("steer"), rewrite: async () => { throw new Error("model down") } })
  check("B4 a rewriter that returns null or throws ends the loop honestly — escalated after one attempt, the text unchanged, nothing thrown",
    !gaveUp.ok && gaveUp.rewrites === 1 && gaveUp.escalated && gaveUp.text === "steer two" && !threw.ok && threw.rewrites === 1 && threw.escalated && threw.text === "steer three")
  const realHit = await scanPublicCopy("A home that is perfect for families, with a big yard.", "lead_magnet")
  check("B5 the REAL scan uses the ONE pattern list: phrase → the compliant fix → the legal reference (lib/compliance-rules/fair-housing-patterns.ts)",
    !realHit.ok && realHit.findings.some((f) => f.phrase === "perfect for families" && f.fix === "Spacious layout with multiple bedrooms" && /3604/.test(f.reference) && f.severity === "high"), JSON.stringify(realHit))
  const privateSurfaces: CopySurface[] = ["cda", "settlement_statement", "internal_form", "private_note", "financial_record"]
  const publicSurfaces: CopySurface[] = ["listing", "ad", "landing_page", "lead_magnet", "book", "social", "video_script", "newsletter", "blog"]
  const cdaScan = await scanPublicCopy("A home that is perfect for families, with a big yard.", "cda")
  check("B6 POSITIVE CONTROL — the SAME text on a CDA / settlement / internal-form surface is NOT moderated (ok, no findings, the note says why); every public surface is",
    cdaScan.ok && cdaScan.findings.length === 0 && /not public housing marketing/.test(cdaScan.warnings[0] ?? "")
    && privateSurfaces.every((s) => !isPublicMarketingSurface(s)) && publicSurfaces.every((s) => isPublicMarketingSurface(s)))
  const realClean = await scanPublicCopy("Three bedrooms, a fenced yard and a short walk to the park.", "listing")
  check("B7 clean public copy passes the real scan; renderFindingsForRewrite is the ONE rendering the prompts use",
    realClean.ok && realClean.findings.length === 0 && renderFindingsForRewrite(realHit.findings.slice(0, 1)) === '- "perfect for families" → Spacious layout with multiple bedrooms (Fair Housing Act § 3604(c))')

  const c = fixture()
  const calls: Array<{ attempt: number; violations: string[] }> = []
  const drafted = await draftLeadMagnetFromConcept(
    { brokerageId: A, agentId: AGENT_A, createdBy: USER_A, concept: "A buyer guide for people moving out to the suburbs", magnetType: "buyer_guide" },
    { client: c, entitlement: async () => ({ allowed: true, reason: "subscription_current" }), generator: async (req) => {
      calls.push({ attempt: req.attempt ?? 0, violations: (req.violations ?? []).map((v) => `${v.phrase}→${v.fix}`) })
      return req.violations?.length
        ? { headline: "The suburbs guide", subhead: "Spacious layouts and room to grow", bullets: ["Commute math", "Yard upkeep", "School-district facts you verify yourself"] }
        : { headline: "The suburbs guide", subhead: "Perfect for families", bullets: ["x"] }
    } },
  )
  const draftRow = formRow(c, drafted.magnetId)
  check("B8 INTEGRATED: the AI draft's flagged copy is rewritten by the model WITH the findings and the REWRITTEN copy lands (fromAi), the trail recorded on the draft",
    drafted.success && drafted.fromAi === true && drafted.fairHousing?.rewrites === 1 && drafted.fairHousing?.escalated === false && calls.length === 2 && calls[1].attempt === 1
    && calls[1].violations[0] === "perfect for families→Spacious layout with multiple bedrooms" && draftRow?.landing_content?.subhead === "Spacious layouts and room to grow"
    && draftRow?.settings?.authoring?.fair_housing?.ok === true && draftRow?.settings?.authoring?.fair_housing?.trail?.length === 2, JSON.stringify({ drafted, calls }))
  const bellsBefore = rows(c, "notifications").length
  const stuck = await draftLeadMagnetFromConcept(
    { brokerageId: A, agentId: AGENT_A, createdBy: USER_A, concept: "A buyer guide for people moving out to the suburbs again", magnetType: "buyer_guide" },
    { client: c, entitlement: async () => ({ allowed: true, reason: "subscription_current" }), generator: async (req) => ({ headline: "The suburbs guide", subhead: `Perfect for families, attempt ${req.attempt ?? 0}`, bullets: ["x"] }) },
  )
  const stuckRow = formRow(c, stuck.magnetId)
  const bell = rows(c, "notifications").find((n) => n.type === "lead_magnet_fair_housing_review" && n.entity_id === stuck.magnetId)
  const stuckLedger = ledger(c, "marketing.lead_magnet.ai_draft").find((l) => l.provider_ref === stuck.magnetId || l.detail?.fair_housing_escalated === true)
  check("B9 a STUBBORN draft (still flagged after the cap) falls to the safe baseline, ESCALATES to the requester (in-app bell, live channel/priority values) and the ledger says so",
    stuck.success && stuck.fromAi === false && stuck.fairHousing?.rewrites === PUBLIC_COPY_MAX_REWRITES && stuck.fairHousing?.escalated === true && /escalated to the reviewer/.test(stuck.fallbackReason ?? "")
    && stuckRow?.landing_content?.subhead !== `Perfect for families, attempt ${PUBLIC_COPY_MAX_REWRITES}` && stuckRow?.settings?.authoring?.fair_housing?.escalated === true
    && rows(c, "notifications").length === bellsBefore + 1 && !!bell && bell.user_id === USER_A && bell.brokerage_id === A
    && CHECK_VOCABULARIES.notifications.channel.includes(bell.channel) && CHECK_VOCABULARIES.notifications.priority.includes(bell.priority)
    && !!stuckLedger && stuckLedger.detail?.fair_housing_rewrites === PUBLIC_COPY_MAX_REWRITES, JSON.stringify({ stuck, bell }))
  const landing = (subhead: string) => ({ headline: "Your move, planned", subhead, cta: "Send it", bullets: ["Timing", "Pricing", "Prep"], topics: [], faq: [], faqJsonLd: null, fromTopics: false, generatedAt: NOW.toISOString() })
  const flaggedDraft = await createLeadMagnet({ title: "Edited into trouble", description: "", magnetType: "seller_guide", brokerageId: A, agentId: AGENT_A, createdBy: USER_A, publishState: "draft", landingContent: landing("An adult community, great for retirees") }, { client: c })
  const pubFlagged = await publishLeadMagnet({ magnetId: flaggedDraft.magnetId!, brokerageId: A, channels: ["landing_page"], actorUserId: USER_A, baseUrl: ORIGIN }, { client: c })
  const cleanDraft = await createLeadMagnet({ title: "Edited well", description: "", magnetType: "seller_guide", brokerageId: A, agentId: AGENT_A, createdBy: USER_A, publishState: "draft", landingContent: landing("Single-level living with accessible features") }, { client: c })
  const pubClean = await publishLeadMagnet({ magnetId: cleanDraft.magnetId!, brokerageId: A, channels: ["landing_page"], actorUserId: USER_A, baseUrl: ORIGIN }, { client: c })
  check("B10 the HUMAN'S PUBLISH is the last gate: the copy the reviewer edited is re-scanned — a hard flag is REFUSED naming the phrases and fixes, the row stays a draft; clean copy publishes (control)",
    !pubFlagged.success && /Fair-housing review/.test(pubFlagged.error ?? "") && /great for retirees/.test(pubFlagged.error ?? "") && /Single-level living/.test(pubFlagged.error ?? "") && formRow(c, flaggedDraft.magnetId).is_active === false
    && pubClean.success && formRow(c, cleanDraft.magnetId).is_active === true, JSON.stringify({ pubFlagged, pubClean }))
  const importers = walk(join(root, "lib")).concat(walk(join(root, "app"))).filter((f) => /public-copy-rewrite["']/.test(code(f.slice(root.length + 1))))
  check("B11 the loop is wired into the FOUR public-copy producers (ai-draft, landing copy, ads, the book) + the kernel's publish — and NOT into any CDA / settlement / commission / financial module (importer census, control: ≥5 importers found)",
    importers.length >= 5 && ["lib/lead-magnets/ai-draft.ts", "app/actions/marketing/lead-magnet-copy.ts", "lib/ads/ad-creator.ts", "lib/lead-magnets/book-creator.ts", "lib/kernel/lead-magnets.ts"].every((p) => importers.some((f) => f.endsWith(p)))
    && !importers.some((f) => /cda|settlement|hud|commission|financ|closing/i.test(f.slice(root.length))), importers.map((f) => f.slice(root.length + 1)).join(", "))
  const adSrc = code("lib/ads/ad-creator.ts"), copyAct = code("app/actions/marketing/lead-magnet-copy.ts"), draftSrc = code("lib/lead-magnets/ai-draft.ts")
  check("B12 ads: a rejected variation re-enters the routed lane with the findings, is RE-GATED through the SAME five gates (evaluateOutbound), and the compliance_events row records the rewrites before the human got it",
    /surface:\s*"ad"/.test(adSrc) && /latestGate = await gateFor\(latest\)/.test(adSrc) && /feature:\s*"marketing_script_generation"/.test(adSrc) && /after \$\{rewriteAttempts\} AI rewrite/.test(adSrc))
  check("B13 landing copy + the AI draft: surface landing_page / lead_magnet, the routed lane lead_magnet_draft booked under the SESSION tenant, the findings handed to the generator as violations",
    /surface:\s*"landing_page"/.test(copyAct) && /feature:\s*"lead_magnet_draft"/.test(copyAct) && /getAgentContext\(\)/.test(copyAct) && /surface:\s*"lead_magnet"/.test(draftSrc) && /violations:\s*findings/.test(draftSrc))

  // ── C. OMNIPRESENCE ────────────────────────────────────────────────────────
  console.log("\n── C. an approved magnet fans out across channels through the existing staging — proposed, tenant-pinned, never a draft ──")
  const actSrc = code("app/actions/lead-magnets-actions.ts"), mkt = code("lib/agents/marketing-agent-actions.ts")
  check("C1 the publish action PROPOSES one omnipresence_topic_fanout carrying lead_magnet_id (recordProposedActions) only after the publish landed — never executeAction (the human approves distribution)",
    /published\.success && fanoutChannels\.length > 0/.test(actSrc) && /action_type:\s*"omnipresence_topic_fanout"/.test(actSrc) && /lead_magnet_id:\s*magnetId/.test(actSrc) && /recordProposedActions\(/.test(actSrc) && !/executeAction\(/.test(actSrc))
  const handler = mkt.slice(mkt.indexOf('case "omnipresence_topic_fanout"'), mkt.indexOf('case "omnipresence_topic_fanout"') + 9000)
  check("C2 the handler accepts a lead magnet: tenant-pinned read, a DRAFT refused, the creative reference (lead_magnet_id + landing_url) rides social post_brief, blog + newsletter through the staging survivors, direct mail reported honestly (not faked)",
    /input\.lead_magnet_id/.test(handler) && /from\("lead_capture_forms"\)[\s\S]{0,300}?\.eq\("brokerage_id",\s*brokerageId\)/.test(handler) && /lifecycle\?\.state === "draft"/.test(handler)
    && /creativeRef = magnet \? \{ lead_magnet_id: magnet\.id, landing_url: magnet\.landingUrl \}/.test(handler) && /post_brief:\s*\{\s*\.\.\.creativeRef/.test(handler)
    && /stageBlogDraft\(/.test(handler) && /stageNewsletterDraft\(/.test(handler) && /ch === "direct_mail_postcard" && magnet[\s\S]{0,300}?ok: false/.test(handler))
  check("C2 control — the topic-bank path survives beside it (content_topic_bank read, tenant scope rule)", /from\("content_topic_bank"\)/.test(handler) && /topic outside tenant/.test(handler))

  // ── D. CREATIVE ACCESSIBLE TO FOLLOW-UP ───────────────────────────────────
  console.log("\n── D. the approved creative is referenced where follow-up reads ──")
  const ref: LeadMagnetBookRef | null = leadMagnetBookRefOf({ book: { stage: "ready_for_review", pdf_url: `${ORIGIN}/b.pdf`, document_id: "doc-1", title: "The Book", chapters: [{}, {}, {}] } })
  check("D1 leadMagnetBookRefOf — only a FINISHED, hosted book counts (stage + pdf); earlier stages, no pdf, no book → null",
    ref?.pdfUrl === `${ORIGIN}/b.pdf` && ref?.documentId === "doc-1" && ref?.title === "The Book" && ref?.chapters === 3
    && leadMagnetBookRefOf({ book: { stage: "layout", pdf_url: `${ORIGIN}/b.pdf` } }) === null && leadMagnetBookRefOf({ book: { stage: "ready_for_review", pdf_url: null } }) === null && leadMagnetBookRefOf(null) === null && leadMagnetBookRefOf({}) === null)
  const kernelSrc = code("lib/kernel/lead-magnets.ts"), delivery = code("lib/marketing/lead-magnet-delivery-runner.ts")
  check("D2 the capture hands the finished book + the magnet id to delivery; the delivery ships the hosted PDF (no re-render) and records magnet / pdf / document / kind on the activity the AI ISA's readers see",
    /deliverMagnet\(\{[^}]*magnetId:\s*input\.formId[^}]*book:\s*leadMagnetBookRefOf\(/.test(kernelSrc) && /args\.book\?\.pdfUrl/.test(delivery) && /deliverableKind = "book"/.test(delivery)
    && /metadata:\s*\{[^}]*\.\.\.args\.refs/.test(delivery) && /magnet_id:\s*args\.magnetId/.test(delivery) && /document_id:\s*documentId/.test(delivery)
    && /from\("activities"\)/.test(code("lib/ai-isa/tools.ts")))
  check("D3 the book is a document-library row (produceClientDocument documentType 'book'); blind spot published: generated_documents.document_type carries no live CHECK",
    /"recruiting_pitch" \| "book"/.test(code("lib/documents/client-document-producer.ts")) && /documentType:\s*"book"/.test(code("lib/lead-magnets/book-creator.ts")) && (CHECK_VOCABULARIES as Record<string, unknown>).generated_documents === undefined)

  // ── E. THE BOOK ────────────────────────────────────────────────────────────
  console.log("\n── E. the book: research → outline → chapters → fact check → edit → cover/layout → REAL PDF → review → revise → publish → capture ──")
  const order: BookStage[] = ["research"]
  while (order[order.length - 1] !== "ready_for_review") order.push(nextBookStage(order[order.length - 1]))
  check("E1 pure: the stage order is the contract (research → outline → chapters → fact_check → edit → layout → ready_for_review), terminal stays terminal; a 4-10 chapter book",
    JSON.stringify(order) === JSON.stringify(BOOK_STAGES) && nextBookStage("ready_for_review") === "ready_for_review" && BOOK_MIN_CHAPTERS === 4 && BOOK_MAX_CHAPTERS >= BOOK_MIN_CHAPTERS && BOOK_CHAPTERS_PER_ADVANCE >= 1 && BOOK_MIN_CHAPTER_WORDS >= 200)
  check("E2 pure: unsupportedFigures catches every figure the research never supplied ($450,000, 2023) and passes the one it did (12%); workingTitle / parseJsonObject / wordCount",
    JSON.stringify(unsupportedFigures("Prices rose 12% in 2023 to about $450,000 across 90 days.", "research says about 12% all-in and 90 days")) === JSON.stringify(["2023", "$450,000"])
    && unsupportedFigures("No figures here at all.", "").length === 0 && workingTitle("a seller's book on pricing. more words") === "A seller's book on pricing"
    && parseJsonObject<{ a: number }>('sure: {"a": 1} done')?.a === 1 && parseJsonObject("nope") === null && wordCount("one two  three\nfour") === 4)

  const FILL = "Walk through each step with your agent, ask what the paperwork means before you sign it, and keep a simple folder of every document the process produces so nothing is lost when a question comes up later."
  const body = (lead: string) => [lead, `${FILL} ${FILL}`, `${FILL} ${FILL}`, `${FILL} ${FILL}`, `${FILL} ${FILL}`].join("\n\n")
  const CHAPTERS = [
    body("Closing costs are the fees that settle the sale, and in 2023 a typical buyer here paid around $450,000 for a home while fees ran near 12% in the worst case."),
    body("This neighborhood is perfect for families who want room to grow, and the homes show it."),
    body("Single-level homes here are great for retirees looking to downsize without giving up space."),
    body("Pricing to the market in the first two weeks decides how the sale goes, so the first number matters more than the last."),
  ]
  const outline = {
    title: "The Smart Seller's Playbook", subtitle: "Pricing, prep and closing without the guesswork", tagline: "What the first two weeks decide",
    introduction: "Selling a home is a sequence of decisions, not a single event.\n\nThis book walks the sequence in order.",
    closing: "When you are ready, let's talk about how this applies to your home.",
    chapters: [
      { heading: "What closing actually costs", summary: "The fees that settle a sale.", key_points: ["who pays what", "when it is due"] },
      { heading: "Preparing the home", summary: "What buyers notice first.", key_points: ["staging that photographs well", "repairs worth doing"] },
      { heading: "Choosing the right layout story", summary: "Describing the home, never the buyer.", key_points: ["features over labels"] },
      { heading: "Pricing to the market", summary: "The first two weeks.", key_points: ["the first number", "reading the response"] },
    ],
  }
  const research = [{ topic: "How much do closing costs run as a share of price (about 12% all-in is a myth)", score: 9 }, { topic: "When should I list to catch the spring market", score: 8 }]
  const modelCalls: string[] = []
  const fhRewriteAsks: number[] = []
  let stubbornAttempt = 0
  const manuscriptWriter: NonNullable<BookDeps["manuscriptWriter"]> = async (req) => {
    modelCalls.push(req.prompt.slice(0, 30))
    if (/Return ONLY JSON: \{"title"/.test(req.prompt)) return { text: `Here it is:\n${JSON.stringify(outline)}`, tokens: 500, model: "stub" }
    const ch = req.prompt.match(/Write chapter (\d+) of \d+/)
    if (ch) return { text: CHAPTERS[Number(ch[1]) - 1], tokens: 900, model: "stub" }
    const ed = req.prompt.match(/Chapter (\d+): "/)
    if (ed && /CURRENT TEXT:/.test(req.prompt)) {
      const i = Number(ed[1])
      if (/FACT-CHECK FINDINGS/.test(req.prompt)) return { text: body("Closing costs are the fees that settle the sale, and the share they take depends on the lender, the title company and the local customs your agent walks you through."), tokens: 700, model: "stub" }
      if (/FAIR-HOUSING FINDINGS/.test(req.prompt)) {
        fhRewriteAsks.push(i)
        if (i === 3) { stubbornAttempt++; return { text: body(`Single-level homes here are great for retirees, truly, attempt ${stubbornAttempt}.`), tokens: 700, model: "stub" } }
        return { text: body("Homes in this area offer flexible layouts with room to grow into, and the yards show it."), tokens: 700, model: "stub" }
      }
    }
    return null
  }
  const factCheckWriter: NonNullable<BookDeps["factCheckWriter"]> = async (req) => {
    modelCalls.push("fact-check")
    return /=== CHAPTER 1:/.test(req.prompt) ? { text: '{"findings":[{"chapter":1,"claim":"$450,000","verdict":"unsupported","note":"no source in the research"}]}', tokens: 300, model: "stub" } : { text: '{"findings":[]}', tokens: 100, model: "stub" }
  }
  const brand: ClientPdfBrand = { brokerageName: "Alpha Realty", agentName: "Ann Agent", primaryColor: "#1D4ED8", licenseLine: "Lic #A-1 (TX)", showEhoMark: true }
  let producedPages = 0
  let producedBytes: Uint8Array | null = null
  const producer: NonNullable<BookDeps["producer"]> = async (svc, args) => {
    const bytes = await renderClientPdf(args.spec)
    const doc = await PDFDocument.load(bytes)
    producedBytes = bytes
    producedPages = doc.getPageCount()
    const { data, error } = await (svc as any).from("generated_documents").insert({ brokerage_id: args.brokerageId, agent_user_id: args.agentUserId, document_type: "book", title: args.spec.title, file_url: `${ORIGIN}/docs/book.pdf`, metadata: args.metadata }).select("id").maybeSingle()
    if (error || !data) return { ok: false, pdfUrl: null, documentId: null, pageCount: null, error: error?.message ?? "no row" }
    return { ok: true, pdfUrl: `${ORIGIN}/docs/book.pdf`, documentId: data.id, pageCount: doc.getPageCount(), error: null }
  }
  const audience: BookAudience = "seller"
  const concept = "A seller's book on pricing, prep and closing for homeowners listing this year"
  const deps: BookDeps = { client: c, entitlement: allow, researcher: async () => research, topicReader: async () => ["Staging that photographs well — what buyers notice first"], manuscriptWriter, factCheckWriter, brandResolver: async () => brand, producer, now: NOW }

  const formsBefore = rows(c, "lead_capture_forms").length
  const refusedStart = await startBookProject({ brokerageId: A, agentId: AGENT_A, createdBy: USER_A, concept, audience }, { client: c, entitlement: async () => ({ allowed: false, reason: "ai_budget_exhausted", message: "AI budget used up" }) })
  check("E3 control — an entitlement refusal writes NOTHING (no row, no ledger) and says why",
    !refusedStart.success && /AI budget used up/.test(refusedStart.error ?? "") && rows(c, "lead_capture_forms").length === formsBefore && ledger(c, "marketing.lead_magnet.book_start").length === 0)
  const started = await startBookProject({ brokerageId: A, agentId: AGENT_A, createdBy: USER_A, concept, audience, area: "Riverbend", brand: "Alpha Realty" }, { client: c, entitlement: allow, now: NOW })
  const bookRow = () => formRow(c, started.magnetId)
  check("E4 concept → a DRAFT lead magnet (seller_guide, inactive) carrying the book project at stage research, authored by AI (kind book), one ledger row marketing.lead_magnet.book_start",
    started.success && started.title === workingTitle(concept) && bookRow()?.is_active === false && bookRow()?.magnet_type === "seller_guide" && bookRow()?.settings?.lifecycle?.state === "draft"
    && bookRow()?.settings?.book?.stage === "research" && bookRow()?.settings?.authoring?.kind === "book" && ledger(c, "marketing.lead_magnet.book_start").length === 1 && ledger(c, "marketing.lead_magnet.book_start")[0].status === "executed", JSON.stringify(started))
  const plain = await createLeadMagnet({ title: "Not a book", description: "", magnetType: "generic_form", brokerageId: A, agentId: AGENT_A, createdBy: USER_A, publishState: "draft" }, { client: c })
  const noBook = await advanceBookProject({ brokerageId: A, magnetId: plain.magnetId!, actorUserId: USER_A }, deps)
  const wrongTenant = await advanceBookProject({ brokerageId: B, magnetId: started.magnetId!, actorUserId: USER_B }, deps)
  check("E5 controls — a magnet without a book is not a book project; another tenant cannot advance it", !noBook.success && /carries no book project/.test(noBook.error ?? "") && !wrongTenant.success && /not found in this brokerage/.test(wrongTenant.error ?? ""))

  const adv = (label: string) => advanceBookProject({ brokerageId: A, magnetId: started.magnetId!, actorUserId: USER_A }, deps).then((r) => { if (!r.success) fails.push(`advance ${label}: ${r.error}`); return r })
  const s1 = await adv("research")
  check("E6 RESEARCH: the gated search rail (demand topics) + the tenant's topic bank are recorded on the project; stage → outline",
    s1.success && s1.stage === "outline" && bookRow().settings.book.research.topics.length === 2 && bookRow().settings.book.research.bank_topics.length === 1 && /2 demand topic/.test(s1.note ?? ""))
  const s2 = await adv("outline")
  check("E7 OUTLINE (routed lane, JSON parsed out of prose): title / subtitle / tagline / intro / closing / 4 chapters; the magnet's NAME becomes the title; stage → chapters",
    s2.success && s2.stage === "chapters" && bookRow().settings.book.title === "The Smart Seller's Playbook" && bookRow().name === "The Smart Seller's Playbook" && bookRow().settings.book.outline.length === 4 && bookRow().settings.book.tagline === "What the first two weeks decide")
  const s3 = await adv("chapters 1-2")
  const s4 = await adv("chapters 3-4")
  check(`E8 ORIGINAL CHAPTERS are written ${BOOK_CHAPTERS_PER_ADVANCE} per advance (bounded), each ≥ ${BOOK_MIN_CHAPTER_WORDS} words; the stage moves on only when every outline chapter exists`,
    s3.success && s3.stage === "chapters" && s3.project?.chapters.length === BOOK_CHAPTERS_PER_ADVANCE && s4.success && s4.stage === "fact_check" && bookRow().settings.book.chapters.length === 4 && bookRow().settings.book.chapters.every((ch: { words: number }) => ch.words >= BOOK_MIN_CHAPTER_WORDS))
  const s5 = await adv("fact check")
  const findings = (bookRow().settings.book.fact_check?.findings ?? []) as Array<{ chapter: number; claim: string; by: string }>
  check("E9 FACT CHECK: the deterministic figure scan catches $450,000 and 2023 (never supplied) and passes 12% (supplied); the model's finding is kept beside it; stage → edit",
    s5.success && s5.stage === "edit" && findings.some((f) => f.chapter === 1 && f.claim === "$450,000" && f.by === "scan") && findings.some((f) => f.chapter === 1 && f.claim === "2023" && f.by === "scan")
    && findings.some((f) => f.chapter === 1 && f.claim === "$450,000" && f.by === "model") && !findings.some((f) => f.claim === "12%") && findings.every((f) => f.chapter === 1), JSON.stringify(findings))
  const s6 = await adv("edit 1-2")
  const s7 = await adv("edit 3-4")
  const chapters = bookRow().settings.book.chapters as Array<{ body: string; edited?: { fact_findings: number; fair_housing_rewrites: number; escalated: boolean; findings: string[] } }>
  check("E10 EDIT: chapter 1's figures are removed (fact findings resolved, no fair-housing rewrite); chapter 2's steering phrase is rewritten WITH the findings (1 rewrite, clean); chapter 4 untouched",
    s6.success && s6.stage === "edit" && chapters[0].edited?.fact_findings === 3 && !/\$450,000|2023/.test(chapters[0].body) && chapters[0].edited?.fair_housing_rewrites === 0
    && chapters[1].edited?.fair_housing_rewrites === 1 && chapters[1].edited?.escalated === false && !/perfect for families/.test(chapters[1].body) && /room to grow into/.test(chapters[1].body)
    && chapters[3].edited?.fair_housing_rewrites === 0 && fhRewriteAsks.filter((i) => i === 2).length === 1, JSON.stringify(chapters.map((ch) => ch.edited)))
  check(`E11 EDIT: the STUBBORN chapter 3 hits the cap (${PUBLIC_COPY_MAX_REWRITES} rewrites, still 'great for retirees') → ESCALATED, listed in needs_human_review; stage → layout`,
    s7.success && s7.stage === "layout" && chapters[2].edited?.fair_housing_rewrites === PUBLIC_COPY_MAX_REWRITES && chapters[2].edited?.escalated === true && chapters[2].edited?.findings.includes("great for retirees")
    && JSON.stringify(bookRow().settings.book.needs_human_review) === "[3]" && fhRewriteAsks.filter((i) => i === 3).length === PUBLIC_COPY_MAX_REWRITES && /1 escalated to the reviewer/.test(s7.note ?? ""))
  const s8 = await adv("layout")
  const book = bookRow().settings.book as BookProject
  check("E12 COVER + CONTENTS + LAYOUT: a REAL multi-page PDF (cover page, table of contents, intro, one page per chapter, closing) is produced, hosted and recorded in the document library; stage → ready_for_review; the landing page names the book",
    s8.success && s8.done === true && s8.stage === "ready_for_review" && producedBytes !== null && Buffer.from((producedBytes as Uint8Array).slice(0, 5)).toString() === "%PDF-" && producedPages >= 2 + 1 + 4 + 1
    && book.pdf_url === `${ORIGIN}/docs/book.pdf` && !!book.document_id && rows(c, "generated_documents").some((d) => d.id === book.document_id && d.document_type === "book" && d.brokerage_id === A && d.metadata?.magnet_id === started.magnetId)
    && book.page_count === producedPages && bookRow().landing_content?.headline === "The Smart Seller's Playbook" && bookRow().landing_content?.cta === "Send me the book", JSON.stringify({ s8: { ...s8, project: undefined }, producedPages }))
  const spec = bookPdfSpec(composeBookPdfData(book), brand, "January 2026")
  check("E13 the PDF spec is the booklet engine's (cover page, contents, intro + chapters + 'Your next step', the disclaimer); a second render is deterministic in page count",
    !!spec.coverPage && spec.tableOfContents === true && spec.sections.length === 1 + 4 + 1 && spec.sections[1].pageBreak === true && /not legal, tax, or lending advice/.test(spec.disclaimer ?? "")
    && (await PDFDocument.load(await renderClientPdf(spec))).getPageCount() === producedPages)
  check("E14 EVIDENCE + COST: one ledger row per advance (marketing.lead_magnet.book_stage, executed, the reviewer as actor) and the project's own tally — 1 outline + 4 chapters + 1 fact check + 4 edits = 10 model calls, tokens counted",
    ledger(c, "marketing.lead_magnet.book_stage").length === 8 && ledger(c, "marketing.lead_magnet.book_stage").every((l) => l.status === "executed" && l.actor_user_id === USER_A)
    && book.cost.model_calls === 10 && book.cost.tokens > 0 && modelCalls.length === 10 && book.log.length >= 9, JSON.stringify({ ledger: ledger(c, "marketing.lead_magnet.book_stage").length, cost: book.cost }))
  const again = await adv("after done")
  check("E15 advancing a finished book is a no-op (done, no new ledger row)", again.success && again.done === true && ledger(c, "marketing.lead_magnet.book_stage").length === 8)

  const pubPending = await publishLeadMagnet({ magnetId: started.magnetId!, brokerageId: A, channels: ["landing_page"], actorUserId: USER_A, baseUrl: ORIGIN }, { client: c })
  check("E16 HUMAN APPROVAL fails closed while a chapter awaits the human's fair-housing rewrite (names chapter 3); the row stays a draft",
    !pubPending.success && /chapter 3/.test(pubPending.error ?? "") && /fair-housing/i.test(pubPending.error ?? "") && bookRow().is_active === false, JSON.stringify(pubPending))
  const badRevision = await reviseBookChapter({ brokerageId: A, magnetId: started.magnetId!, chapter: 3, body: body("Still an adult community, great for retirees."), actorUserId: USER_A }, deps)
  const shortRevision = await reviseBookChapter({ brokerageId: A, magnetId: started.magnetId!, chapter: 3, body: "Too short.", actorUserId: USER_A }, deps)
  const revised = await reviseBookChapter({ brokerageId: A, magnetId: started.magnetId!, chapter: 3, body: body("Single-level homes here offer accessible features and easy upkeep without giving up space."), actorUserId: USER_A }, deps)
  const afterRevise = bookRow().settings.book as BookProject
  check("E17 the human REVISES the escalated chapter: a steering revision is refused (the scan runs on the human's words too), a stub is refused, a clean one clears the review list and sends the book back to LAYOUT for a fresh PDF",
    !badRevision.success && /great for retirees/.test(badRevision.error ?? "") && !shortRevision.success && /words/.test(shortRevision.error ?? "")
    && revised.success && afterRevise.stage === "layout" && afterRevise.pdf_url === null && afterRevise.needs_human_review.length === 0 && afterRevise.chapters[2].edited?.escalated === false && /accessible features/.test(afterRevise.chapters[2].body)
    && ledger(c, "marketing.lead_magnet.book_revise").length === 1, JSON.stringify({ badRevision, shortRevision, revised: { ...revised, project: undefined } }))
  const s9 = await adv("re-layout")
  const pubBook = await publishLeadMagnet({ magnetId: started.magnetId!, brokerageId: A, channels: ["landing_page"], actorUserId: USER_A, baseUrl: ORIGIN }, { client: c })
  check("E18 re-layout renders the corrected book (ready again, hosted) and the human's publish now lands: the row is live, lifecycle approved_by the reviewer",
    s9.success && s9.stage === "ready_for_review" && !!bookRow().settings.book.pdf_url && pubBook.success && bookRow().is_active === true && bookRow().settings.lifecycle.approved_by === USER_A, JSON.stringify(pubBook))
  const refAfter = leadMagnetBookRefOf(bookRow().settings)
  const cap = await captureFormSubmission({ formId: started.magnetId!, brokerageId: A, submissionData: { first_name: "Rae", last_name: "Reader", email: "rae@reader.test" }, tcpaConsentGiven: true, source: "landing_page" }, { client: c })
  check("E19 CAPTURE: a visitor's submission on the published book lands (contact + submission); the kernel's delivery reads the finished book through leadMagnetBookRefOf (4 chapters, the hosted PDF)",
    cap.success && !!cap.contactId && rows(c, "form_submissions").some((s) => s.form_id === started.magnetId) && refAfter?.chapters === 4 && refAfter?.pdfUrl === bookRow().settings.book.pdf_url && refAfter?.title === "The Smart Seller's Playbook", JSON.stringify(cap))
  const shortWriter: BookDeps = { ...deps, manuscriptWriter: async (req) => /Return ONLY JSON: \{"title"/.test(req.prompt) ? manuscriptWriter(req) : { text: "A stub chapter that is far too short to ship.", tokens: 10, model: "stub" } }
  const p4 = await startBookProject({ brokerageId: A, agentId: AGENT_A, createdBy: USER_A, concept: "A buyer's book on offers, inspections and the closing table", audience: "buyer" }, { client: c, entitlement: allow, now: NOW })
  await advanceBookProject({ brokerageId: A, magnetId: p4.magnetId!, actorUserId: USER_A }, shortWriter)
  await advanceBookProject({ brokerageId: A, magnetId: p4.magnetId!, actorUserId: USER_A }, shortWriter)
  const ledgerBefore = ledger(c, "marketing.lead_magnet.book_stage").length
  const stubChapter = await advanceBookProject({ brokerageId: A, magnetId: p4.magnetId!, actorUserId: USER_A }, shortWriter)
  check("E20 control — a chapter under the word floor is REFUSED: the stage does not move, nothing is saved, no ledger row, the error names the chapter",
    !stubChapter.success && stubChapter.stage === "chapters" && /Chapter 1 did not land/.test(stubChapter.error ?? "") && formRow(c, p4.magnetId).settings.book.chapters.length === 0 && ledger(c, "marketing.lead_magnet.book_stage").length === ledgerBefore, JSON.stringify(stubChapter))
  const stale = await startBookProject({ brokerageId: A, agentId: AGENT_A, createdBy: USER_A, concept: "A seller's book left in a closed tab for twenty minutes", audience: "seller" }, { client: c, entitlement: allow, now: new Date(NOW.getTime() - 20 * 60_000) })
  const fresh = await startBookProject({ brokerageId: A, agentId: AGENT_A, createdBy: USER_A, concept: "A seller's book the reviewer is watching right now", audience: "seller" }, { client: c, entitlement: allow, now: NOW })
  const sweep = await sweepStalledBookProjects(c, A, { staleMinutes: 15, now: NOW, deps })
  check("E21 THE SAFETY NET: the sweep advances only the STALE unfinished project (one stage), leaves the fresh one and the finished books alone, reports errors",
    sweep.advanced === 1 && sweep.errors.length === 0 && formRow(c, stale.magnetId).settings.book.stage === "outline" && formRow(c, fresh.magnetId).settings.book.stage === "research" && bookRow().settings.book.stage === "ready_for_review", JSON.stringify(sweep))

  // ── F. CONSOLIDATION ───────────────────────────────────────────────────────
  console.log("\n── F. the admin Forms Manager's lead-capture half merged onto the lead-magnet survivor ──")
  check("F1 the declared persona is the live contacts vocabulary's buyer / seller / both; declarableContactType normalises and drops the rest",
    FORM_DECLARABLE_CONTACT_TYPES.every((t) => CHECK_VOCABULARIES.contacts.contact_type.includes(t)) && declarableContactType(" Seller ") === "seller" && declarableContactType("lead") === null && declarableContactType(null) === null)
  const g1 = await createLeadMagnet({ title: "Ask us anything", description: "", magnetType: "generic_form", brokerageId: A, agentId: AGENT_A, createdBy: USER_A, settings: { default_contact_type: "seller" } }, { client: c })
  const g2 = await createLeadMagnet({ title: "Ask us anything, unspecified", description: "", magnetType: "generic_form", brokerageId: A, agentId: AGENT_A, createdBy: USER_A }, { client: c })
  const g3 = await createLeadMagnet({ title: "Buyer guide declared seller", description: "", magnetType: "buyer_guide", brokerageId: A, agentId: AGENT_A, createdBy: USER_A, settings: { default_contact_type: "seller" } }, { client: c })
  await captureFormSubmission({ formId: g1.magnetId!, brokerageId: A, submissionData: { first_name: "Sal", last_name: "Seller", email: "sal@seller.test" }, tcpaConsentGiven: true, language: "es" }, { client: c })
  await captureFormSubmission({ formId: g2.magnetId!, brokerageId: A, submissionData: { first_name: "Una", last_name: "Unknown", email: "una@unknown.test" }, tcpaConsentGiven: true }, { client: c })
  await captureFormSubmission({ formId: g3.magnetId!, brokerageId: A, submissionData: { first_name: "Bo", last_name: "Buyer", email: "bo@buyer.test" }, tcpaConsentGiven: true }, { client: c })
  const sal = rows(c, "contacts").find((x) => x.email === "sal@seller.test"), una = rows(c, "contacts").find((x) => x.email === "una@unknown.test"), bo = rows(c, "contacts").find((x) => x.email === "bo@buyer.test")
  check("F2 the ONE capture command honours the declared persona on a custom form (seller) and the intake locale; unspecified stays null (never guessed); the magnet's own intent wins over a declaration (control)",
    sal?.contact_type === "seller" && sal?.metadata?.captured_language === "es" && (una?.contact_type ?? null) === null && bo?.contact_type === "buyer", JSON.stringify({ sal, una, bo }))
  const fm = code("app/dashboard/admin/forms/FormsManagerClient.tsx"), fp = code("app/dashboard/admin/forms/page.tsx"), post = code("app/api/admin/forms/route.ts"), patch = code("app/api/admin/forms/[id]/route.ts"), submit = code("app/api/forms/submit/route.ts")
  check("F3 the second builder is GONE: no create/edit modal, no /api/admin/forms fetch, no lead_capture_forms read on the page; lead capture points at the survivor; the transaction-forms tab survives",
    !/fetch\(['"`]\/api\/admin\/forms/.test(fm) && !/openCreate|openEdit|toggleActive/.test(fm) && /\/dashboard\/marketing\/lead-magnets/.test(fm) && /transaction-forms/.test(fm) && !/from\(['"]lead_capture_forms['"]\)/.test(fp))
  check("F4 the two admin doors are THIN doors onto the kernel: POST → createLeadMagnet (no raw insert; tenant + agent from the session, agents.id via users.id), PATCH → an allow-list with a COUNTED tenant-pinned update (no verbatim body)",
    /createLeadMagnet\(\{/.test(post) && !/\.insert\(/.test(post) && /from\('agents'\)[\s\S]{0,200}?\.eq\('user_id',\s*user\.id\)/.test(post) && !/body\.brokerage_id/.test(post)
    && /const PATCHABLE = new Set\(/.test(patch) && !/\.update\(body\)/.test(patch) && /\.update\(patch\)[\s\S]{0,200}?\.eq\('brokerage_id',\s*profile\.brokerage_id\)[\s\S]{0,100}?\.select\('id'\)/.test(patch) && /length !== 1/.test(patch))
  check("F5 /forms/[slug] captures through captureFormSubmission (no second pipeline: no captureContact, no form_submissions insert, no counter RPC) and the renderer sends the consent it collects; control: the kernel still holds the ONE form_submissions insert",
    /captureFormSubmission\(\{/.test(submit) && !/captureContact\(/.test(submit) && !/from\('form_submissions'\)/.test(submit) && !/increment_form_submission_count/.test(submit) && /language:\s*capturedLanguage/.test(submit)
    && /tcpaConsent:\s*tcpaChecked/.test(code("app/forms/[slug]/FormRenderer.tsx")) && /from\("form_submissions"\)[\s\S]{0,120}?\.insert\(/.test(kernelSrc))

  // ── G. WIRING ──────────────────────────────────────────────────────────────
  console.log("\n── G. wired, owned, routed ──")
  const pkg = JSON.parse(raw("package.json")) as { scripts: Record<string, string> }
  check("G1 the proof is registered (test:autonomous-marketing) and a member of the guard chain", pkg.scripts["test:autonomous-marketing"] === "tsx scripts/autonomous-marketing-guard.ts" && new RegExp("npm run test:autonomous-marketing(\\s|&|$)").test(pkg.scripts.guard))
  const domain = Object.values(MAINTENANCE_DOMAINS).find((d) => d.proof === "test:autonomous-marketing")
  check("G2 MAINTENANCE_DOMAINS owns it: campaign_orchestrator accountable, ai_isa + ads_manager co-owners named in the prose",
    domain?.manager === "campaign_orchestrator" && (domain?.coOwners ?? []).includes("ai_isa") && (domain?.coOwners ?? []).includes("ads_manager") && /ai_isa/.test(domain?.what ?? "") && /ads_manager/.test(domain?.what ?? ""))
  const models = code("lib/ai/models.ts"), bookSrc = code("lib/lead-magnets/book-creator.ts")
  check("G3 the book's two routed lanes exist (book_manuscript, book_fact_check) and are named LITERALLY at the call sites; entitlement is mayUseAndAfford('ai.generate') before every spend",
    /^\s*book_manuscript:\s*\{/m.test(models) && /^\s*book_fact_check:\s*\{/m.test(models) && /feature:\s*"book_manuscript"/.test(bookSrc) && /feature:\s*"book_fact_check"/.test(bookSrc) && /capability:\s*"ai\.generate"/.test(bookSrc))
  check("G4 the cron safety net runs the sweep per tenant beside the suggestion sweep (cron is the backup)", /sweepStalledBookProjects\(supabase,\s*brokerageId/.test(code("app/api/cron/geo-citation-monitor/route.ts")) && /runLeadMagnetSuggestions\(supabase,\s*brokerageId/.test(code("app/api/cron/geo-citation-monitor/route.ts")))
  const builder = code("app/components/features/lead-magnets/MagnetBuilder.tsx"), panel = code("app/components/features/lead-magnets/BookProjectPanel.tsx"), review = code("app/components/features/lead-magnets/MagnetDraftReview.tsx")
  check("G5 the builder starts a book (startBookProjectAction), the panel drives + revises it (advance / get / revise actions, auto-continue with a pause), the review surface renders the panel and blocks publish until the book is ready",
    /startBookProjectAction\(/.test(builder) && /advanceBookProjectAction\(/.test(panel) && /getBookProjectAction\(/.test(panel) && /reviseBookChapterAction\(/.test(panel) && /setAuto/.test(panel)
    && /<BookProjectPanel/.test(review) && /bookStage !== "ready_for_review"/.test(review))
  check("G6 every book action is a public async endpoint resolving tenant + actor from the SESSION (getAgentContext), never the body",
    ["startBookProjectAction", "advanceBookProjectAction", "getBookProjectAction", "reviseBookChapterAction"].every((n) => new RegExp(`export async function ${n}\\([\\s\\S]{0,400}?getAgentContext\\(\\)`).test(actSrc)))

  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (backgroundRejections.length) console.log(` (background best-effort work that could not load under tsx: ${backgroundRejections.length}; first: ${backgroundRejections[0]})`)
  if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ AUTONOMOUS_MARKETING_FAIL"); process.exit(1) }
  console.log(" ✅ AUTONOMOUS_MARKETING_OK")
}

main().catch((e) => {
  console.warn = realWarn; console.error = realError
  console.error(e)
  console.log(" ❌ AUTONOMOUS_MARKETING_FAIL (crash)")
  process.exit(1)
})
