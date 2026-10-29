/**
 * scripts/canaries/wave145-marketing.ts — MARKETING canary (wave 145, lane 145J; owner rulings 19, 20, 22, 13/22; contracts C4, C5):
 *   RULING 20 / C4 — "All distributions of material created by ai should have a last phase of removing any ai typical wording and
 *     adds the user's tagline": lib/marketing/humanize-final.ts finalizeForDistribution({ assetKind, text/html, tenantBrand,
 *     disclosures }) — generic AI phrasing removed, facts kept, brand voice + approved tagline, advertising / legal disclosures and
 *     material terms preserved, no unsupported superlatives / testimonials; human approval is the publication gate, the human is
 *     notified the moment it is ready, the approved final version is what is tracked as sent / published.
 *   RULING 19 — a lead magnet (guide, checklist, video, worksheet, report, calculator) is not a book (a multi-chapter manuscript made
 *     for publication); a book may be DISTRIBUTED as a lead magnet and keeps its Book entity and publishing workflow; platform-owned
 *     and tenant / agent / team-owned books carry the right owner; best-seller ANALYSIS, never a claim.
 *   RULING 22 — the topic bank aggregates verified intelligence (competitor ad + post themes, high-engagement patterns, local news /
 *     events, property-value trends, market changes, customer questions, education gaps, AI-search gaps) with source, timestamp,
 *     accessible engagement evidence and confidence; THEMES, never copied creative; no private metric assumed.
 *   RULING 13/22 / C5 — TV creative consumes an APPROVED topic through the existing Ads Manager pathway (lib/marketing/ctv-lane.ts →
 *     the ads gateway's { topicId, assetId }); no second TV subsystem. The community / event video door rides the publication survivor.
 *
 * Through the survivors at b364eb4b: lib/lead-magnets/book-editorial.ts scanAiTells, lib/lead-magnets/book-publishing.ts
 * scanBookClaims (pure). Lane 145G's names bind at the `WAVE145 BIND` lines; the fixtures are lane 145G's own
 * (scripts/content-distribution-guard.ts), the assertions the rulings. In memory: no provider, no live write, nothing published.
 *
 * MEASURED AT b364eb4b: no humanize-final module (the humanized review exists for books only); a book is a lead_capture_forms row
 * with settings.book (BOOK_PUBLICATION_CONTEXTS includes 'lead_magnet'); the topic bank records no per-row confidence and no
 * competitor / customer-question / AI-search source; no ctv-lane module; no community video door.
 */
import { LIVE } from "./_harness"
import { findLanded, strippedRepo } from "./_registry"
import { memSupabase } from "../in-memory-supabase"
import { CONTRACTS, bindContract, canary145, quiet } from "./wave145-harness"

// ── WAVE145 BIND (lane 145G notes, "## Canary requirements", published 16:21Z) ──────────────────────────────────────────────────
// lib/marketing/humanize-final.ts finalizeForDistribution · stageDistributionFinal · recordDistributionPublication ·
// FINAL_READY_NOTIFICATION_TYPE; lib/lead-magnets/book-creator.ts startBookProject; lib/lead-magnets/book-entity.ts loadDistributedBook;
// lib/content-intel/topic-intelligence.ts runTopicIntelligencePass · TOPIC_CAMPAIGN_IDEA_ITEM_TYPE; lib/marketing/ctv-lane.ts
// stageTopicTvSpot · CTV_TOPIC_ITEM_TYPE (· CTV_TOPIC_APPROVAL_TYPES); lib/video/community-video-publish.ts publishCommunityVideo;
// (re-read 16:39Z) lib/kernel/lead-magnets.ts publishLeadMagnet · lib/lead-magnets/public-text.ts leadMagnetPublicText.
const NOW = new Date("2026-10-27T15:00:00.000Z")
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString()
const B1 = "00000000-0000-4000-8000-0000000000b1", B2 = "00000000-0000-4000-8000-0000000000b2", U1 = "00000000-0000-4000-8000-0000000000a1", AG1 = "00000000-0000-4000-8000-0000000000d1"

