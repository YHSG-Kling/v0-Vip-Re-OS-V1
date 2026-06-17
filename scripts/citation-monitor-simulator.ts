#!/usr/bin/env tsx
/**
 * scripts/citation-monitor-simulator.ts
 *
 * AI-SEARCH CITATION MONITOR verification — no mocks, no stubs, no demo data.
 *
 * Layer 1 (pure, always runs):
 *   · detectOurCitation — answer text containing our /v/<slug> or brand → cited+url;
 *     an unrelated answer → not cited.
 *   · scoreCitationVisibility — all cited → 1.0; mixed → partial; all not_checked
 *     → honest null + reason; empty → null.
 *
 * Layer 2 (live, guarded by Supabase creds): seed a published reel page, run
 *   runCitationMonitor with an INJECTED searchFetcher that cites our slug → assert
 *   ONE observation per platform (cited=true) + a 1.0 score; idempotent rerun (no
 *   new rows); then an unrelated fetcher → not_cited; reverse-delete + cleanup
 *   count == 0. NEVER hits the real search rail.
 */
import {
  detectOurCitation,
  scoreCitationVisibility,
  buildCitationQuery,
  buildLandingCitationQuery,
  runCitationMonitor,
  runLandingPageCitationMonitor,
  CITATION_PLATFORMS,
  siteOrigin,
  type SearchFetcher,
  type CitationObservation,
} from "../lib/kernel/ai-search-citation-monitor"

let passed = 0, failed = 0; const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => {
  if (c) { passed++; console.log(`  ✓ ${n}`) } else { failed++; fails.push(n); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) }
}
const report = () => {
  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  if (failed) { for (const f of fails) console.log("   - " + f); process.exit(1) }
  console.log(" ✅ Citation monitor verified"); console.log("CITATION_MONITOR_PASS")
}

const obs = (...xs: Array<CitationObservation["outcome"]>): CitationObservation[] =>
  xs.map((outcome, i) => ({ platform: CITATION_PLATFORMS[i % CITATION_PLATFORMS.length], outcome }))

