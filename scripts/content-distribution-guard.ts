#!/usr/bin/env tsx
/**
 * scripts/content-distribution-guard.ts   (run: tsx --conditions=react-server scripts/content-distribution-guard.ts — key to add: test:content-distribution)
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * WAVE 145, LANE 145G — the owner's 2026-10-27 rulings on CONTENT, proven in memory (no network, no provider key):
 *
 *   A. RULING 20 / CONTRACT C4 — the final personalization phase (lib/marketing/humanize-final.ts finalizeForDistribution): machine
 *      phrasing removed by the ONE tell list (book-editorial.ts — the 144H survivor), facts / figures / disclosures kept, the APPROVED
 *      tagline added once, the logo handed to the renderer, superlatives / testimonials / rank claims / prohibited words / hard
 *      fair-housing findings named, the result hashed. Positive controls for every finder; clean controls for every pass.
 *   B. THE VERSION LEDGER (distribution_finals, m866): staged + the human notified at once; idempotent; superseded; the publication
 *      door refuses the unapproved and the non-waivable, records the approved version that went out (or the human's edit as its own).
 *   C. RULING 22 — the topic bank gathers competitor post themes, high-engagement patterns, customer questions, education gaps,
 *      AI-search gaps, property-value trends and market changes (lib/content-intel/topic-intelligence.ts): themes never creative,
 *      counts never words, no private metric, the accessible evidence and its basis, confidence; the pass files them in the ONE pool.
 *   D. CONTRACT C5 — TV creative from an APPROVED topic through the Ads Manager's ONE gateway (lib/marketing/ctv-lane.ts).
 *   E. The community / event video door (lib/video/community-video-publish.ts) on the YouTube survivor.
 *   F. RULING 19 — a book is its own entity (book_projects, m867), never a lead magnet; a lead magnet only distributes it.
 *   G. Migrations (assert the RULE: CHECK vocabularies equal the code's; either line-1 stamp) and the doors' wiring (stripped source).
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { memSupabase } from "./in-memory-supabase"
import { stripComments, blankStrings } from "./strip-comments"
import {
  finalizeForDistribution, vetBrandTagline,
  stageDistributionFinal, checkDistributionPublication, recordDistributionPublication,
  HUMANIZE_ASSET_KINDS, HUMANIZE_KIND_PROFILE, DISTRIBUTION_FINAL_STATUSES, DISTRIBUTION_APPROVAL_BASES, FINAL_READY_NOTIFICATION_TYPE,
} from "../lib/marketing/humanize-final"
import { scanAiTells, stripAiTells, BOOK_PUBLICATION_CONTEXTS } from "../lib/lead-magnets/book-editorial"
import {
  TOPIC_SOURCE_CLASSES, TOPIC_SOURCE_CENSUS, competitorPostThemes, viralPatternThemes, customerQuestionThemes, educationGapThemes,
  aiSearchGapThemes, marketThemes, competitorAdTheme, MIN_DISTINCT_ASKERS, type CompetitorContentRow,
} from "../lib/content-intel/topic-themes"
import { runTopicIntelligencePass, readTopicApproval, TOPIC_CAMPAIGN_IDEA_ITEM_TYPE } from "../lib/content-intel/topic-intelligence"
import { CTV_TOPIC_ITEM_TYPE, CTV_TOPIC_APPROVAL_TYPES, topicSuitsTv, tvSpotBriefFromTopic, stageTopicTvSpot, type CtvGatewayInput } from "../lib/marketing/ctv-lane"
import { publishCommunityVideo } from "../lib/video/community-video-publish"
import { recordYouTubePublishOnAsset } from "../lib/video/youtube-publish"
import { BOOK_STAGES, startBookProject } from "../lib/lead-magnets/book-creator"
import { loadDistributedBook, BOOK_OWNER_SCOPES } from "../lib/lead-magnets/book-entity"
import { publishLeadMagnet } from "../lib/kernel/lead-magnets"
import { leadMagnetPublicText } from "../lib/lead-magnets/public-text"

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
const blind: string[] = []

const B1 = "00000000-0000-4000-8000-0000000000b1", B2 = "00000000-0000-4000-8000-0000000000b2", U1 = "00000000-0000-4000-8000-0000000000a1"
const AG1 = "00000000-0000-4000-8000-0000000000d1"
const NOW = new Date("2026-10-27T12:00:00Z")
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString()
/** An INDEPENDENT oracle for the version hash (node:crypto, not the module's own helper). */
const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex")