export async function run() {
  const c = canary145("Marketing: every public AI asset ends in a humanizing phase (facts, disclosures and tagline kept; AI tells and testimonials gone) behind a human approval with the approved final tracked · a lead magnet is not a book · the topic bank is sourced, timestamped, evidenced, confidence-rated themes · TV takes an approved topic · the community video door rides the survivor")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory / static only")
  const ed = await quiet(async () => import("../../lib/lead-magnets/book-editorial"))
  const pub = await quiet(async () => import("../../lib/lead-magnets/book-publishing"))

  // ── 1 · C4: the final humanizing phase ──
  const C4 = await bindContract(CONTRACTS.C4_HUMANIZE)
  await c.check("145G", "C4 · THE LAST PHASE OF EVERY AI DISTRIBUTION REMOVES AI WORDING AND MAKES IT THE USER'S OWN (ruling 20): finalizeForDistribution on an AI newsletter removes the machine tells (scanAiTells finds none in the result), keeps the advertising / legal disclosures VERBATIM (Equal Housing Opportunity, the NMLS number), appends the approved tagline, and the result REQUIRES a human approval; a draft carrying an unsupported testimonial is blocked from approval", async () => {
    if (!C4.mod) return { ok: false, evidence: C4.evidence }
    const draft = "In today's ever-evolving market, let's delve into spring pricing. Equal Housing Opportunity. NMLS #12345"
    const f = await quiet(async () => C4.mod!.finalizeForDistribution({ assetKind: "newsletter", text: draft, tenantBrand: { tagline: "Calm advice, local roots", prohibitedWords: ["cheap"] } })) as Record<string, any>
    const t = String(f.text ?? "")
    // A plain testimonial (no superlative — measured 16:56Z: a fixture carrying "Best" was blocked for the SUPERLATIVE, which hid
    // whether the testimonial itself is caught) and, apart, a superlative.
    const testimonial = await quiet(async () => C4.mod!.finalizeForDistribution({ assetKind: "newsletter", text: "\"Dana sold our home in a week!\" — Jane D.", tenantBrand: null })) as Record<string, any>
    const superlative = await quiet(async () => C4.mod!.finalizeForDistribution({ assetKind: "newsletter", text: "Best agent ever!", tenantBrand: null })) as Record<string, any>
    const testimonialCaught = testimonial.readyForApproval === false && ((testimonial.testimonials ?? []).length > 0 || (testimonial.blockers ?? []).some((b: string) => /testimonial/i.test(b)))
    const superlativeCaught = superlative.readyForApproval === false && JSON.stringify(superlative.superlatives ?? superlative.blockers ?? []).toLowerCase().includes("best")
    const before = ed.scanAiTells(draft).length, after = ed.scanAiTells(t).length
    const ok = before > 0 && after === 0 && !/ever-evolving|delve/i.test(t) && t.includes("Equal Housing Opportunity") && t.includes("NMLS #12345") && t.includes("Calm advice, local roots") && f.requiresHumanApproval === true && (f.disclosures?.missing ?? []).length === 0 && testimonialCaught && superlativeCaught
    return { ok, evidence: `AI tells ${before} → ${after}; disclosures kept ${t.includes("Equal Housing Opportunity") && t.includes("NMLS #12345")}; tagline ${t.includes("Calm advice, local roots")} (${f.tagline?.applied ?? "?"}); requires human ${f.requiresHumanApproval}; unverified testimonial → ${testimonialCaught ? "blocked as a testimonial" : `readyForApproval ${testimonial.readyForApproval} (${(testimonial.blockers ?? [])[0] ?? "no blocker"})`}; 'Best agent ever!' → ${superlativeCaught ? "blocked as a superlative" : "NOT caught"}` }
  })

  // ── 2 · RULING 20: the human is told the moment the final is ready; the APPROVED final is what is recorded as sent ──
  await c.check("145G", "THE HUMAN APPROVAL IS THE PUBLICATION GATE AND THE APPROVED FINAL IS WHAT WAS SENT (ruling 20: 'notify the human the moment it is ready; track the approved final version actually sent/published'): staging a final records it awaiting approval and bells the human ONCE (re-staging the same final is reused, no second bell); publishing the approved final records it published with the hash of what was sent; a human's own edit is recorded as its own version (human edit); no approval waives a hard fair-housing finding", async () => {
    if (!C4.mod || typeof C4.mod.stageDistributionFinal !== "function") return { ok: false, evidence: `${C4.evidence}${C4.mod ? "; humanize-final exports no stageDistributionFinal" : ""}` }
    const db = memSupabase({ distribution_finals: [], notifications: [] }, { uuidIds: true })
    const A = "11111111-1111-4111-8111-111111111111"
    const f1 = await quiet(async () => C4.mod!.finalizeForDistribution({ assetKind: "blog_post", text: "Spring checklist for sellers in Riverbend.", tenantBrand: { tagline: "Calm advice, local roots" } })) as Record<string, any>
    const s1 = await quiet(async () => C4.mod!.stageDistributionFinal(db, { brokerageId: B1, assetTable: "blog_posts", assetId: A, final: f1, createdBy: U1, notifyUserId: U1, now: NOW })) as Record<string, any>
    // SNAPSHOT the staged status NOW — the publication below updates the same row in place (measured 16:56Z: read afterwards it
    // said 'published', which is the waypoint after, not the state the human was asked to approve).
    const stagedStatus = String((db.tables.distribution_finals ?? [])[0]?.status ?? "")
    const s1b = await quiet(async () => C4.mod!.stageDistributionFinal(db, { brokerageId: B1, assetTable: "blog_posts", assetId: A, final: f1, createdBy: U1, notifyUserId: U1, now: NOW })) as Record<string, any>
    const bells = (db.tables.notifications ?? []).filter((n) => n.type === C4.mod!.FINAL_READY_NOTIFICATION_TYPE)
    const rec = await quiet(async () => C4.mod!.recordDistributionPublication(db, { brokerageId: B1, assetKind: "blog_post", assetTable: "blog_posts", assetId: A, content: f1.text, approval: { approved: true, by: U1, at: day(0) }, via: "wordpress", ref: "wp-1", now: NOW })) as Record<string, any>
    const published = (db.tables.distribution_finals ?? []).find((r) => r.version === 1)
    const edit = await quiet(async () => C4.mod!.recordDistributionPublication(db, { brokerageId: B1, assetKind: "blog_post", assetTable: "blog_posts", assetId: A, content: "Spring checklist for sellers in Riverbend — my own final words.", approval: { approved: true, by: U1, at: day(0) }, via: "wordpress", ref: "wp-2", now: NOW })) as Record<string, any>
    const v2 = (db.tables.distribution_finals ?? []).find((r) => r.version === 2)
    const steering = await quiet(async () => C4.mod!.recordDistributionPublication(db, { brokerageId: B1, assetKind: "blog_post", assetTable: "blog_posts", assetId: A, content: "Perfect for families with young children.", approval: { approved: true, by: U1, at: day(0) }, via: "wordpress", ref: "wp-3", now: NOW })) as Record<string, any>
    const ok = s1.ok && s1.version === 1 && stagedStatus !== "published" && stagedStatus !== "" && bells.length === 1 && s1b.ok && s1b.reused && rec.ok && published?.status === "published" && published?.published_sha256 === f1.sha256 && edit.ok && edit.humanEdit && v2?.approval_basis === "human_edit" && !steering.ok
    return { ok, evidence: `staged v${s1.version} (${stagedStatus || "?"}), bells ${bells.length}, re-stage reused ${s1b.reused}; published ${published?.status} hash matches ${published?.published_sha256 === f1.sha256}; human edit → v2 ${v2?.approval_basis ?? "—"}; steering copy → ${steering.ok ? "PUBLISHED" : "refused"}` }
  })

  // ── 2b · RULING 20 at the lead-magnet door: the page that goes live IS the approved final, disclosures intact ──
  await c.check("145G", "THE LEAD-MAGNET PAGE THAT GOES LIVE IS THE APPROVED FINAL (ruling 20 at the lead-magnet door — lane 145G item 3): publishing (the human's approval) a page whose public words are the staged final records THAT version as published with the hash of the page's public words, and the page goes live; a reviewer's edit that DROPPED the Equal Housing Opportunity disclosure the final carried is refused and the page stays a draft (fail closed)", async () => {
    const lm = await bindContract({ id: "145G lead-magnet door", lane: "145G", file: "lib/lead-magnets/public-text.ts", exports: ["leadMagnetPublicText"] })
    if (!C4.mod || !lm.mod) return { ok: false, evidence: `${C4.evidence}; ${lm.evidence}` }
    const { publishLeadMagnet } = await quiet(async () => import("../../lib/kernel/lead-magnets")) as unknown as { publishLeadMagnet: (i: unknown, o: unknown) => Promise<Record<string, any>> }
    const { createHash } = await import("node:crypto")
    const page = (id: string, subhead: string) => ({ id, brokerage_id: B1, slug: `s-${id}`, agent_id: AG1, settings: {}, is_active: false, name: "Spring seller guide", thank_you_message: "Thanks — it is on its way.", landing_content: { headline: "Sell in spring, calmly", subhead, cta: "Send it", bullets: ["Timing", "Pricing"], faq: [] } })
    const EHO = "Prices in 33602 rose 4.2% this year. Equal Housing Opportunity."
    const db = memSupabase({ lead_capture_forms: [page("f-kept", EHO), page("f-dropped", "Prices in 33602 rose 4.2% this year.")], book_projects: [], agent_action_ledger: [], distribution_finals: [], notifications: [] }, { uuidIds: true, stampCreatedAt: true })
    const forms = db.tables.lead_capture_forms ?? []
    const textKept = lm.mod.leadMagnetPublicText(forms[0]) as string
    const textStaged = lm.mod.leadMagnetPublicText({ ...forms[1], landing_content: { ...(forms[1].landing_content as Record<string, unknown>), subhead: EHO } }) as string
    for (const [id, text] of [["f-kept", textKept], ["f-dropped", textStaged]] as const) {
      const fin = await quiet(async () => C4.mod!.finalizeForDistribution({ assetKind: "lead_magnet", text, tenantBrand: null }))
      await quiet(async () => C4.mod!.stageDistributionFinal(db, { brokerageId: B1, assetTable: "lead_capture_forms", assetId: id, final: fin, createdBy: U1, notifyUserId: U1, storedAs: text, now: NOW }))
    }
    const go = await quiet(() => publishLeadMagnet({ magnetId: "f-kept", brokerageId: B1, channels: ["landing_page"], actorUserId: U1, baseUrl: "https://app.example.com" }, { client: db }))
    const rec = (db.tables.distribution_finals ?? []).find((r) => r.asset_id === "f-kept")
    const dropped = await quiet(() => publishLeadMagnet({ magnetId: "f-dropped", brokerageId: B1, channels: ["landing_page"], actorUserId: U1, baseUrl: "https://app.example.com" }, { client: db }))
    const live = (id: string) => (db.tables.lead_capture_forms ?? []).find((f) => f.id === id)?.is_active
    const hashOk = rec?.published_sha256 === createHash("sha256").update(textKept).digest("hex")
    return { ok: go.success === true && rec?.status === "published" && hashOk && live("f-kept") === true && !dropped.success && /disclosure/i.test(String(dropped.error ?? "")) && live("f-dropped") === false, evidence: `approved page → ${go.success ? "live" : `refused (${go.error})`}, final ${rec?.status ?? "none"}, sent hash = page words ${hashOk}; EHO dropped → ${dropped.success ? "PUBLISHED" : `refused (${String(dropped.error ?? "").slice(0, 70)})`}, page live ${live("f-dropped")}` }
  })

  // ── 3 · RULING 19: a lead magnet is not a book ──
  const bc = await bindContract({ id: "145G book entity", lane: "145G", file: "lib/lead-magnets/book-entity.ts", exports: ["loadDistributedBook"] })
  await c.check("145G", "A LEAD MAGNET IS NOT A BOOK (ruling 19: 'a manuscript or book which has many sections/chapters and is created for publication'): a book is its OWN record; a tenant-KDP book has NO capture form; a book distributed as a lead magnet keeps its book row and the form only POINTS at it (no manuscript on the form); a team's book is the team's, the house tenant's the platform's; a form pointing at another form's book is refused (fail closed); the lead-magnet vocabulary has no 'book' type", async () => {
    const creator = await import("../../lib/lead-magnets/book-creator") as unknown as Record<string, any>
    if (!bc.mod || typeof creator.startBookProject !== "function") return { ok: false, evidence: `${bc.evidence}${typeof creator.startBookProject === "function" ? "" : "; book-creator exports no startBookProject"}; HEAD: a book is a lead_capture_forms row (settings.book), contexts ${(ed.BOOK_PUBLICATION_CONTEXTS as readonly string[]).join("/")}` }
    const BH = "00000000-0000-4000-8000-0000000000c1", AGH = "00000000-0000-4000-8000-0000000000d9", US = "00000000-0000-4000-8000-0000000000a9"
    const db = memSupabase({ brokerages: [{ id: B1, is_demo: false }, { id: BH, is_demo: true }], agents: [{ id: AG1, user_id: U1, brokerage_id: B1 }, { id: AGH, user_id: US, brokerage_id: BH }], lead_capture_forms: [], book_projects: [], agent_action_ledger: [], lifecycle_events: [] }, { uuidIds: true, stampCreatedAt: true })
    ;(db as unknown as { rpc: unknown }).rpc = async () => ({ data: null, error: null })
    const allow = async () => ({ allowed: true, reason: "ok" })
    const lm = await quiet(async () => creator.startBookProject({ brokerageId: B1, agentId: AG1, createdBy: U1, concept: "A seller's book on pricing a fixer-upper in Tampa Bay", audience: "seller" }, { client: db, entitlement: allow, now: NOW })) as Record<string, any>
    const kdp = await quiet(async () => creator.startBookProject({ brokerageId: B1, agentId: AG1, createdBy: U1, concept: "A seller's book on staging a waterfront condo in Clearwater", audience: "seller", context: "tenant_kdp" }, { client: db, entitlement: allow, now: NOW })) as Record<string, any>
    const team = await quiet(async () => creator.startBookProject({ brokerageId: B1, agentId: AG1, createdBy: U1, concept: "A buyer's book on new construction in Wesley Chapel for our team", audience: "buyer", teamId: "team-1", teamOwned: true, distributeAsLeadMagnet: false }, { client: db, entitlement: allow, now: NOW })) as Record<string, any>
    const house = await quiet(async () => creator.startBookProject({ brokerageId: BH, agentId: AGH, createdBy: US, concept: "An agent's field guide to AI-assisted listing launches in Florida", audience: "seller" }, { client: db, entitlement: allow, now: NOW })) as Record<string, any>
    const book = (id?: string) => (db.tables.book_projects ?? []).find((b) => b.id === id)
    const form = (id?: string) => (db.tables.lead_capture_forms ?? []).find((f) => f.id === id)
    const stolen = await quiet(async () => bc.mod!.loadDistributedBook(db, B1, "another-form", { book_id: lm.bookId })) as { error: string | null }
    const lmTypes = /magnetType:\s*([^\n]+)/.exec(strippedRepo("lib/kernel/lead-magnets.ts") ?? "")?.[1] ?? ""
    const ok = lm.success && !!book(lm.bookId) && book(lm.bookId)?.distribution_form_id === lm.magnetId && form(lm.magnetId)?.settings?.book_id === lm.bookId && !("book" in (form(lm.magnetId)?.settings ?? {}))
      && kdp.success && !kdp.magnetId && !!book(kdp.bookId) && team.success && book(team.bookId)?.owner_scope === "team" && house.success && book(house.bookId)?.owner_scope === "platform" && !!stolen.error && !/["']book["']/.test(lmTypes)
    return { ok, evidence: `lead-magnet book: row ${!!book(lm.bookId)}, form points ${form(lm.magnetId)?.settings?.book_id === lm.bookId}, manuscript on form ${"book" in (form(lm.magnetId)?.settings ?? {})}; KDP book form ${kdp.magnetId ?? "none"}; team owner ${book(team.bookId)?.owner_scope ?? "?"}; house owner ${book(house.bookId)?.owner_scope ?? "?"}; another form's pointer → ${stolen.error ? "refused" : "READ"}` }
  })

  // ── 4 · best-seller ANALYSIS, never a claim (green — preserve) ──
  const claimed = pub.scanBookClaims({ subtitle: "The #1 bestseller every Pensacola buyer needs", description: "Guaranteed to become a bestseller." })
  const plain = pub.scanBookClaims({ subtitle: "A plain guide to buying in Pensacola", description: "What the inspection, appraisal and closing look like, step by step." })
  c.rule("145G", "BEST-SELLER ANALYSIS, NEVER A CLAIM (ruling 19: 'AI analyses how a best-seller list can be reached — never claims it'; green, preserve): rank / bestseller / guarantee language in a book's public fields is found and named; plain copy passes (positive control)", claimed.length >= 2 && plain.length === 0, `claims found ${claimed.map((f) => f.phrase).join(" | ")}; plain → ${plain.length}`)

  // ── 5 · RULING 22: the topic bank — every source, evidence on every row, themes never creative, ideas await a person ──
  const ti = await bindContract({ id: "145G topic intelligence", lane: "145G", file: "lib/content-intel/topic-intelligence.ts", exports: ["runTopicIntelligencePass", "TOPIC_CAMPAIGN_IDEA_ITEM_TYPE"] })
  await c.check("145G", "THE TOPIC BANK AGGREGATES THE RULED SOURCES AS EVIDENCED THEMES (ruling 22: 'record source, timestamp, accessible engagement evidence, confidence; extract themes, never copy creative; no private competitor metrics'): one pass files competitor-post, customer-question, education-gap, AI-search-gap, property-value-trend and market-change themes; EVERY filed row carries source, observation time, an engagement basis and a confidence, marked theme-only with no private metric; a competitor's caption never appears in a topic; the strongest themes become campaign ideas PENDING a person; a refused competitor read is a published blind spot while the other sources still file", async () => {
    if (!ti.mod) return { ok: false, evidence: `${ti.evidence}; HEAD source vocabulary has no competitor / customer-question / AI-search source; findLanded: ${findLanded(["lib/content-intel"], /\b(competitor_post\w*|customer_question\w*|ai_search_gap\w*)\b/) ?? "nothing"}` }
    const CAPTION = "ZZ-UNIQUE-CAPTION Our team closes faster than anyone"
    const post = (o: Record<string, unknown>) => ({ brokerage_id: B1, competitor_id: "c1", platform: "instagram", content_type: "reel", content_url: null, detected_topics: [], hook_type: "question", engagement_rate: 10, is_high_performing: false, likes_count: null, comments_count: null, shares_count: null, views_count: null, observed_at: day(-2), posted_at: day(-3), caption: CAPTION, ...o })
    const world = (refuse: Record<string, string> = {}) => memSupabase({
      content_topic_sources: [],
      competitor_content: [post({ detected_topics: ["closing costs"], engagement_rate: 70 }), post({ detected_topics: ["closing costs"], competitor_id: "c2", engagement_rate: 60 })],
      messages: [1, 2, 3].map((i) => ({ brokerage_id: B1, contact_id: `ct-${i}`, direction: "inbound", body: "What are the closing costs here?", created_at: day(-1) })),
      listing_inquiries: [], learning_modules: [],
      ai_search_citation_observations: [{ brokerage_id: B1, query: "what are closing costs in Tampa", outcome: "not_cited", competitors_cited: ["Rival"], platform: "chatgpt", observed_at: day(-1) }],
      market_data: [{ brokerage_id: B1, zip_code: "33602", city: "Tampa", state: "FL", market_area: null, data_date: day(-5), source_type: "mls_feed", median_sale_price: 410000, price_trend_pct_30d: 0.2, price_trend_pct_90d: 2.5, price_trend_pct_1yr: 4.2, months_of_inventory: 1.5, avg_days_on_market: 18 }],
      content_topic_bank: [], approval_items: [],
    }, { uuidIds: true, stampCreatedAt: true, refuse })
    const db = world()
    const r = await quiet(async () => ti.mod!.runTopicIntelligencePass(db, B1, { now: NOW })) as Record<string, any>
    const rows = db.tables.content_topic_bank ?? []
    const classes = new Set(rows.map((t) => t.raw_data?.topic_evidence?.source_class))
    const evidenced = rows.length > 0 && rows.every((t) => { const e = t.raw_data?.topic_evidence; return !!e?.source && !!e.observed_at && !!e.engagement?.basis && typeof e.confidence === "number" && e.confidence > 0 && e.confidence <= 1 && e.theme_only === true && e.private_metrics === false })
    const copied = rows.some((t) => `${t.topic_title ?? ""} ${t.value_angle ?? ""}`.includes("ZZ-UNIQUE-CAPTION"))
    const ideas = (db.tables.approval_items ?? []).filter((i) => i.item_type === ti.mod!.TOPIC_CAMPAIGN_IDEA_ITEM_TYPE)
    const blind = world({ competitor_content: "permission denied for table competitor_content" })
    const rb = await quiet(async () => ti.mod!.runTopicIntelligencePass(blind, B1, { now: NOW })) as Record<string, any>
    const wanted = ["competitor_post", "customer_question", "education_gap", "ai_search_gap", "property_value_trend", "market_change"]
    const ok = r.ran && wanted.every((k) => classes.has(k)) && evidenced && !copied && ideas.length >= 1 && ideas.every((i) => i.status === "pending") && rb.ran && (rb.blindSpots ?? []).some((b: string) => /competitor/i.test(b)) && (blind.tables.content_topic_bank ?? []).length > 0
    return { ok, evidence: `filed ${rows.length}; classes ${[...classes].join(",")}; every row evidenced ${evidenced}; competitor caption copied ${copied}; pending ideas ${ideas.length}; refused competitor read → blind spot ${(rb.blindSpots ?? []).some((b: string) => /competitor/i.test(b))}, others filed ${(blind.tables.content_topic_bank ?? []).length}` }
  })

  // ── 6 · C5: TV creative from an APPROVED topic, through the Ads Manager's ONE gateway ──
  const ctv = await bindContract({ id: CONTRACTS.C5_CTV_LANE.id, lane: "145G", file: CONTRACTS.C5_CTV_LANE.file, exports: ["stageTopicTvSpot", "CTV_TOPIC_ITEM_TYPE"] })
  await c.check("145G", "C5 · TV CREATIVE CONSUMES AN APPROVED TOPIC THROUGH THE EXISTING ADS MANAGER PATHWAY (contract C5; ruling 13/22: 'TV ads derive from the topic bank'): an approved TV topic + an approved public video MADE FROM it reaches the ONE gateway as { topicId, assetId } and the spot's words are recorded as the final the video's approval covers; a PENDING topic is refused and the gateway is never called; a later rejection revokes it (latest decision wins); the lane never calls the TV provider itself; its approval vocabulary is the gateway's", async () => {
    if (!ctv.mod) return { ok: false, evidence: ctv.evidence }
    const TOPIC = "33333333-3333-4333-8333-333333333333", VID = "44444444-4444-4444-8444-444444444444"
    const evidence = { source_class: "market_change", source: "market_data (mls_feed, as of 2026-10-20)", observed_at: day(-7), feeds: ["ctv_ad", "video"], facts: ["Months of supply in ZIP 33602: 1.5 (market_data (mls_feed, as of 2026-10-20))"] }
    const video = { id: VID, brokerage_id: B1, title: "Riverbend market update", script_content: "Inventory in 33602 sits at 1.5 months of supply.", video_type: "market_update", audience_type: "customer_facing", usage_intent: "public_marketing", contact_id: null, learning_module_id: null, approval_status: "approved", approved_by: U1, approved_at: day(-1), status: "completed", compliance_status: "passed", video_url: "https://cdn.example.test/v.mp4", video_metadata: {} }
    const T = ctv.mod.CTV_TOPIC_ITEM_TYPE
    const seed = (items: Array<Record<string, unknown>>) => memSupabase({
      approval_items: items, ai_video_projects: [video], content_topic_uses: [{ id: "use-1", brokerage_id: B1, topic_id: TOPIC, asset_id: VID, asset_type: "situational_reel" }], distribution_finals: [], notifications: [], agent_action_ledger: [],
      content_topic_bank: [{ id: TOPIC, brokerage_id: B1, topic_title: "Market shift in ZIP 33602", value_angle: "…", categories: ["market_change", "topic_intelligence"], status: "fresh", expires_at: day(20), raw_data: { topic_evidence: evidence } }],
    }, { uuidIds: true })
    const calls: Array<Record<string, unknown>> = []
    const deps = (db: ReturnType<typeof seed>) => ({ client: db, gateway: async (i: Record<string, unknown>) => { calls.push(i); return { success: true, package: { campaignId: "camp-1", warnings: [] } } }, brand: async () => ({ tagline: "Calm advice, local roots" }), logUse: async () => {}, ledger: false, now: NOW })
    const req = { brokerageId: B1, agentUserId: U1, topicId: TOPIC, assetId: VID, dailyBudgetCents: 2500, targeting: { cities: ["Tampa"] } }
    const pending = await quiet(async () => ctv.mod!.stageTopicTvSpot(req, deps(seed([{ id: "a1", brokerage_id: B1, item_type: T, item_id: TOPIC, status: "pending", submitted_at: day(-1) }])))) as Record<string, any>
    const callsAfterPending = calls.length
    const approved = [{ id: "a1", brokerage_id: B1, item_type: T, item_id: TOPIC, status: "approved", reviewed_by: U1, reviewed_at: day(-1), submitted_at: day(-2) }]
    const db = seed(approved)
    const ok1 = await quiet(async () => ctv.mod!.stageTopicTvSpot(req, deps(db))) as Record<string, any>
    const fin = (db.tables.distribution_finals ?? [])[0]
    const revoked = await quiet(async () => ctv.mod!.stageTopicTvSpot(req, deps(seed([...approved, { id: "a2", brokerage_id: B1, item_type: T, item_id: TOPIC, status: "rejected", reviewed_by: U1, reviewed_at: day(0), submitted_at: day(-2) }])))) as Record<string, any>
    const lane = strippedRepo(CONTRACTS.C5_CTV_LANE.file) ?? ""
    const noProvider = /stageCtvCampaign\(/.test(lane) && !/providers\/vibe|dispatchCtvCampaign|launchCtvCampaignOnVibe|api\.vibe\.co/.test(lane)
    const gw = await import("../../lib/ads/ctv-campaign").catch(() => ({})) as Record<string, unknown>
    const gwTypes = gw.CTV_TOPIC_APPROVAL_ITEM_TYPES as readonly string[] | undefined
    const laneTypes = ctv.mod.CTV_TOPIC_APPROVAL_TYPES as readonly string[] | undefined
    const oneVocab = !gwTypes || !laneTypes || (gwTypes.length === laneTypes.length && laneTypes.every((t) => gwTypes.includes(t)))
    const ok = !pending.ok && callsAfterPending === 0 && ok1.ok && calls.length === 1 && calls[0].topicId === TOPIC && calls[0].assetId === VID && fin?.asset_kind === "ctv_ad" && fin?.approval_basis === "derived_from_approved_asset" && !revoked.ok && noProvider && oneVocab
    return { ok, evidence: `pending → ${pending.ok ? "STAGED" : "refused"} (gateway calls ${callsAfterPending}); approved → ${ok1.ok ? `gateway { topicId ${calls[0]?.topicId === TOPIC}, assetId ${calls[0]?.assetId === VID} }` : ok1.reason}; final ${fin?.asset_kind ?? "—"}/${fin?.approval_basis ?? "—"}; later rejection → ${revoked.ok ? "STAGED" : "refused"}; no provider call in the lane ${noProvider}; one approval vocabulary with the gateway ${oneVocab}${gwTypes ? "" : " (gateway list not landed — lane 145D)"}` }
  })

  // ── 7 · the community / event video door rides the publication survivor ──
  const cv = await bindContract({ id: "145G community video door", lane: "145G", file: "lib/video/community-video-publish.ts", exports: ["publishCommunityVideo"] })
  await c.check("145G", "THE COMMUNITY / EVENT VIDEO DOOR (lane 145G item 4 — 'build the smallest door on the existing publication survivor'): a video made from an APPROVED community topic, itself approved for public release, rides the ONE YouTube post survivor, its public words passed the final phase (the AI opener gone, the date kept, the tagline signed) and the video carries the topic + approver; a still-pending topic publishes nothing and stamps nothing; a video not made from the topic does not publish", async () => {
    if (!cv.mod) return { ok: false, evidence: cv.evidence }
    const TOPIC = "55555555-5555-4555-8555-555555555555", VID = "66666666-6666-4666-8666-666666666666", AGENT = "00000000-0000-4000-8000-0000000000d2"
    // WAVE 146 (lane 146F — ruling 4): a community reel is a NON-LISTING broadcast video, so the YouTube survivor takes it only
    // STAGED and approved by its assigned approver (lib/video/video-staging.ts). The fixture carries the staging record the
    // stager writes (approver U1, the youtube channel chosen); the 145G rule this step asserts is unchanged.
    const staging = { version: 1, staged_at: day(-2), playable: { ok: true, basis: "finished + hosted" }, rights: { ok: true, checks: [] }, branding: { ok: true, violations: [], basis: "fixture" }, audience: "public_marketing", channels: ["landing_page", "youtube"], approver: { user_ids: [U1], basis: "fixture", assigned_at: day(-2) }, blockers: [] }
    const vid = { id: VID, brokerage_id: B1, agent_id: AGENT, listing_id: null, marketing_campaign_id: null, title: "Riverbend Fall Festival this Saturday", video_type: "social_reel", audience_type: "customer_facing", usage_intent: "public_marketing", contact_id: null, learning_module_id: null, approval_status: "approved", approved_by: U1, approved_at: day(-1), status: "completed", compliance_status: "passed", video_url: "https://cdn.example.test/fest.mp4", script_content: "In today's fast-paced world, the Riverbend Fall Festival returns on Saturday, Nov 1.", video_metadata: { staging } }
    const seed = (items: Array<Record<string, unknown>>, uses = [{ id: "u1", brokerage_id: B1, topic_id: TOPIC, asset_id: VID, asset_type: "situational_reel" }]) => memSupabase({
      approval_items: items, ai_video_projects: [{ ...vid }], content_topic_uses: uses, agents: [{ id: AGENT, brokerage_id: B1, user_id: U1 }],
      social_media_accounts: [{ id: "acct-yt", brokerage_id: B1, agent_id: AGENT, platform: "youtube", is_active: true }], social_posts: [], brokerage_settings: [], marketing_assets: [], distribution_finals: [], notifications: [],
      content_topic_bank: [{ id: TOPIC, brokerage_id: B1, topic_title: "Community moment: Riverbend Fall Festival", categories: ["neighborhood", "local_intel"], status: "fresh", expires_at: day(6), raw_data: {} }],
    }, { uuidIds: true })
    const idea = (status: string) => ({ id: "i1", brokerage_id: B1, item_type: "local_campaign_idea", item_id: TOPIC, status, reviewed_by: status === "approved" ? U1 : null, reviewed_at: status === "approved" ? day(-1) : null })
    const brand = async () => ({ tagline: "Calm advice, local roots" })
    const input = { brokerageId: B1, actorUserId: U1, videoProjectId: VID, topicId: TOPIC }
    const pendingDb = seed([idea("pending")])
    const p1 = await quiet(async () => cv.mod!.publishCommunityVideo(input, { client: pendingDb, brand, now: NOW })) as Record<string, any>
    const p2 = await quiet(async () => cv.mod!.publishCommunityVideo(input, { client: seed([idea("approved")], []), brand, now: NOW })) as Record<string, any>
    const db = seed([idea("approved")])
    const ok1 = await quiet(async () => cv.mod!.publishCommunityVideo(input, { client: db, brand, now: NOW })) as Record<string, any>
    const post = (db.tables.social_posts ?? [])[0]
    const stamped = (db.tables.ai_video_projects ?? [])[0]?.video_metadata?.community
    const ok = !p1.ok && (pendingDb.tables.social_posts ?? []).length === 0 && !(pendingDb.tables.ai_video_projects ?? [])[0]?.video_metadata?.community && !p2.ok && ok1.ok && (db.tables.social_posts ?? []).length === 1 && post?.platform === "youtube" && stamped?.topic_id === TOPIC && !/fast-paced/.test(String(post?.content ?? "")) && /Nov 1/.test(String(post?.content ?? "")) && /Calm advice, local roots/.test(String(post?.content ?? ""))
    return { ok, evidence: `pending topic → ${p1.ok ? "PUBLISHED" : "refused"} (posts ${(pendingDb.tables.social_posts ?? []).length}); video not from the topic → ${p2.ok ? "PUBLISHED" : "refused"}; approved → ${ok1.ok ? `${(db.tables.social_posts ?? []).length} ${post?.platform ?? "?"} post, topic stamped ${stamped?.topic_id === TOPIC}` : ok1.reason}; words "${String(post?.content ?? "").slice(0, 80)}"` }
  })

  c.blind("Driven with lane 145G's own fixture shapes and injected seams (a TV gateway recorder, a brand resolver, an entitlement) — no provider is called, nothing is published. The 'theme, never creative' check plants one competitor caption; a paraphrase of a competitor's line is out of its sight. The book ownership checks read the rows lane 145G writes; the RLS that enforces them is the migration's (m867), not modelled in memory.")
  return c.report([], 0)
}