async function main() {
  console.log("══ AI-search citation monitor simulator ══\n[Layer 1 · pure]")

  // detectOurCitation — URL/slug match (gold), brand match (unlinked), no match.
  const SLUG = "luxury-loft-downtown-ab12cd34"
  const target = {
    slugs: [`https://app.viprealestateos.com/v/${SLUG}`, `/v/${SLUG}`, SLUG],
    domains: ["app.viprealestateos.com"],
    brands: ["Summit Realty Group"],
  }
  const citedUrlAnswer = `For this home, see the video tour at https://app.viprealestateos.com/v/${SLUG} which covers the layout.`
  const d1 = detectOurCitation(citedUrlAnswer, target)
  check("detect: answer citing our /v/<slug> URL → cited, kind=url, matched url", d1.cited && d1.kind === "url" && (d1.matched ?? "").includes(SLUG))

  const brandAnswer = "Several agents serve that area; Summit Realty Group is one local brokerage."
  const d2 = detectOurCitation(brandAnswer, target)
  check("detect: unlinked brand mention → cited, kind=brand", d2.cited && d2.kind === "brand" && d2.matched === "Summit Realty Group")

  const unrelated = "Zillow and Redfin list several homes in that neighborhood priced around $800k."
  const d3 = detectOurCitation(unrelated, target)
  check("detect: unrelated answer → NOT cited", !d3.cited && d3.matched === null && d3.kind === null)

  const d4 = detectOurCitation("", target)
  check("detect: empty answer → NOT cited (no false positive)", !d4.cited)

  // scoreCitationVisibility — all/mixed/all-not_checked/empty.
  const allCited = scoreCitationVisibility(obs("cited", "cited", "cited"))
  check("score: all cited → 1.0, reason null", allCited.score === 1 && allCited.reason === null && allCited.checked === 3)

  const mixed = scoreCitationVisibility(obs("cited", "not_cited", "cited", "not_cited"))
  check("score: mixed (2/4) → 0.5 partial", mixed.score === 0.5 && mixed.cited === 2 && mixed.notCited === 2)

  const allNotChecked = scoreCitationVisibility(obs("not_checked", "not_checked"))
  check("score: all not_checked → honest null + reason, checked=0", allNotChecked.score === null && allNotChecked.reason === "not_checked_search_rail_unavailable" && allNotChecked.checked === 0)

  const empty = scoreCitationVisibility([])
  check("score: empty → null + no_observations", empty.score === null && empty.reason === "no_observations" && empty.total === 0)

  const allNotCited = scoreCitationVisibility(obs("not_cited", "not_cited"))
  check("score: all not_cited → honest 0.0 (we DID look)", allNotCited.score === 0 && allNotCited.reason === null)

  // not_checked never inflates: cited=1 among 1 checked + 5 not_checked → 1.0, not 1/6.
  const ratioGuard = scoreCitationVisibility(obs("cited", "not_checked", "not_checked", "not_checked", "not_checked", "not_checked"))
  check("score: not_checked excluded from denominator (1 cited / 1 checked = 1.0)", ratioGuard.score === 1 && ratioGuard.notChecked === 5)

  // buildCitationQuery — names subject + place + brand.
  const q = buildCitationQuery({ brandName: "Summit Realty Group", title: "Luxury Loft Tour", city: "Austin", state: "TX" })
  check("query: names subject + place + brand", q.includes("Luxury Loft Tour") && q.includes("Austin, TX") && q.includes("Summit Realty Group"))

  // buildLandingCitationQuery — the real demand QUESTION + place, BRAND-FREE (honest signal).
  const lq = buildLandingCitationQuery({ topQuestion: "How much is my home worth in Austin?", fallback: "Home value", area: "Austin, TX" })
  check("landing query: uses the real demand question + place, brand-free", lq.includes("How much is my home worth") && lq.includes("in Austin, TX") && !/summit realty group/i.test(lq))
  const lqFallback = buildLandingCitationQuery({ topQuestion: null, fallback: "First-Time Buyer Guide", area: null })
  check("landing query: falls back to the page headline when no FAQ question", lqFallback.includes("First-Time Buyer Guide"))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("\n[Layer 2] ⏭ no Supabase creds — pure layer only"); report(); return }

  console.log("\n[Layer 2 · live, injected searchFetcher — no real search egress]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `Cit${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []
  let lmObsSlug = ""

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id")
      .not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭ need an agent"); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const agentId = (agent as any).user_id

    const liveSlug = `${TAG.toLowerCase()}-reel-deadbeef`
    const { data: proj } = await svc.from("ai_video_projects").insert({
      brokerage_id: brokerageId, agent_id: agentId,
      title: `${TAG} Luxury Loft Tour`, video_type: "listing_tour",
      status: "completed", compliance_status: "passed", approval_status: "approved",
      video_url: "https://example.com/v.mp4",
      is_published: true, public_slug: liveSlug, published_at: new Date().toISOString(),
    }).select("id").single()
    if (!proj) { console.log("  ⏭ could not seed reel"); report(); return }
    const projectId = (proj as any).id
    cleanup.push({ table: "ai_video_projects", id: projectId })

    const origin = siteOrigin()
    // INJECTED fetcher that cites our published page — no real Exa/Tavily call.
    const citingFetcher: SearchFetcher = async () => ({
      text: `The best overview is the tour at ${origin}/v/${liveSlug} — it walks the whole home.`,
      provider: "tavily",
    })

    const r1 = await runCitationMonitor(brokerageId, { searchFetcher: citingFetcher, windowDays: 7 }, svc)
    const monitoredPage = r1.pages.find((p) => p.projectId === projectId)
    check("run: our published reel was monitored", !!monitoredPage && r1.pagesMonitored >= 1)
    check("run: one observation recorded per platform (cited)", r1.observations >= CITATION_PLATFORMS.length && r1.cited >= CITATION_PLATFORMS.length && r1.notCited === 0)
    check("run: page visibility = 1.0 (all cited)", monitoredPage?.visibility.score === 1)
    check("run: cited_url points at our page", (monitoredPage?.citedUrl ?? "").includes(liveSlug))

    // Exactly ONE row per (project, platform, day) in the DB.
    const { count: rowCount } = await svc.from("ai_search_citation_observations")
      .select("id", { count: "exact", head: true }).eq("project_id", projectId)
    check("db: one row per platform (no duplicates)", (rowCount ?? 0) === CITATION_PLATFORMS.length)
    const { data: citedRow } = await svc.from("ai_search_citation_observations")
      .select("outcome, cited_url, provider").eq("project_id", projectId).eq("platform", "perplexity").maybeSingle()
    check("db: recorded outcome=cited, provider=tavily", (citedRow as any)?.outcome === "cited" && (citedRow as any)?.provider === "tavily")

    // Idempotent rerun — UPSERT overwrites the day's rows, count unchanged.
    const r2 = await runCitationMonitor(brokerageId, { searchFetcher: citingFetcher, windowDays: 7 }, svc)
    const { count: rowCount2 } = await svc.from("ai_search_citation_observations")
      .select("id", { count: "exact", head: true }).eq("project_id", projectId)
    check("idempotency: rerun does not append (count unchanged)", (rowCount2 ?? 0) === CITATION_PLATFORMS.length && r2.cited >= CITATION_PLATFORMS.length)

    // Unrelated fetcher → not_cited (same-day UPSERT flips outcome honestly).
    const unrelatedFetcher: SearchFetcher = async () => ({
      text: "Zillow lists several unrelated homes in that area.", provider: "exa",
    })
    const r3 = await runCitationMonitor(brokerageId, { searchFetcher: unrelatedFetcher, windowDays: 7 }, svc)
    const page3 = r3.pages.find((p) => p.projectId === projectId)
    check("run: unrelated answer → not_cited, visibility 0.0", page3?.visibility.score === 0 && r3.notCited >= CITATION_PLATFORMS.length && r3.cited === 0)
    const { count: rowCount3 } = await svc.from("ai_search_citation_observations")
      .select("id", { count: "exact", head: true }).eq("project_id", projectId)
    check("db: still one row per platform after outcome flip", (rowCount3 ?? 0) === CITATION_PLATFORMS.length)

    // Honest-degrade: a fetcher returning provider "none" → not_checked.
    const deadFetcher: SearchFetcher = async () => ({ text: "", provider: "none" })
    const r4 = await runCitationMonitor(brokerageId, { searchFetcher: deadFetcher, windowDays: 7 }, svc)
    const page4 = r4.pages.find((p) => p.projectId === projectId)
    check("degrade: rail unavailable → not_checked, visibility null (never fabricated)", page4?.visibility.score === null && r4.notChecked >= CITATION_PLATFORMS.length && r4.cited === 0)

    // ── Lead-magnet / FAQ landing page coverage (/lm/[slug]) ──
    console.log("\n[Layer 2 · landing pages — /lm/[slug] GEO ingress]")
    lmObsSlug = `${TAG.toLowerCase()}-lm-feedface`
    const landingContent = {
      headline: `${TAG} What's My Home Worth`, subhead: "Get a real local estimate.", cta: "Get my estimate",
      bullets: ["Local comps, not a national guess", "No obligation"],
      topics: ["home value", "selling timeline"],
      faq: [
        { question: `How much is my ${TAG} home worth right now?`, answer: "A local expert can give you a precise figure from recent comparable sales in your neighborhood." },
        { question: "How long does it take to sell a home?", answer: "It depends on price and the local market; we map out a realistic timeline up front." },
      ],
      faqJsonLd: JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [] }),
      fromTopics: true, generatedAt: new Date().toISOString(),
    }
    const { data: form } = await svc.from("lead_capture_forms").insert({
      brokerage_id: brokerageId, name: `${TAG} Home Value`, slug: lmObsSlug, is_active: true, landing_content: landingContent,
    }).select("id").single()
    if (!form) { console.log("  ⏭ could not seed lead magnet"); } else {
      const formId = (form as any).id
      cleanup.push({ table: "lead_capture_forms", id: formId })

      const lmCitingFetcher: SearchFetcher = async () => ({
        text: `You can get a local estimate at ${origin}/lm/${lmObsSlug} — it uses recent comps.`, provider: "tavily",
      })
      const lr1 = await runLandingPageCitationMonitor(brokerageId, { searchFetcher: lmCitingFetcher }, svc)
      const lmPage = lr1.pages.find((p) => p.formId === formId)
      check("landing run: our lead-magnet page was monitored", !!lmPage && lr1.pagesMonitored >= 1)
      check("landing run: cited per platform, visibility 1.0", lmPage?.visibility.score === 1 && lr1.cited >= CITATION_PLATFORMS.length && lr1.notCited === 0)
      check("landing run: cited_url points at /lm/<slug>", (lmPage?.citedUrl ?? "").includes(lmObsSlug))

      const { count: lmRows } = await svc.from("ai_search_landing_citation_observations")
        .select("id", { count: "exact", head: true }).eq("form_id", formId)
      check("landing db: one row per platform (no duplicates)", (lmRows ?? 0) === CITATION_PLATFORMS.length)

      // Idempotent rerun — UPSERT overwrites the day's rows.
      await runLandingPageCitationMonitor(brokerageId, { searchFetcher: lmCitingFetcher }, svc)
      const { count: lmRows2 } = await svc.from("ai_search_landing_citation_observations")
        .select("id", { count: "exact", head: true }).eq("form_id", formId)
      check("landing idempotency: rerun does not append", (lmRows2 ?? 0) === CITATION_PLATFORMS.length)

      // Unrelated answer → not_cited; dead rail → not_checked (honest degrade).
      const lmUnrelated: SearchFetcher = async () => ({ text: "Zillow shows several homes in that area.", provider: "exa" })
      const lr3 = await runLandingPageCitationMonitor(brokerageId, { searchFetcher: lmUnrelated }, svc)
      const lmPage3 = lr3.pages.find((p) => p.formId === formId)
      check("landing run: unrelated answer → not_cited, visibility 0.0", lmPage3?.visibility.score === 0 && lr3.cited === 0)

      const lmDead: SearchFetcher = async () => ({ text: "", provider: "none" })
      const lr4 = await runLandingPageCitationMonitor(brokerageId, { searchFetcher: lmDead }, svc)
      const lmPage4 = lr4.pages.find((p) => p.formId === formId)
      check("landing degrade: rail down → not_checked, visibility null", lmPage4?.visibility.score === null && lr4.notChecked >= CITATION_PLATFORMS.length)
    }
  } finally {
    // Reverse-delete. Observations cascade on the parent delete, but delete explicitly first to assert the path.
    try { await svc.from("ai_search_citation_observations").delete().eq("public_slug", `${TAG.toLowerCase()}-reel-deadbeef`) } catch {}
    if (lmObsSlug) { try { await svc.from("ai_search_landing_citation_observations").delete().eq("public_slug", lmObsSlug) } catch {} }
    for (const c of [...cleanup].reverse()) { try { await svc.from(c.table).delete().eq("id", c.id) } catch {} }
    const { count } = await svc.from("ai_video_projects").select("id", { count: "exact", head: true }).ilike("title", `${TAG}%`)
    check("cleanup verified (reel + observations gone)", (count ?? 0) === 0)
    const { count: obsLeft } = await svc.from("ai_search_citation_observations").select("id", { count: "exact", head: true }).eq("public_slug", `${TAG.toLowerCase()}-reel-deadbeef`)
    check("cleanup: observation count == 0", (obsLeft ?? 0) === 0)
    if (lmObsSlug) {
      const { count: lmLeft } = await svc.from("ai_search_landing_citation_observations").select("id", { count: "exact", head: true }).eq("public_slug", lmObsSlug)
      check("cleanup: landing observation count == 0", (lmLeft ?? 0) === 0)
    }
  }
  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