async function main() {
  // ═══════════════════ A · the final personalization phase (pure) ═══════════════════
  section("A · finalizeForDistribution — remove machine phrasing, keep facts, add the approved tagline (ruling 20, C4)")
  {
    const a = stripAiTells("In today's fast-paced real estate market, buyers need a plan. It's important to note that rates move. Let's delve into the paperwork. In conclusion, plan early.")
    check("SAFE removals (positive controls): the stock opener, the hedge and the scaffolding are gone, 'delve into' became plain words, and each sentence starts capitalised",
      a.text === "Buyers need a plan. Rates move. Let's look at the paperwork. Plan early." && a.removed.length === 4, JSON.stringify(a))
    const b = stripAiTells("Looking for a home? Look no further! We will navigate the complexities of escrow.")
    check("…'look no further!' at a sentence end goes; 'navigate the complexities of' becomes 'work through'", b.text === "Looking for a home? We will work through escrow." && b.removed.length === 2, JSON.stringify(b))
    const kept = stripAiTells("In the ever-evolving world of $500k homes, prices moved 3.2% this year.")
    check("a clause that CARRIES A FIGURE is never removed (the fix refuses digits / $ / %) — the tell stays OPEN for the human instead",
      kept.text === "In the ever-evolving world of $500k homes, prices moved 3.2% this year." && kept.removed.length === 0 && scanAiTells(kept.text).length === 1)
    const human = "Selling a home is a sequence of decisions, not a single event. Keep a folder of every document."
    check("CLEAN control: plain human prose is untouched and carries no tell", stripAiTells(human).text === human && scanAiTells(human).length === 0)
  }
  {
    const f = await finalizeForDistribution({ assetKind: "social_post", text: "In today's competitive market, homes near the park sell in 21 days on average for $425,000. Unlock the potential of your home.", tenantBrand: { brandName: "Harbor Realty", tagline: "Calm advice, local roots" } })
    check("the final keeps every MATERIAL TERM (21, $425,000) and removes the safe tell", f.materialTerms.missing.length === 0 && f.materialTerms.source.includes("$425,000") && !/today's competitive/i.test(f.text) && /\$425,000/.test(f.text), JSON.stringify(f.materialTerms))
    check("an unremovable tell ('unlock the potential') stays OPEN and BLOCKS readiness; the human approval is still required", f.openTells.length === 1 && !f.readyForApproval && f.requiresHumanApproval === true && f.blockers.some((b) => /unlock the potential/i.test(b)))
    check("the APPROVED tagline is appended once as the sign-off", f.tagline.applied === "appended" && f.text.endsWith("— Calm advice, local roots"))
    const again = await finalizeForDistribution({ assetKind: "social_post", text: f.text, tenantBrand: { tagline: "Calm advice, local roots" } })
    check("…and never twice (a second pass reads it as already present)", again.tagline.applied === "already_present" && again.text.split("Calm advice, local roots").length === 2)
    check("the hash identifies the final: the SHA-256 of its exact text (independent oracle); a changed character changes it", f.sha256 === sha256(f.text) && f.sha256 !== sha256(`${f.text}.`) && /^[0-9a-f]{64}$/.test(f.sha256))
  }
  {
    const claim = await vetBrandTagline("The #1 team in Tampa Bay", { surface: "social" })
    const sup = await vetBrandTagline("The finest homes on the coast", { surface: "social" })
    const ok = await vetBrandTagline("Calm advice, local roots", { surface: "social" })
    check("TAGLINE VETTING: a rank claim and an unsupported superlative are left off WITH the reason; a clean one passes", claim.tagline === null && /left off/.test(claim.reason ?? "") && sup.tagline === null && /superlative/.test(sup.reason ?? "") && ok.tagline === "Calm advice, local roots")
    const tv = await finalizeForDistribution({ assetKind: "ctv_ad", text: "Market update for Riverbend.", tenantBrand: { tagline: "Calm advice, local roots", logoUrl: "https://x/logo.png" } })
    const ad = await finalizeForDistribution({ assetKind: "ad_creative", text: "Market update for Riverbend.", tenantBrand: { tagline: "Calm advice, local roots" } })
    const post = await finalizeForDistribution({ assetKind: "social_post", text: "Market update.", tenantBrand: { logoUrl: "https://x/logo.png" } })
    check("WHERE SUPPORTED: a TV spot renders the tagline + logo on its end card; an ad headline has no room (said); a text-only post carries no logo (said)", tv.tagline.applied === "render" && tv.logo.placement === "render" && tv.text === "Market update for Riverbend." && ad.tagline.applied === "none" && /no room/.test(ad.tagline.reason ?? "") && post.logo.placement === "none" && /text-only/.test(post.logo.reason ?? ""))
  }
  {
    const f = await finalizeForDistribution({ assetKind: "newsletter", text: "We are the best agents in town. \"Dana sold our home in a week!\" — Jane D. Rated 5 stars. The #1 brokerage. Perfect for families.", tenantBrand: { prohibitedWords: ["cheap"], preferredWords: ["calm"] } })
    check("FLAGGED (positive controls): an unsupported superlative, a testimonial with no verified review, a star rating, a rank claim, a hard fair-housing phrase",
      f.superlatives.includes("best") && f.testimonials.some((t) => /Dana sold our home/.test(t) && /Jane/.test(t)) && f.testimonials.some((t) => /5 stars/.test(t)) && f.rankClaims.length >= 1 && f.fairHousing.length >= 1 && !f.readyForApproval, JSON.stringify({ s: f.superlatives, t: f.testimonials, r: f.rankClaims, fh: f.fairHousing }))
    const grounded = await finalizeForDistribution({ assetKind: "listing_creative", text: "Stunning views from the deck. \"Dana sold our home in a week!\" — Jane D.", tenantBrand: null, facts: ["stunning views of the bay"], verifiedTestimonials: ["Dana sold our home in a week!"] })
    check("…GROUNDED in the caller's facts / a verified review they pass (the same rule as the video hook harness)", grounded.superlatives.length === 0 && grounded.testimonials.length === 0, JSON.stringify(grounded.testimonials))
    const voice = await finalizeForDistribution({ assetKind: "newsletter", text: "A cheap way to list.", tenantBrand: { prohibitedWords: ["cheap"], preferredWords: ["calm"] } })
    check("the tenant's PROHIBITED word blocks; a missing preferred word is a note only", voice.brandVoice.prohibited.includes("cheap") && voice.blockers.some((b) => /prohibits "cheap"/.test(b)) && voice.reviewNotes.some((n) => /preferred words/.test(n)))
  }
  {
    const f = await finalizeForDistribution({ assetKind: "email_campaign", text: "Rates are subject to change. Equal Housing Opportunity.", tenantBrand: null, disclosures: ["Harbor Realty, CA DRE #01234567"] })
    check("DISCLOSURES: the draft's own are kept and proven present; a required line it lacked is appended (never invented beyond the caller's)", f.disclosures.carried.length === 2 && f.disclosures.appended.join() === "Harbor Realty, CA DRE #01234567" && f.disclosures.missing.length === 0 && f.text.endsWith("Harbor Realty, CA DRE #01234567"))
    const eho = await finalizeForDistribution({ assetKind: "social_post", text: "Call today. Equal Housing Opportunity. NMLS #123.", tenantBrand: null })
    const plain = await finalizeForDistribution({ assetKind: "social_post", text: "Call today about the open house.", tenantBrand: null })
    check("the disclosure finder sees EHO / NMLS lines as carried disclosures (positive control) and nothing in plain copy (clean control)", eho.disclosures.carried.length === 2 && plain.disclosures.carried.length === 0, JSON.stringify(eho.disclosures))
    const terms = await finalizeForDistribution({ assetKind: "social_post", text: "Pay $1,200 at 6.5% by 12/01/2026 for 3 rooms", tenantBrand: null })
    check("the material-term finder (positive control): amounts, percents, dates, counts — all carried", ["$1,200", "6.5%", "12/01/2026", "3"].every((t) => terms.materialTerms.source.includes(t)) && terms.materialTerms.missing.length === 0, JSON.stringify(terms.materialTerms))
    const tour = await finalizeForDistribution({ assetKind: "social_post", text: "Tour the home Saturday from 1 to 3.", tenantBrand: null })
    check("the testimonial finder (clean control): ordinary copy names none", tour.testimonials.length === 0)
  }
  {
    const html = await finalizeForDistribution({ assetKind: "blog_post", html: `<h2 class="x">Pricing</h2><p>It's important to note that pricing comes first.</p><a href="/in-today's-fast-paced-market,">link</a>`, tenantBrand: { tagline: "Calm advice, local roots" } })
    check("HTML: only text between tags is rewritten (an attribute holding a tell is untouched); the tagline lands as its own paragraph", html.format === "html" && html.text.includes(`<a href="/in-today's-fast-paced-market,">`) && html.text.includes("<p>Pricing comes first.</p>") && html.text.includes(`<p class="brand-tagline">— Calm advice, local roots</p>`), html.text)
    const human = await finalizeForDistribution({ assetKind: "social_post", text: "Let's delve into the numbers together.", tenantBrand: null, authoredBy: "human" })
    check("a HUMAN's own words are never re-flagged for machine phrasing (the 144H rule)", human.openTells.length === 0 && human.removed.length === 0 && human.text.startsWith("Let's delve into"))
    let threw = false
    try { await finalizeForDistribution({ assetKind: "billboard" as never, text: "x", tenantBrand: null }) } catch { threw = true }
    check("an unknown asset kind is a programming error (throws), never a silent pass", threw)
    check("every asset kind has a profile on a PUBLIC copy surface (the fair-housing scan applies)", HUMANIZE_ASSET_KINDS.every((k) => !!HUMANIZE_KIND_PROFILE[k]) && Object.keys(HUMANIZE_KIND_PROFILE).length === HUMANIZE_ASSET_KINDS.length)
  }
  {
    const lib = walk(join(ROOT, "lib")).filter((f) => /\.(ts|tsx)$/.test(f))
    const definers = lib.filter((f) => /const AI_TELLS\b/.test(blankStrings(stripComments(readFileSync(f, "utf8")))))
    const hf = code("lib/marketing/humanize-final.ts")
    check("ONE written-tell list: only lib/lead-magnets/book-editorial.ts defines AI_TELLS, and the final phase imports its scanner + stripper (never a second humanizer)",
      definers.length === 1 && definers[0].endsWith("lib/lead-magnets/book-editorial.ts") && /from "@\/lib\/lead-magnets\/book-editorial"/.test(hf) && /stripAiTells\(/.test(hf) && /scanAiTells\(/.test(hf), definers.join(","))
    check("…and ONE tagline vetting: the book cover's approvedBookBrandAssets calls vetBrandTagline", /vetBrandTagline\(/.test(code("lib/lead-magnets/book-publishing-produce.ts")))
  }

  // ═══════════════════ B · the version ledger ═══════════════════
  section("B · distribution_finals — staged, announced, superseded, proven at the door")
  {
    const db = memSupabase({ distribution_finals: [], notifications: [] }, { uuidIds: true })
    const f1 = await finalizeForDistribution({ assetKind: "blog_post", text: "Spring checklist for sellers in Riverbend.", tenantBrand: { tagline: "Calm advice, local roots" } })
    const s1 = await stageDistributionFinal(db, { brokerageId: B1, assetTable: "blog_posts", assetId: "11111111-1111-4111-8111-111111111111", final: f1, createdBy: U1, notifyUserId: U1, now: NOW })
    const row1 = db.tables.distribution_finals[0]
    check("STAGED: version 1, awaiting approval, the exact final + its hash + findings recorded", s1.ok && s1.version === 1 && row1?.status === "awaiting_approval" && row1.final_text === f1.text && row1.content_sha256 === f1.sha256 && row1.asset_kind === "blog_post" && !!row1.findings?.summary, JSON.stringify(s1))
    check("THE MOMENT IT IS READY the human is told (an in-app notification naming the asset), and the stamp lands", s1.ok && s1.notified && db.tables.notifications.length === 1 && db.tables.notifications[0].type === FINAL_READY_NOTIFICATION_TYPE && db.tables.notifications[0].user_id === U1 && db.tables.notifications[0].entity_id === "11111111-1111-4111-8111-111111111111" && row1.notified_user_id === U1 && !!row1.notified_at)
    const s1b = await stageDistributionFinal(db, { brokerageId: B1, assetTable: "blog_posts", assetId: "11111111-1111-4111-8111-111111111111", final: f1, createdBy: U1, notifyUserId: U1, now: NOW })
    check("IDEMPOTENT: the same final is reused — no second version, no second notification", s1b.ok && s1b.reused && db.tables.distribution_finals.length === 1 && db.tables.notifications.length === 1)
    const f2 = await finalizeForDistribution({ assetKind: "blog_post", text: "Spring checklist for sellers in Riverbend, revised.", tenantBrand: null })
    const s2 = await stageDistributionFinal(db, { brokerageId: B1, assetTable: "blog_posts", assetId: "11111111-1111-4111-8111-111111111111", final: f2, createdBy: U1, notifyUserId: U1, now: NOW })
    check("a NEW final is version 2 and SUPERSEDES the unpublished first", s2.ok && s2.version === 2 && db.tables.distribution_finals.find((r) => r.version === 1)?.status === "superseded")
    const noApproval = await checkDistributionPublication(db, { brokerageId: B1, assetKind: "blog_post", assetTable: "blog_posts", assetId: "11111111-1111-4111-8111-111111111111", content: f2.text, approval: { approved: false, by: null, at: null } })
    check("THE DOOR refuses an UNAPPROVED piece (fail closed — never publishes on its own)", !noApproval.ok && /not approved by a person/.test(noApproval.reason))
    const rec = await recordDistributionPublication(db, { brokerageId: B1, assetKind: "blog_post", assetTable: "blog_posts", assetId: "11111111-1111-4111-8111-111111111111", content: f2.text, approval: { approved: true, by: U1, at: day(0) }, via: "wordpress", ref: "wp-77", now: NOW })
    const pub = db.tables.distribution_finals.find((r) => r.version === 2)
    check("…and RECORDS the approved version that went out: published, by whom, through which door, the provider ref and the sent hash", rec.ok && !rec.humanEdit && pub?.status === "published" && pub.approved_by === U1 && pub.published_via === "wordpress" && pub.published_ref === "wp-77" && pub.published_sha256 === f2.sha256 && pub.approval_basis === "asset_approval")
    const edited = "Spring checklist for sellers in Riverbend — my own final words."
    const recEdit = await recordDistributionPublication(db, { brokerageId: B1, assetKind: "blog_post", assetTable: "blog_posts", assetId: "11111111-1111-4111-8111-111111111111", content: edited, approval: { approved: true, by: U1, at: day(0) }, via: "wordpress", ref: "wp-78", now: NOW })
    const v3 = db.tables.distribution_finals.find((r) => r.version === 3)
    check("a HUMAN EDIT published instead is recorded as ITS OWN version (basis human_edit) — the record is always the text that was sent", recEdit.ok && recEdit.humanEdit && v3?.final_text === edited && v3.status === "published" && v3.approval_basis === "human_edit")
    const steering = await checkDistributionPublication(db, { brokerageId: B1, assetKind: "blog_post", assetTable: "blog_posts", assetId: "11111111-1111-4111-8111-111111111111", content: "Perfect for families with young children.", approval: { approved: true, by: U1, at: day(0) } })
    const prohibited = await checkDistributionPublication(db, { brokerageId: B1, assetKind: "blog_post", assetTable: "blog_posts", assetId: "11111111-1111-4111-8111-111111111111", content: "A cheap listing plan.", approval: { approved: true, by: U1, at: day(0) }, tenantBrand: { prohibitedWords: ["cheap"] } })
    check("…but no approval WAIVES a hard fair-housing finding or a word the brand prohibits (edit refused)", !steering.ok && /fair housing/.test(steering.reason) && !prohibited.ok && /prohibited/.test(prohibited.reason))
    const derivedDb = memSupabase({ distribution_finals: [], notifications: [] }, { uuidIds: true })
    const d = await stageDistributionFinal(derivedDb, { brokerageId: B1, assetTable: "social_posts", assetId: "22222222-2222-4222-8222-222222222222", final: f1, createdBy: U1, notifyUserId: U1, derivedFromApproval: { by: U1, at: day(-1) }, now: NOW })
    check("a version DERIVED from an asset a person already approved is recorded approved (basis derived) and nobody is re-asked", d.ok && d.status === "approved" && derivedDb.tables.distribution_finals[0].approval_basis === "derived_from_approved_asset" && derivedDb.tables.notifications.length === 0)
    const announcedDb = memSupabase({ distribution_finals: [], notifications: [] }, { uuidIds: true })
    const an = await stageDistributionFinal(announcedDb, { brokerageId: B1, assetTable: "lead_capture_forms", assetId: "33333333-3333-4333-8333-333333333333", final: f1, createdBy: U1, notifyUserId: U1, announcedBy: "lead_magnet_fair_housing_review", now: NOW })
    const anRow = announcedDb.tables.distribution_finals[0]
    // Positive control: the SAME staging without announcedBy wrote exactly one bell (the "THE MOMENT IT IS READY" check above).
    check("ONE bell per version: a version the caller's own bell already announced (the fair-housing escalation) writes NO second notification, yet records who was told and when", an.ok && an.notified && an.notifyError === null && announcedDb.tables.notifications.length === 0 && anRow?.notified_user_id === U1 && !!anRow?.notified_at && anRow?.status === "awaiting_approval", JSON.stringify(an))
    const refused = memSupabase({}, { refuse: { distribution_finals: "permission denied for table distribution_finals" } })
    const r = await stageDistributionFinal(refused, { brokerageId: B1, assetTable: "blog_posts", assetId: "11111111-1111-4111-8111-111111111111", final: f1, createdBy: U1, notifyUserId: U1 })
    const c = await checkDistributionPublication(refused, { brokerageId: B1, assetKind: "blog_post", assetTable: "blog_posts", assetId: "11111111-1111-4111-8111-111111111111", content: f1.text, approval: { approved: true, by: U1, at: null } })
    check("FAIL CLOSED: a refused read is an error at staging AND at the door (never 'no final, go ahead')", !r.ok && /refused/.test(r.error) && !c.ok && /refused/.test(c.reason))
    const other = await checkDistributionPublication(db, { brokerageId: B2, assetKind: "blog_post", assetTable: "blog_posts", assetId: "11111111-1111-4111-8111-111111111111", content: f2.text, approval: { approved: true, by: U1, at: day(0) } })
    check("TENANT-PINNED: another brokerage sees NO final for this asset (the same text reads as its own edit, never B1's version)", other.ok && other.humanEdit && other.finalId === null, JSON.stringify(other))
    const discDb = memSupabase({ distribution_finals: [], notifications: [] }, { uuidIds: true })
    const withEho = await finalizeForDistribution({ assetKind: "email_campaign", text: "Spring prices in Riverbend. Equal Housing Opportunity.", tenantBrand: null })
    await stageDistributionFinal(discDb, { brokerageId: B1, assetTable: "email_campaigns", assetId: "55555555-5555-4555-8555-555555555555", final: withEho, createdBy: U1, notifyUserId: U1, now: NOW })
    const dropped = await checkDistributionPublication(discDb, { brokerageId: B1, assetKind: "email_campaign", assetTable: "email_campaigns", assetId: "55555555-5555-4555-8555-555555555555", content: "Spring prices in Riverbend, reworded by me.", approval: { approved: true, by: U1, at: day(0) } })
    const keptEho = await checkDistributionPublication(discDb, { brokerageId: B1, assetKind: "email_campaign", assetTable: "email_campaigns", assetId: "55555555-5555-4555-8555-555555555555", content: "Spring prices in Riverbend, reworded by me. Equal Housing Opportunity.", approval: { approved: true, by: U1, at: day(0) } })
    check("an approved edit that DROPS a disclosure the staged final carried is refused; the same edit keeping it passes (control)", !dropped.ok && /required disclosure is missing/.test(dropped.reason) && /Equal Housing Opportunity/.test(dropped.reason) && keptEho.ok && keptEho.humanEdit, JSON.stringify({ dropped, keptEho }))
  }

  // ═══════════════════ C · the topic bank's intelligence ═══════════════════
  section("C · ruling 22 — every source into the ONE pool, themes never creative, evidence on every row")
  {
    const named = TOPIC_SOURCE_CLASSES.flatMap((k) => (TOPIC_SOURCE_CENSUS[k]?.writer ?? "").match(/(?:lib|app)\/[\w\-./[\]]+\.ts/g) ?? [])
    const missing = named.filter((f) => !existsSync(join(ROOT, f)))
    check("the CENSUS names a writer for every source class the ruling lists, and every named writer file exists", TOPIC_SOURCE_CLASSES.every((k) => ((TOPIC_SOURCE_CENSUS[k]?.writer ?? "").match(/(?:lib|app)\//g) ?? []).length > 0) && named.length >= TOPIC_SOURCE_CLASSES.length && missing.length === 0, missing.join(", "))
  }
  const CAPTION = "ZZ-UNIQUE-CAPTION Our team closes faster than anyone"
  const post = (o: Partial<CompetitorContentRow>): CompetitorContentRow => ({ competitor_id: "c1", platform: "instagram", content_type: "reel", content_url: null, detected_topics: [], hook_type: "question", engagement_rate: 10, is_high_performing: false, likes_count: null, comments_count: null, shares_count: null, views_count: null, observed_at: day(-2), posted_at: day(-3), ...o })
  {
    const rows = [
      post({ detected_topics: ["closing costs"], content_url: "https://ig/p/1", engagement_rate: 80, is_high_performing: true }),
      post({ detected_topics: ["closing costs"], content_url: "https://ig/p/2", competitor_id: "c2" }),
      post({ detected_topics: ["staging tips"] }),
      post({ detected_topics: ["best school ratings"] }), post({ detected_topics: ["best school ratings"] }),
    ]
    const r = competitorPostThemes(rows, NOW)
    const theme = r.themes[0]
    check("COMPETITOR POST THEMES: a topic two posts share becomes a theme; a single post is not a trend; a school-rating topic is EXCLUDED (steering)", r.themes.length === 1 && /closing costs/.test(theme.title) && (r.dropped.single_post ?? 0) === 1 && (r.dropped["excluded_topic:school_rating"] ?? 0) === 2, JSON.stringify(r.dropped))
    check("…its evidence is the ACCESSIBLE kind and SAYS so: counts are NULL (platform auth) → basis search_rank_proxy, never invented interactions", theme.evidence.engagement.basis === "search_rank_proxy" && theme.evidence.theme_only === true && theme.evidence.private_metrics === false && /proxy/.test(theme.evidence.confidence_basis))
    const counted = competitorPostThemes([post({ detected_topics: ["inspections"], likes_count: 40, comments_count: 5, shares_count: 2 }), post({ detected_topics: ["inspections"], likes_count: 10 })], NOW).themes[0]
    check("…public counts when the post carries them (basis public_counts, the total named)", counted?.evidence.engagement.basis === "public_counts" && counted.evidence.engagement.metrics.public_interactions === 57)
    const caps = JSON.stringify(competitorPostThemes([post({ detected_topics: ["closing costs"] }), post({ detected_topics: ["closing costs"] })].map((p) => ({ ...p, caption: CAPTION } as never)), NOW))
    check("THEMES, NEVER CREATIVE: a competitor caption fed alongside is nowhere in the output (positive control: the same string is detectable)", !caps.includes("ZZ-UNIQUE-CAPTION") && JSON.stringify({ CAPTION }).includes("ZZ-UNIQUE-CAPTION"))
    const viral = viralPatternThemes([post({ engagement_rate: 10 }), post({ engagement_rate: 12 }), post({ engagement_rate: 11 }), post({ engagement_rate: 40, content_type: "short_video", hook_type: "question" })], NOW)
    const flat = viralPatternThemes([post({ engagement_rate: 10 }), post({ engagement_rate: 12 }), post({ engagement_rate: 11 }), post({ engagement_rate: 15 })], NOW)
    check(`HIGH-ENGAGEMENT PATTERN: a format + hook at ≥ 2× the competitor's OWN median is a pattern (a shape, never their words); none when nothing outperforms`, viral.length === 1 && /short video/.test(viral[0].title) && /question hook/.test(viral[0].title) && /never their words/.test(viral[0].valueAngle) && flat.length === 0)
  }
  {
    const PRIVATE = "ZZ-PRIVATE-WORDS my divorce lawyer said"
    const q = (k: string, text: string) => ({ contact_key: k, text, at: day(-1) })
    const r = customerQuestionThemes([
      q("c:1", "What are the closing costs on a $400k home?"), q("c:2", "how much are closing costs here"), q("c:3", `Closing costs? ${PRIVATE}`),
      q("c:4", "Is my credit score good enough?"), q("c:1", "We loved the house."), q("c:5", "Which are the best schools near the house?"),
    ], NOW)
    check(`CUSTOMER QUESTIONS: a theme ≥ ${MIN_DISTINCT_ASKERS} distinct askers becomes a topic; fewer stays PRIVATE; a statement is not a question; a school question is excluded`,
      r.themes.length === 1 && /closing costs/i.test(r.themes[0].title) && r.askersByTheme.get("credit") === 1 && (r.dropped.too_few_askers ?? 0) >= 1 && (r.dropped["excluded_topic:school_rating"] ?? 0) === 1, JSON.stringify({ t: r.themes.map((x) => x.title), d: r.dropped }))
    check("…COUNTS, NEVER WORDS OR WHO: no message text and no contact key anywhere in the topic (positive control: the planted phrase)", !JSON.stringify(r.themes).includes("ZZ-PRIVATE") && !JSON.stringify(r.themes).includes("c:1") && r.themes[0].evidence.engagement.metrics.distinct_askers === 3)
    const gaps = educationGapThemes(r.askersByTheme, [{ title: "Understanding credit", summary: null, gap_tags: [], status: "published" }, { title: "Closing costs explained", summary: null, gap_tags: [], status: "draft" }], NOW)
    const covered = educationGapThemes(r.askersByTheme, [{ title: "Closing costs explained", summary: null, gap_tags: [], status: "published" }], NOW)
    check("EDUCATION GAP: a theme enough clients ask about that no PUBLISHED module covers (a draft does not count); none once a published module covers it", gaps.length === 1 && /closing costs/i.test(gaps[0].title) && covered.length === 0)
  }
  {
    const obs = (query: string, outcome: string, competitors: string[] = []) => ({ query, outcome, competitors_cited: competitors, platform: "chatgpt", observed_at: day(-1) })
    const g = aiSearchGapThemes([obs("how much are closing costs in Riverbend", "not_cited", ["Rival Realty"]), obs("how much are closing costs in Riverbend", "cited"), obs("best realtor in Riverbend", "not_checked", ["X"]), obs("homes for sale in Riverbend", "not_cited", [])], NOW)
    check("AI-SEARCH GAP: answers that name competitors and not us become a topic; a cited / unchecked / competitor-less answer does not; visibility is never promised", g.length === 1 && /closing costs in Riverbend/.test(g[0].title) && g[0].evidence.engagement.metrics.competitor_citations === 1 && /never promised/.test(g[0].valueAngle))
  }
  {
    const md = (o: Record<string, unknown>) => ({ zip_code: "33602", city: "Tampa", state: "FL", market_area: null, data_date: day(-10), source_type: "mls_feed", median_sale_price: 410000, price_trend_pct_30d: 0.5, price_trend_pct_90d: 3.1, price_trend_pct_1yr: 4.2, months_of_inventory: 1.5, avg_days_on_market: 18, ...o })
    const m = marketThemes([md({}), md({ zip_code: "33606", data_date: day(-200) }), md({ zip_code: "33611", months_of_inventory: 5, price_trend_pct_90d: 0.4, price_trend_pct_1yr: null })], NOW)
    const trend = m.themes.find((t) => t.evidence.source_class === "property_value_trend")
    const change = m.themes.find((t) => t.evidence.source_class === "market_change")
    check("PROPERTY-VALUE TREND: the 12-month figure WITH its source + date as the only facts; never a valuation of any one home", !!trend && /up 4.2%/.test(trend.title) && (trend.evidence.facts ?? []).every((f) => /market_data \(mls_feed, as of /.test(f)) && /never the value of any one home/.test(trend.valueAngle) && trend.valueAngle.includes("+4.2%"))
    check("MARKET CHANGE by the realestate-market supply bands (1.5 months → strong seller's); a balanced, quiet ZIP makes none; 200-day-old data is dropped as stale", !!change && /strong seller's/.test(change.title) && m.themes.filter((t) => t.evidence.source_class === "market_change").length === 1 && (m.dropped.stale_market_data ?? 0) === 1 && /strong buyer's market/.test(marketThemes([md({ zip_code: "33612", months_of_inventory: 9, price_trend_pct_90d: 0.1, price_trend_pct_1yr: null })], NOW).themes[0]?.title ?? ""))
    const hist = marketThemes([md({ zip_code: "33620", months_of_inventory: 5, median_sale_price: 420000, data_date: day(-5), price_trend_pct_1yr: null }), md({ zip_code: "33620", months_of_inventory: 5, median_sale_price: 400000, data_date: day(-95), price_trend_pct_1yr: null })], NOW)
    const h90 = hist.themes.find((t) => t.evidence.source_class === "market_change")
    check("the 90-DAY MOVE is DERIVED from the tenant's own dated median prices (never a column nobody writes): +5% across two rows ~90 days apart files a market change in a balanced ZIP, the fact naming both dates; one row alone files none",
      !!h90 && /\+5% in 90 days/.test(h90.title) && (h90.evidence.facts ?? []).some((f) => /\$400,000 on .+ → \$420,000 on .+\+5%/.test(f)) && marketThemes([md({ zip_code: "33620", months_of_inventory: 5, price_trend_pct_1yr: null })], NOW).themes.length === 0, JSON.stringify(hist.themes.map((t) => ({ title: t.title, facts: t.evidence.facts }))))
    const HEAD = "ZZ-RIVAL-HEADLINE Lowest closing costs in Tampa guaranteed"
    const ad = competitorAdTheme(HEAD, "Call us about closing costs and down payment help")
    check("COMPETITOR AD → THEME, never the headline (positive control: the planted headline is absent); a steering ad yields nothing", !!ad && /closing costs/i.test(ad.title.toLowerCase()) && !JSON.stringify(ad).includes("ZZ-RIVAL") && competitorAdTheme("Safest neighborhood, low crime", "") === null, JSON.stringify(ad))
  }
  {
    const world = (refuse: Record<string, string> = {}, sourceActive = true) => memSupabase({
      content_topic_sources: sourceActive ? [] : [{ id: "src-off", brokerage_id: B1, source_type: "manual", is_active: false, source_config: { system_writer: "topic_intelligence" }, created_at: day(-30) }],
      competitor_content: [post({ detected_topics: ["closing costs"], engagement_rate: 70 }), post({ detected_topics: ["closing costs"], competitor_id: "c2", engagement_rate: 60 })].map((p) => ({ ...p, brokerage_id: B1 })),
      messages: [1, 2, 3].map((i) => ({ brokerage_id: B1, contact_id: `ct-${i}`, direction: "inbound", body: "What are the closing costs here?", created_at: day(-1) })),
      listing_inquiries: [], learning_modules: [],
      ai_search_citation_observations: [{ brokerage_id: B1, query: "what are closing costs in Tampa", outcome: "not_cited", competitors_cited: ["Rival"], platform: "chatgpt", observed_at: day(-1) }],
      market_data: [{ brokerage_id: B1, zip_code: "33602", city: "Tampa", state: "FL", market_area: null, data_date: day(-5), source_type: "mls_feed", median_sale_price: 410000, price_trend_pct_30d: 0.2, price_trend_pct_90d: 2.5, price_trend_pct_1yr: 4.2, months_of_inventory: 1.5, avg_days_on_market: 18 }],
      content_topic_bank: [], approval_items: [],
    }, { uuidIds: true, stampCreatedAt: true, refuse })
    const db = world()
    const r1 = await runTopicIntelligencePass(db, B1, { now: NOW })
    const src = db.tables.content_topic_sources.find((s) => s.source_config?.system_writer === "topic_intelligence")
    const rows = db.tables.content_topic_bank
    check("THE PASS files every source class it can read into the ONE pool under the tenant's own system source (the tenant's off switch)", r1.ran && r1.inserted >= 5 && !!src && rows.every((t) => t.source_id === src.id && t.brokerage_id === B1 && t.status === "fresh" && (t.categories ?? []).includes("topic_intelligence")), JSON.stringify({ r1: { ...r1, dropped: undefined }, n: rows.length }))
    const classes = new Set(rows.map((t) => t.raw_data?.topic_evidence?.source_class))
    check("…competitor post, customer question, education gap, AI-search gap, property-value trend and market change each landed", ["competitor_post", "customer_question", "education_gap", "ai_search_gap", "property_value_trend", "market_change"].every((k) => classes.has(k)), [...classes].join(","))
    check("EVERY ROW carries the ruling's evidence: source, timestamp, engagement basis, confidence; a theme, no private metric", rows.every((t) => { const e = t.raw_data?.topic_evidence; return !!e?.source && !!e.observed_at && !!e.engagement?.basis && typeof e.confidence === "number" && e.confidence > 0 && e.confidence <= 1 && e.theme_only === true && e.private_metrics === false }))
    const ideas = db.tables.approval_items.filter((i) => i.item_type === TOPIC_CAMPAIGN_IDEA_ITEM_TYPE)
    const tvItems = db.tables.approval_items.filter((i) => i.item_type === CTV_TOPIC_ITEM_TYPE)
    check("the strongest new themes become ORIGINAL campaign ideas PENDING a person's approval (≤ 3), and ONE TV-suitable theme is filed for TV approval", ideas.length >= 1 && ideas.length <= 3 && ideas.every((i) => i.status === "pending" && i.brokerage_id === B1) && tvItems.length === 1 && tvItems[0].status === "pending" && r1.proposedTv === 1)
    const before = rows.length, ideasBefore = db.tables.approval_items.length
    const r2 = await runTopicIntelligencePass(db, B1, { now: NOW })
    check("IDEMPOTENT: a second pass REFRESHES the same themes (no duplicate rows, no duplicate ideas)", r2.inserted === 0 && r2.refreshed === before && db.tables.content_topic_bank.length === before && db.tables.approval_items.length === ideasBefore)
    const off = world({}, false)
    const r3 = await runTopicIntelligencePass(off, B1, { now: NOW })
    check("the tenant SWITCHED the source off → nothing filed, said", !r3.ran && off.tables.content_topic_bank.length === 0 && r3.blindSpots.some((b) => /switched/.test(b)))
    const blindCompetitor = world({ competitor_content: "permission denied for table competitor_content" })
    const r4 = await runTopicIntelligencePass(blindCompetitor, B1, { now: NOW })
    check("a refused competitor read is a PUBLISHED blind spot and the other sources still land", r4.ran && r4.blindSpots.some((b) => /competitor posts not read/.test(b)) && blindCompetitor.tables.content_topic_bank.length > 0 && !blindCompetitor.tables.content_topic_bank.some((t) => t.raw_data?.topic_evidence?.source_class === "competitor_post"))
    const blindBank = world({ content_topic_bank: "permission denied for table content_topic_bank" })
    const r5 = await runTopicIntelligencePass(blindBank, B1, { now: NOW })
    check("FAIL CLOSED: a refused pool read files NOTHING and says why", r5.inserted === 0 && r5.errors.some((e) => /content_topic_bank read refused/.test(e)))

    // readTopicApproval (the community door's gate)
    const topicId = rows[0].id
    const pending = await readTopicApproval(db, B1, topicId, { now: NOW })
    db.tables.approval_items.push({ id: "ap-1", brokerage_id: B1, item_type: TOPIC_CAMPAIGN_IDEA_ITEM_TYPE, item_id: topicId, status: "approved", reviewed_by: U1, reviewed_at: day(0) })
    const ok = await readTopicApproval(db, B1, topicId, { now: NOW })
    const foreign = await readTopicApproval(db, B2, topicId, { now: NOW })
    const expired = await readTopicApproval(db, B1, topicId, { now: new Date(NOW.getTime() + 400 * 86_400_000) })
    check("readTopicApproval: pending / never-proposed is NOT approved; a person's approval IS; another tenant and an expired topic are not", !pending.approved && ok.approved && ok.approvedBy === U1 && !foreign.approved && !expired.approved && /expired/.test(expired.reason))
  }
  {
    const tb = code("lib/content-intel/topic-bank.ts")
    check("pickTopics READS its refusal now (a refused pool read is said, not an empty bank)", /\{ data, error: poolErr \} = await q/.test(tb) && /if \(poolErr\) console\.error/.test(tb))
    const li = code("lib/content-intel/local-intel.ts")
    check("the pass is WIRED: the local-intelligence sweep (cron /api/cron/local-intel) runs it per tenant after the local facts", /export async function runLocalIntelSweep[\s\S]*runTopicIntelligencePass\(db, b,/.test(li))
  }

  // ═══════════════════ D · contract C5 — TV from an approved topic ═══════════════════
  section("D · contract C5 — an APPROVED topic + its creative → the Ads Manager's ONE TV gateway")
  {
    const TOPIC = "33333333-3333-4333-8333-333333333333", VID = "44444444-4444-4444-8444-444444444444"
    const evidence = { source_class: "market_change", source: "market_data (mls_feed, as of 2026-10-20)", observed_at: day(-7), feeds: ["ctv_ad", "video"], facts: ["Months of supply in ZIP 33602: 1.5 (market_data (mls_feed, as of 2026-10-20))"] }
    check("topicSuitsTv: a market change / evidence naming TV suits; a customer question does not (positive + clean control)", topicSuitsTv({ categories: ["market_change"], evidence: evidence as never }) && !topicSuitsTv({ categories: ["customer_question"], evidence: { feeds: ["education"], source_class: "customer_question" } as never }))
    const brief = tvSpotBriefFromTopic({ title: "Market shift in ZIP 33602", evidence: evidence as never })
    check("the TV BRIEF: the only claims are the topic's facts with source + date; tagline on the end card; no competitor creative; no promised result", brief.claims.length === 1 && /market_data/.test(brief.claims[0]) && brief.directions.some((d) => /End card/.test(d)) && brief.directions.some((d) => /never a competitor/.test(d)))
    const video = (o: Record<string, unknown> = {}) => ({ id: VID, brokerage_id: B1, title: "Riverbend market update", script_content: "Inventory in 33602 sits at 1.5 months of supply.", video_type: "market_update", audience_type: "customer_facing", usage_intent: "public_marketing", contact_id: null, learning_module_id: null, approval_status: "approved", approved_by: U1, approved_at: day(-1), status: "completed", compliance_status: "passed", video_url: "https://cdn/v.mp4", video_metadata: {}, ...o })
    const seed = (items: Array<Record<string, unknown>>, vid = video(), uses = [{ id: "use-1", brokerage_id: B1, topic_id: TOPIC, asset_id: VID, asset_type: "situational_reel" }]) => memSupabase({
      approval_items: items, ai_video_projects: [vid], content_topic_uses: uses, distribution_finals: [], notifications: [], agent_action_ledger: [],
      content_topic_bank: [{ id: TOPIC, brokerage_id: B1, topic_title: "Market shift in ZIP 33602", value_angle: "…", categories: ["market_change", "topic_intelligence"], status: "fresh", expires_at: day(20), raw_data: { topic_evidence: evidence } }],
    }, { uuidIds: true })
    const calls: CtvGatewayInput[] = []
    const gateway = async (i: CtvGatewayInput) => { calls.push(i); return { success: true, package: { campaignId: "camp-1", warnings: [] } } }
    const uses: string[] = []
    const deps = (db: ReturnType<typeof seed>) => ({ client: db as never, gateway, brand: async () => ({ tagline: "Calm advice, local roots" }), logUse: async (a: { assetId: string }) => { uses.push(a.assetId) }, ledger: false, now: NOW })
    const req = { brokerageId: B1, agentUserId: U1, topicId: TOPIC, assetId: VID, dailyBudgetCents: 2500, targeting: { cities: ["Tampa"] } }
    const unapproved = await stageTopicTvSpot(req, deps(seed([{ id: "a1", brokerage_id: B1, item_type: CTV_TOPIC_ITEM_TYPE, item_id: TOPIC, status: "pending", submitted_at: day(-1) }])))
    check("an UNAPPROVED topic (pending) is refused and the gateway is NEVER called", !unapproved.ok && /not approved for TV/.test(unapproved.reason) && calls.length === 0)
    const approved = [{ id: "a1", brokerage_id: B1, item_type: CTV_TOPIC_ITEM_TYPE, item_id: TOPIC, status: "approved", reviewed_by: U1, reviewed_at: day(-1), submitted_at: day(-2) }]
    const notFromTopic = await stageTopicTvSpot(req, deps(seed(approved, video(), [])))
    check("an approved topic with a creative NOT made from it is refused (ruling 13: TV ads derive from the topic bank)", !notFromTopic.ok && /not made from this topic/.test(notFromTopic.reason) && calls.length === 0)
    const notPublic = await stageTopicTvSpot(req, deps(seed(approved, video({ approval_status: "pending_review" }))))
    check("a creative a person has NOT approved for public release is refused (the public-video classification)", !notPublic.ok && /not an approved public marketing video/.test(notPublic.reason) && calls.length === 0)
    const db = seed(approved)
    const ok = await stageTopicTvSpot(req, deps(db))
    check("APPROVED topic + its approved creative → the ONE gateway with the contract's { topicId, assetId } (and the creative's old name, equal)", ok.ok && calls.length === 1 && calls[0].topicId === TOPIC && calls[0].assetId === VID && calls[0].videoProjectId === VID && calls[0].dailyBudgetCents === 2500, JSON.stringify(ok))
    check("…the spot's words passed the final phase and are recorded as the version the VIDEO's approval covers (derived), the tagline on the end card", ok.ok && db.tables.distribution_finals.length === 1 && db.tables.distribution_finals[0].asset_kind === "ctv_ad" && db.tables.distribution_finals[0].approval_basis === "derived_from_approved_asset" && db.tables.distribution_finals[0].tagline === "Calm advice, local roots")
    check("…and the spot CLAIMS its topic (content_topic_uses asset_type ctv_ad, the campaign id)", uses.join() === "camp-1")
    const refusedClaim = await stageTopicTvSpot(req, { ...deps(seed(approved)), logUse: async () => ({ error: 'new row violates check constraint "content_topic_uses_asset_type_check"' }) })
    check("a REFUSED topic claim (the CHECK before m866) is REPORTED on the result — never a silent 'claimed' (positive control: the claim that landed above carries no such warning)",
      refusedClaim.ok && refusedClaim.warnings.some((w) => /topic claim not recorded: .*asset_type_check/.test(w)) && ok.ok && !ok.warnings.some((w) => /topic claim not recorded/.test(w)), JSON.stringify(refusedClaim))
    const revoked = await stageTopicTvSpot(req, deps(seed([...approved, { id: "a2", brokerage_id: B1, item_type: CTV_TOPIC_ITEM_TYPE, item_id: TOPIC, status: "rejected", reviewed_by: U1, reviewed_at: day(0), submitted_at: day(-2) }])))
    check("the LATEST decision wins: a later rejection revokes the approval", !revoked.ok && /rejection/.test(revoked.reason))
    const blindDb = memSupabase({ ai_video_projects: [video()] }, { refuse: { approval_items: "permission denied for table approval_items" } })
    const blindR = await stageTopicTvSpot(req, deps(blindDb as never))
    check("FAIL CLOSED: an unreadable approval refuses", !blindR.ok && /refused/.test(blindR.reason))
    const lane = code("lib/marketing/ctv-lane.ts")
    check("NO SECOND TV SUBSYSTEM: the lane's only provider path is the Ads Manager's stageCtvCampaign (no Vibe import, no dispatch)", /import\("@\/lib\/ads\/ctv-campaign"\)/.test(lane) && /stageCtvCampaign\(/.test(lane) && !/providers\/vibe|dispatchCtvCampaign|launchCtvCampaignOnVibe/.test(lane))
    // C5 ONE VOCABULARY (§6): the TV gateway's approval item types (lane 145D, lib/ads/ctv-campaign.ts) and this lane's
    // pre-flight read must be the SAME set — the module is imported and the VALUES compared (never a text match on source).
    const gwMod = (await import("../lib/ads/ctv-campaign").catch((e) => ({ __importError: String(e) }))) as unknown as Record<string, unknown>
    const gwTypes = gwMod.CTV_TOPIC_APPROVAL_ITEM_TYPES as readonly string[] | undefined
    if (Array.isArray(gwTypes)) {
      const same = gwTypes.length === CTV_TOPIC_APPROVAL_TYPES.length && CTV_TOPIC_APPROVAL_TYPES.every((t) => gwTypes.includes(t))
      check("C5 ONE VOCABULARY: the gateway's CTV_TOPIC_APPROVAL_ITEM_TYPES and this lane's CTV_TOPIC_APPROVAL_TYPES are the SAME set (the filer, the pre-flight and the gate cannot drift)", same, JSON.stringify({ gateway: gwTypes, lane: CTV_TOPIC_APPROVAL_TYPES }))
      // Positive control: the comparison sees a drift when one exists.
      const drifted = [...CTV_TOPIC_APPROVAL_TYPES, "tv_topic"]
      check("C5 ONE VOCABULARY positive control: a list with one extra spelling is NOT the same set", !(drifted.length === gwTypes.length && drifted.every((t) => gwTypes.includes(t))))
    } else blind.push(`C5 gateway vocabulary NOT CHECKED — lib/ads/ctv-campaign.ts does not yet export CTV_TOPIC_APPROVAL_ITEM_TYPES (lane 145D lands it; it must equal [${CTV_TOPIC_APPROVAL_TYPES.join(", ")}])${gwMod.__importError ? ` — import failed: ${gwMod.__importError}` : ""}`)
  }

  // ═══════════════════ E · the community video door ═══════════════════
  section("E · the community / event video door — on the YouTube survivor")
  {
    const TOPIC = "55555555-5555-4555-8555-555555555555", VID = "66666666-6666-4666-8666-666666666666", AGENT = "00000000-0000-4000-8000-0000000000d2"
    const vid = (o: Record<string, unknown> = {}) => ({ id: VID, brokerage_id: B1, agent_id: AGENT, listing_id: null, marketing_campaign_id: null, title: "Riverbend Fall Festival this Saturday", video_type: "social_reel", audience_type: "customer_facing", usage_intent: "public_marketing", contact_id: null, learning_module_id: null, approval_status: "approved", approved_by: U1, approved_at: day(-1), status: "completed", compliance_status: "passed", video_url: "https://cdn/fest.mp4", script_content: "In today's fast-paced world, the Riverbend Fall Festival returns on Saturday, Nov 1.", video_metadata: {}, ...o })
    const seed = (items: Array<Record<string, unknown>>, v = vid(), uses = [{ id: "u1", brokerage_id: B1, topic_id: TOPIC, asset_id: VID, asset_type: "situational_reel" }]) => memSupabase({
      approval_items: items, ai_video_projects: [v], content_topic_uses: uses, agents: [{ id: AGENT, brokerage_id: B1, user_id: U1 }],
      social_media_accounts: [{ id: "acct-yt", brokerage_id: B1, agent_id: AGENT, platform: "youtube", is_active: true }], social_posts: [], brokerage_settings: [], marketing_assets: [], distribution_finals: [], notifications: [],
      content_topic_bank: [{ id: TOPIC, brokerage_id: B1, topic_title: "Community moment: Riverbend Fall Festival", categories: ["neighborhood", "local_intel"], status: "fresh", expires_at: day(6), raw_data: {} }],
    }, { uuidIds: true })
    const brand = async () => ({ tagline: "Calm advice, local roots" })
    const input = { brokerageId: B1, actorUserId: U1, videoProjectId: VID, topicId: TOPIC }
    const idea = (status: string) => ({ id: "i1", brokerage_id: B1, item_type: "local_campaign_idea", item_id: TOPIC, status, reviewed_by: status === "approved" ? U1 : null, reviewed_at: status === "approved" ? day(-1) : null })
    const pendingDb = seed([idea("pending")])
    const p1 = await publishCommunityVideo(input, { client: pendingDb as never, brand, now: NOW })
    check("a topic whose campaign idea is still PENDING does not publish — nothing queued, nothing stamped", !p1.ok && /not approved/.test(p1.reason) && pendingDb.tables.social_posts.length === 0 && !pendingDb.tables.ai_video_projects[0].video_metadata?.community)
    const p2 = await publishCommunityVideo(input, { client: seed([idea("approved")], vid(), []) as never, brand, now: NOW })
    check("an approved topic with a video NOT made from it does not publish", !p2.ok && /not made from this topic/.test(p2.reason))
    const p3 = await publishCommunityVideo(input, { client: seed([idea("approved")], vid({ approval_status: "pending_review" })) as never, brand, now: NOW })
    check("a video a person has not approved does not publish", !p3.ok && /not an approved public marketing video/.test(p3.reason))
    const db = seed([idea("approved")])
    const ok = await publishCommunityVideo(input, { client: db as never, brand, now: NOW })
    const postRow = db.tables.social_posts[0]
    check("ALL HELD → it rides THE survivor (one YouTube post, approved + scheduled) and the video carries the evidence (topic, who approved it, the door)", ok.ok && db.tables.social_posts.length === 1 && postRow.platform === "youtube" && db.tables.ai_video_projects[0].video_metadata?.community?.topic_id === TOPIC && db.tables.ai_video_projects[0].video_metadata?.community?.topic_approved_by === U1 && db.tables.ai_video_projects[0].video_metadata?.community?.door === "community_video_publish", JSON.stringify(ok))
    check("…the post's PUBLIC WORDS passed the final phase: the stock opener gone, the date kept, the tagline signed — recorded as the version the video's approval covers", !/fast-paced/.test(postRow.content) && /Nov 1/.test(postRow.content) && /— Calm advice, local roots$/.test(postRow.content) && db.tables.distribution_finals.some((f) => f.asset_table === "social_posts" && f.asset_id === postRow.id && f.status === "approved" && f.approval_basis === "derived_from_approved_asset"), postRow?.content)
    const rec = await recordYouTubePublishOnAsset(db, { id: postRow.id, brokerage_id: B1, platform: "youtube", external_post_id: "yt_fest1", media_urls: ["https://cdn/fest.mp4"], post_brief: postRow.post_brief, published_at: day(0) })
    const sent = db.tables.distribution_finals.find((f) => f.asset_table === "social_posts" && f.asset_id === postRow.id)
    check("…and when the post goes out the write-back records THAT version as published (YouTube, the provider id, the sent hash)", rec.ok && sent?.status === "published" && sent.published_via === "youtube" && sent.published_ref === "yt_fest1" && sent.published_sha256 === sha256(postRow.content))
  }

  // ═══════════════════ F · ruling 19 — a book is its own entity ═══════════════════
  section("F · ruling 19 — a book is not a lead magnet; a lead magnet may only DISTRIBUTE one")
  {
    const m867 = raw("supabase/migrations/m867-book-projects-a-book-is-not-a-lead-magnet.sql")
    const line1 = m867.split("\n")[0]
    const checkList = (name: string) => (new RegExp(`${name}\\s+CHECK\\s*\\(\\s*\\w+\\s+IN\\s*\\(([^)]*)\\)`, "i").exec(m867)?.[1] ?? "").split(",").map((v) => v.trim().replace(/^'|'$/g, "")).filter(Boolean)
    check("m867 line 1 is the lane stamp or the applied stamp (the RULE, not the waypoint)", /^-- WRITTEN, NOT APPLIED \(wave 145, lane 145G\)/.test(line1) || /^-- ── APPLIED LIVE /.test(line1))
    check("book_projects' CHECKs equal the code's vocabularies: stage = BOOK_STAGES, context = BOOK_PUBLICATION_CONTEXTS, owner = BOOK_OWNER_SCOPES (derived, never pinned)",
      checkList("book_projects_stage_check").join() === BOOK_STAGES.join() && checkList("book_projects_publication_context_check").join() === BOOK_PUBLICATION_CONTEXTS.join() && checkList("book_projects_owner_scope_check").join() === BOOK_OWNER_SCOPES.join(),
      JSON.stringify({ s: checkList("book_projects_stage_check"), c: checkList("book_projects_publication_context_check"), o: checkList("book_projects_owner_scope_check") }))
    const BH = "00000000-0000-4000-8000-0000000000c1", AGH = "00000000-0000-4000-8000-0000000000d9", US = "00000000-0000-4000-8000-0000000000a9"
    const w = () => { const db = memSupabase({ brokerages: [{ id: B1, is_demo: false }, { id: BH, is_demo: true }], agents: [{ id: AG1, user_id: U1, brokerage_id: B1 }, { id: AGH, user_id: US, brokerage_id: BH }], lead_capture_forms: [], book_projects: [], agent_action_ledger: [], lifecycle_events: [] }, { uuidIds: true, stampCreatedAt: true }); (db as unknown as { rpc: unknown }).rpc = async () => ({ data: null, error: null }); return db }
    const allow = async () => ({ allowed: true, reason: "ok" })
    const db = w()
    const lm = await startBookProject({ brokerageId: B1, agentId: AG1, createdBy: U1, concept: "A seller's book on pricing a fixer-upper in Tampa Bay", audience: "seller" }, { client: db as never, entitlement: allow, now: NOW })
    const kdp = await startBookProject({ brokerageId: B1, agentId: AG1, createdBy: U1, concept: "A seller's book on staging a waterfront condo in Clearwater", audience: "seller", context: "tenant_kdp" }, { client: db as never, entitlement: allow, now: NOW })
    const team = await startBookProject({ brokerageId: B1, agentId: AG1, createdBy: U1, concept: "A buyer's book on new construction in Wesley Chapel for our team", audience: "buyer", teamId: "team-1", teamOwned: true, distributeAsLeadMagnet: false }, { client: db as never, entitlement: allow, now: NOW })
    const house = await startBookProject({ brokerageId: BH, agentId: AGH, createdBy: US, concept: "An agent's field guide to AI-assisted listing launches in Florida", audience: "seller" }, { client: db as never, entitlement: allow, now: NOW })
    const book = (id?: string) => db.tables.book_projects.find((b) => b.id === id)
    check("a LEAD-MAGNET book: its own row + a DRAFT capture form that only POINTS at it (settings.book_id; no manuscript on the form)", lm.success && !!book(lm.bookId) && book(lm.bookId)?.distribution_form_id === lm.magnetId && db.tables.lead_capture_forms.find((f) => f.id === lm.magnetId)?.settings?.book_id === lm.bookId && !("book" in (db.tables.lead_capture_forms.find((f) => f.id === lm.magnetId)?.settings ?? {})))
    check("a TENANT KDP book is a book with NO capture form (a book is not a lead magnet)", kdp.success && !!book(kdp.bookId) && !kdp.magnetId && book(kdp.bookId)?.distribution_form_id === null && book(kdp.bookId)?.publication_context === "tenant_kdp")
    check("OWNERSHIP: an agent's book is the agent's; a book made for the team is the team's; the house tenant's is the PLATFORM's", book(lm.bookId)?.owner_scope === "agent" && book(team.bookId)?.owner_scope === "team" && book(team.bookId)?.team_id === "team-1" && book(house.bookId)?.owner_scope === "platform")
    check("the lead-magnet vocabulary has no 'book' type (a book is never a kind of lead magnet)", !/["']book["']/.test((/magnetType:\s*([^\n]+)/.exec(code("lib/kernel/lead-magnets.ts"))?.[1]) ?? "x"))
    const none = await loadDistributedBook(db as never, B1, "some-form", {})
    const dangling = await loadDistributedBook(db as never, B1, "some-form", { book_id: "99999999-9999-4999-8999-999999999999" })
    const stolen = await loadDistributedBook(db as never, B1, "another-form", { book_id: lm.bookId })
    check("loadDistributedBook: an ordinary lead magnet is no book (no read); a pointer to a missing book or to ANOTHER form's book is an error (fail closed)", none.book === null && none.error === null && !!dangling.error && !!stolen.error && /another lead magnet/.test(stolen.error ?? ""))
    const pubDb = memSupabase({ lead_capture_forms: [{ id: "f-1", brokerage_id: B1, slug: "x", agent_id: AG1, settings: { book_id: "99999999-9999-4999-8999-999999999999" }, is_active: false, name: "x", landing_content: {} }], book_projects: [], agent_action_ledger: [] }, { uuidIds: true })
    const refusedPublish = await publishLeadMagnet({ magnetId: "f-1", brokerageId: B1, channels: ["landing_page"], actorUserId: U1, baseUrl: "https://app.example.com" }, { client: pubDb as never })
    check("the lead-magnet PUBLISH fails closed when the book it distributes cannot be read — the page stays a draft", !refusedPublish.success && /could not be read/.test(refusedPublish.error ?? "") && pubDb.tables.lead_capture_forms[0].is_active === false, JSON.stringify(refusedPublish))

    // C4 AT THE LEAD-MAGNET DOOR: the publish (the human approval) proves the page going live against the final the AI draft staged.
    const page = (id: string, subhead: string) => ({ id, brokerage_id: B1, slug: `s-${id}`, agent_id: AG1, settings: {}, is_active: false, name: "Spring seller guide", thank_you_message: "Thanks — it is on its way.", landing_content: { headline: "Sell in spring, calmly", subhead, cta: "Send it", bullets: ["Timing", "Pricing"], faq: [] } })
    const doorDb = memSupabase({ lead_capture_forms: [page("f-2", "Prices in 33602 rose 4.2% this year. Equal Housing Opportunity."), page("f-3", "Prices in 33602 rose 4.2% this year.")], book_projects: [], agent_action_ledger: [], distribution_finals: [], notifications: [] }, { uuidIds: true, stampCreatedAt: true })
    const staged2 = leadMagnetPublicText(doorDb.tables.lead_capture_forms[0])
    const staged3 = leadMagnetPublicText({ ...doorDb.tables.lead_capture_forms[1], landing_content: { ...doorDb.tables.lead_capture_forms[1].landing_content, subhead: "Prices in 33602 rose 4.2% this year. Equal Housing Opportunity." } })
    for (const [id, text] of [["f-2", staged2], ["f-3", staged3]] as const) {
      const fin = await finalizeForDistribution({ assetKind: "lead_magnet", text, tenantBrand: null })
      await stageDistributionFinal(doorDb, { brokerageId: B1, assetTable: "lead_capture_forms", assetId: id, final: fin, createdBy: U1, notifyUserId: U1, storedAs: text, now: NOW })
    }
    const pub2 = await publishLeadMagnet({ magnetId: "f-2", brokerageId: B1, channels: ["landing_page"], actorUserId: U1, baseUrl: "https://app.example.com" }, { client: doorDb as never })
    const rec2 = doorDb.tables.distribution_finals.find((r) => r.asset_id === "f-2")
    check("the PUBLISH of an unedited AI draft records THAT version as what went live (published via the page, by the approver, the sent hash = the page's public words)",
      pub2.success && rec2?.status === "published" && rec2.published_via === "lead_magnet_page" && rec2.approved_by === U1 && rec2.published_sha256 === sha256(staged2) && rec2.approval_basis === "asset_approval", JSON.stringify({ pub2, rec2 }))
    const pub3 = await publishLeadMagnet({ magnetId: "f-3", brokerageId: B1, channels: ["landing_page"], actorUserId: U1, baseUrl: "https://app.example.com" }, { client: doorDb as never })
    check("…and REFUSES a reviewer's edit that dropped a disclosure the final carried — the page stays a draft (fail closed)",
      !pub3.success && /required disclosure is missing/.test(pub3.error ?? "") && doorDb.tables.lead_capture_forms.find((f) => f.id === "f-3")?.is_active === false, JSON.stringify(pub3))
    const runtime = [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "app"))].filter((f) => /\.(ts|tsx)$/.test(f))
    const readers = runtime.filter((f) => /settings\??\.book\b(?!_)|\.book_publishing\b|settings\.book_publishing/.test(blankStrings(stripComments(readFileSync(f, "utf8")))))
    check("NO RUNTIME READER of the manuscript on a capture form remains (settings.book / book_publishing) — positive control: the census catches a planted reader", readers.length === 0 && /settings\??\.book\b(?!_)/.test("const b = form.settings.book"), readers.join(", "))
  }

  // ═══════════════════ G · migrations + wiring ═══════════════════
  const LANE_OR_APPLIED: readonly RegExp[] = [/^-- ── APPLIED LIVE /, new RegExp("^-- " + "WRITTEN, NOT APPLIED \\(wave 145, lane 145G\\)")]
  section("G · m866 vocabularies equal the code's; every owned door runs the final phase")
  {
    const m866 = raw("supabase/migrations/m866-distribution-finals-humanized-final-versions.sql")
    const list = (name: string) => (new RegExp(`${name}\\s+CHECK\\s*\\(\\s*(?:\\w+ IS NULL OR )?\\w+\\s+IN\\s*\\(([^)]*)\\)`, "i").exec(m866)?.[1] ?? "").split(",").map((v) => v.trim().replace(/^'|'$/g, "")).filter(Boolean)
    // (wave 145, lane 145Z) the stamp patterns live in LANE_OR_APPLIED below the label, so this proof's own source no longer
    // reads to scripts/migration-claim-guard.ts as a prose claim that m866 is un-applied (it IS applied — the false positive
    // that guard measured on the integrated tree).
    check("m866 line 1 is the lane stamp or the applied stamp (the rule, not the waypoint)", LANE_OR_APPLIED.some((re) => re.test(m866.split("\n")[0])))
    check("distribution_finals' CHECKs equal the code: asset_kind = HUMANIZE_ASSET_KINDS, status = DISTRIBUTION_FINAL_STATUSES, approval_basis = DISTRIBUTION_APPROVAL_BASES",
      list("distribution_finals_asset_kind_check").join() === HUMANIZE_ASSET_KINDS.join() && list("distribution_finals_status_check").join() === DISTRIBUTION_FINAL_STATUSES.join() && list("distribution_finals_approval_basis_check").join() === DISTRIBUTION_APPROVAL_BASES.join(),
      JSON.stringify({ k: list("distribution_finals_asset_kind_check"), s: list("distribution_finals_status_check"), b: list("distribution_finals_approval_basis_check") }))
    const union = [...code("lib/content-intel/performance-aggregator.ts").matchAll(/^\s*\|\s*"([a-z_]+)"/gm)].map((m) => m[1])
    const widened = (/content_topic_uses_asset_type_check\s+CHECK\s*\(asset_type IN \(([^)]*)\)/.exec(m866)?.[1] ?? "").split(",").map((v) => v.trim().replace(/^'|'$/g, "")).filter(Boolean)
    check("content_topic_uses.asset_type (m866) admits every asset type the code writes — incl. ctv_ad (derived from the AssetType union)", union.length >= 9 && union.every((t) => widened.includes(t)) && widened.includes("ctv_ad"), JSON.stringify({ union, widened }))
    const cc = code("lib/kernel/content-creators.ts")
    check("content-creators: the AI blog, the AI newsletter (author + creator), the podcast script and episode run the final phase and record the version",
      /assetKind: "blog_post", html: draft\.content/.test(cc) && /recordFinal\(supabase, ctx, \{ assetTable: "blog_posts"/.test(cc) && /finalPhase\(supabase, ctx, \{ assetKind: "newsletter", html: flatContent \}\)/.test(cc) && /recordFinal\(supabase, ctx, \{ assetTable: "newsletter_campaigns"/.test(cc) && /finalPhase\(supabase, ctx, \{ assetKind: "podcast_script", text: script \}\)/.test(cc) && /recordFinal\(supabase, ctx, \{ assetTable: "podcast_episodes"/.test(cc))
    const draft = code("lib/lead-magnets/ai-draft.ts"), yt = code("lib/video/youtube-publish.ts")
    check("the lead-magnet AI draft and the YouTube rail (queue + write-back) run the final phase / record what went out", /finalizeForDistribution\(\{ assetKind: "lead_magnet"/.test(draft) && /stageDistributionFinal\(client/.test(draft) && /finalizeForDistribution\(\{ assetKind: "video_description"/.test(yt) && /stageDistributionFinal\(svc/.test(yt) && /recordDistributionPublication\(svc/.test(yt))
    const kernelLm = blankStrings(code("lib/kernel/lead-magnets.ts"))
    check("the lead-magnet PUBLISH door checks the version BEFORE activation and records it AFTER, over the ONE page-text composition (leadMagnetPublicText)",
      /leadMagnetPublicText\(pageRow/.test(kernelLm) && kernelLm.indexOf("checkDistributionPublication(") > 0 && kernelLm.indexOf("checkDistributionPublication(") < kernelLm.indexOf("withActionLedger<") && kernelLm.indexOf("recordDistributionPublication(") > kernelLm.indexOf("if (!activation.ok)"))
    // WAVE 145 (lane 145Z — lane G Outside-lane items): the four publication doors OUTSIDE lane G record the version that
    // went out through recordDoorPublication; the ad creator stages its creative's final; the Coming Soon copy and the
    // direct-mail draft run the final phase. Census over comment-stripped source, with positive controls.
    const DOORS: Array<[string, string, string]> = [
      ["app/api/cron/publish-social-posts/route.ts", "social_post", "social_posts"],
      ["app/api/cron/publish-newsletters/route.ts", "newsletter", "newsletter_campaigns"],
      ["app/actions/blog.ts", "blog_post", "blog_posts"],
      ["app/api/cron/distribute-podcast-episodes/route.ts", "podcast_script", "podcast_episodes"],
    ]
    const doorRecords = (src: string, kind: string, table: string) =>
      /\brecordDoorPublication\s*\(/.test(src) && new RegExp(`assetKind:\\s*"${kind}",\\s*assetTable:\\s*"${table}"`).test(src)
    const unrecorded = DOORS.filter(([f, k, t]) => !doorRecords(code(f), k, t)).map(([f]) => f)
    const kindsKnown = DOORS.every(([, k]) => (HUMANIZE_ASSET_KINDS as readonly string[]).includes(k))
    const ctlLive = 'await recordDoorPublication(svc, { brokerageId: b, assetKind: "blog_post", assetTable: "blog_posts" })'
    check("the social publish cron, the newsletter send, the blog publish and the podcast distributor each RECORD the version that went out (recordDoorPublication, naming a HUMANIZE_ASSET_KINDS kind and their asset table) — controls: the live shape is counted, the same call inside a comment is not",
      unrecorded.length === 0 && kindsKnown && doorRecords(ctlLive, "blog_post", "blog_posts") && !doorRecords(stripComments(`// ${ctlLive}`), "blog_post", "blog_posts"), unrecorded.join(", "))
    {
      const { recordDoorPublication } = await import("../lib/marketing/humanize-final")
      const db = memSupabase({ distribution_finals: [], notifications: [] }, { uuidIds: true })
      const AID = "22222222-2222-4222-8222-222222222222"
      const rec = await recordDoorPublication(db as never, { brokerageId: B1, assetKind: "newsletter", assetTable: "newsletter_campaigns", assetId: AID, content: "October market letter.", approvedBy: null, approvedAt: null, via: "newsletter_send", ref: null, now: NOW })
      const row = db.tables.distribution_finals.find((r) => r.asset_id === AID)
      const empty = await recordDoorPublication(db as never, { brokerageId: B1, assetKind: "newsletter", assetTable: "newsletter_campaigns", assetId: AID, content: "  ", approvedBy: null, approvedAt: null, via: "newsletter_send", ref: null, now: NOW })
      check("recordDoorPublication records the sent text as a PUBLISHED version under the caller's tenant (through recordDistributionPublication) and refuses an empty send rather than record nothing as something",
        rec.ok && row?.status === "published" && row.brokerage_id === B1 && row.published_via === "newsletter_send" && !empty.ok, JSON.stringify({ rec, status: row?.status, via: row?.published_via, empty }))
    }
    {
      // THE RECORD IS READ (lane 145Z — test:readerless-writes: final_text, tagline, logo_url, notified_*, approved_*, acknowledged
      // were written by the doors and read by nothing). listDistributionFinals is the reader; the Content Approvals screen shows it.
      const { listDistributionFinals, recordDoorPublication } = await import("../lib/marketing/humanize-final")
      const db = memSupabase({ distribution_finals: [], notifications: [] }, { uuidIds: true })
      const AID = "33333333-3333-4333-8333-333333333333"
      const f = await finalizeForDistribution({ assetKind: "blog_post", text: "Riverbend spring market notes for sellers.", tenantBrand: null })
      await stageDistributionFinal(db as never, { brokerageId: B1, assetTable: "blog_posts", assetId: AID, final: f, createdBy: U1, notifyUserId: U1, now: NOW })
      await recordDoorPublication(db as never, { brokerageId: B1, assetKind: "blog_post", assetTable: "blog_posts", assetId: AID, content: f.text, approvedBy: U1, approvedAt: NOW.toISOString(), via: "wordpress", ref: "wp-9", now: NOW })
      const mine = await listDistributionFinals(db as never, { brokerageId: B1 })
      const theirs = await listDistributionFinals(db as never, { brokerageId: B2 })
      const refused = await listDistributionFinals(memSupabase({}, { refuse: { distribution_finals: "RLS refused" } }) as never, { brokerageId: B1 })
      const rec = mine.ok ? mine.finals.find((x) => x.assetId === AID) : undefined
      check("THE RECORD IS READ: the version that went out comes back with its exact text, who was told and when, who approved it and what went out where — tenant-pinned (another brokerage reads none) and a refused read is an ERROR, never an empty record",
        !!rec && rec.finalText === f.text && rec.notifiedUserId === U1 && !!rec.notifiedAt && rec.approvedBy === U1 && rec.status === "published" && rec.publishedVia === "wordpress" && rec.publishedRef === "wp-9"
        && theirs.ok && theirs.finals.length === 0 && !refused.ok, JSON.stringify({ rec, theirs, refused }))
      const act = raw("app/actions/content-final-versions.ts"), actCode = stripComments(act)
      const panel = code("app/dashboard/content/approvals/final-versions-panel.tsx"), page = code("app/dashboard/content/approvals/page.tsx")
      check("…its door: 'use server', one async export, the tenant from getAgentContext, the seat checked BEFORE the read, the SESSION client (m866's tenant-read policy); and the Content Approvals page mounts it",
        /^"use server"/.test(act) && (actCode.match(/^export\s+async\s+function\s+\w+/gm) ?? []).length === 1 && !/^export\s+(?!async)/m.test(actCode)
        && actCode.indexOf("TENANT_ADMIN_USER_TYPES.has(") > 0 && actCode.indexOf("TENANT_ADMIN_USER_TYPES.has(") < actCode.indexOf("listDistributionFinals(") && /createClient\(\)/.test(actCode) && !/createServiceClient/.test(actCode)
        && /getDistributionFinalsAction\(/.test(panel) && /<FinalVersionsPanel \/>/.test(page))
    }
    const adc = code("lib/ads/ad-creator.ts"), dm = code("lib/direct-mail/draft-copy.ts"), csc = code("app/actions/coming-soon-content.ts")
    check("the ad creator stages its creative's final against ad_creative_variations; the direct-mail draft finalizes the postcard AND letter bodies; the Coming Soon copy runs the listing_creative final phase",
      /finalizeForDistribution\(\{\s*assetKind:\s*"ad_creative"/.test(adc) && /stageDistributionFinal\(/.test(adc) && /assetTable:\s*"ad_creative_variations"/.test(adc)
      && (dm.match(/await finalizeMailText\(/g) ?? []).length >= 2 && /finalizeForDistribution\(\{\s*assetKind:\s*"listing_creative"/.test(csc))
    const promoter = blankStrings(code("lib/competitive-intel/promote-to-topic-bank.ts"))
    const copies = (src: string) => /topic_title:\s*\(?\s*ad\.ad_(?:headline|copy)|value_angle:\s*\(?\s*ad\.ad_copy|const title\s*=\s*\(?\s*ad\.ad_(?:headline|copy)|const valueAngle\s*=\s*\(?\s*ad\.ad_copy/.test(src)
    check("the COMPETITOR-AD promoter files the THEME (competitorAdTheme), never the rival's headline / copy — positive control: the old verbatim shape is detected",
      /competitorAdTheme\(ad\.ad_headline, ad\.ad_copy\)/.test(promoter) && !copies(promoter) && copies(`const title =\n      (ad.ad_headline ?? ad.ad_copy ?? "")`))
    const actions = raw("app/dashboard/marketing/content-intel/topic-actions.ts")
    const exportsList = [...stripComments(actions).matchAll(/^export\s+(\w+(?:\s+\w+)?)\s+(\w+)/gm)]
    check("the topic bank's session doors: 'use server', EVERY export an async function, tenant from getAgentContext, no brokerageId parameter",
      /^"use server"/.test(actions) && exportsList.length === 3 && exportsList.every((m) => m[1] === "async function") && (stripComments(actions).match(/getAgentContext\(\)/g) ?? []).length === 3 && !/brokerageId\s*:\s*string/.test(stripComments(actions).split("export async function")[1] ?? ""))
  }

  console.log("\n──────────────────────────────────────────────────")
  console.log(` Denominators: ${HUMANIZE_ASSET_KINDS.length} asset kinds; ${TOPIC_SOURCE_CLASSES.length} topic source classes; 4 approval states; 2 migrations`)
  console.log(" Blind spots:")
  for (const b of [
    ...blind,
    "the tell list is short on purpose (phrases readers notice); prose that reads machine-made without a listed phrase passes — the human approval is the real review, the phase only removes the safe ones and points at the rest",
    "superlatives follow the Director's list (lib/video/director-eval-harness.ts); 'top' in 'top 5 tips' is flagged too — the human resolves or grounds it; the approving human's acceptance is recorded at the door (acknowledged)",
    "the publication doors OUTSIDE this lane: wired by lane 145Z (wave 145) — the social publish cron, the newsletter send, the blog publish and the podcast distributor record what went out through recordDoorPublication (→ recordDistributionPublication), the ad creator stages its creative's final, and the listing-creative (Coming Soon AI copy) and direct-mail drafting run the final phase; the direct-mail piece and the launched ad have no per-send record against a final yet (the mail orchestrator has no asset row; the ad launch is lane 145D's launch-assembler)",
    "topic intelligence reads this OS's own tables only (no provider call): an empty competitor watchlist, inbox, monitor or market table yields a published blind spot, not a topic; the pass runs inside the local-intelligence sweep, so a tenant with no active territory gets none yet",
    "engagement for competitor posts is the search provider's RANKING PROXY until a platform-authorised count exists (said on every row); viral = relative to the competitor's own median, never an absolute claim",
    "the C5 gateway itself (lib/ads/ctv-campaign.ts) is lane 145D's; this proof drives the lane with the gateway as a seam",
    "distribution_finals and book_projects are APPLIED LIVE since 2026-10-27 (m866/m867 headers stamped by the integrator); on a database without them a live insert is refused (42P01) — the creators then stage the piece WITHOUT a recorded final and say so (no ready-notification either), the TV lane refuses (closed), and starting a book is refused",
  ]) console.log(`   · ${b}`)
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(`\n✗ CONTENT_DISTRIBUTION_FAIL\n${failures.map((f) => `  - ${f}`).join("\n")}`); process.exit(1) }
  console.log("✅ CONTENT_DISTRIBUTION_PASS")
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

main().catch((e) => { console.error(e); process.exit(1) })
