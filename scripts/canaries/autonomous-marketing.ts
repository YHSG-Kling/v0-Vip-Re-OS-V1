/**
 * scripts/canaries/autonomous-marketing.ts — MARKETING canary (wave 142, lane 142J):
 *   a real lead-magnet idea from the tenant's own evidence · fair-housing blocks PUBLIC copy and never a private
 *   financial line · the booklet (the book survivor) renders REAL multi-page PDF bytes · omnipresence + the forms door
 * through the survivors at HEAD: lib/lead-magnets/suggestions.ts suggestLeadMagnetIdeas (pure: underperformer /
 * audience gap / season from the tenant's magnets, contact mix and farm territories — no copy hard-written),
 * lib/compliance-rules/fair-housing-patterns.ts detectFairHousingViolations + lib/kernel/marketing/
 * real-estate-compliance-gate.ts realEstateComplianceGate (the ONE phrase set every public gate shares),
 * lib/lead-magnets/ai-draft.ts draftFairHousingVerdict (a HIGH hit refuses the draft), lib/marketing/
 * guide-booklet-content.ts guideChaptersFor + lib/documents/client-pdf.ts renderClientPdf (pdf-lib — the booklet
 * the delivery runner ships) and lib/agents/marketing-agent-actions.ts omnipresence_topic_fanout. Owner (wave 142):
 * "fair-housing flags → AI REWRITES with the findings in mind → recheck → human approves"; "do NOT hard-write copy".
 *
 * MEASURED AT HEAD (the 142E hooks): ideation reads the tenant's own book only (no topic bank / competitive /
 * AI-search inputs); the rewrite loop exists for VIDEO only (ai-draft REFUSES on a high hit, social never rewrites);
 * the fan-out carries no asset reference; the book pipeline is the 5-chapter booklet; /api/forms/submit is a second
 * capture door beside captureFormSubmission. No tenant, no client: pure rails + stripped source.
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { hooksFor, readRepo, strippedRepo } from "./_registry"

export async function run() {
  const c = canary("Autonomous marketing: real idea from evidence → fair-housing gate → approved asset (real PDF) → omnipresence → attribution")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: pure rails + stripped source only — no publish, no send")
  // WIRED 142K (lane 142E): a tenant for the drives — the suggestion runner's intelligence rows, a PUBLISHED magnet and a
  // DRAFT one for the omnipresence fan-out, a capture form for the /forms/[slug] door, and the book project's agent.
  const B = uuid(), AG_U = uuid(), AG = uuid(), MAGNET = uuid(), DRAFT_MAGNET = uuid(), FORM = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-mkt`, state: "FL" }],
    users: [{ id: AG_U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "broker_owner", brokerage_id: B, platform_role: null, first_name: "Canary", last_name: "Broker", created_at: nowIso() }],
    agents: [{ id: AG, user_id: AG_U, brokerage_id: B, first_name: "Canary", last_name: "Broker", is_active: true, created_at: nowIso() }],
    lead_capture_forms: [
      { id: MAGNET, brokerage_id: B, agent_id: AG, name: `${CANARY_TAG} Seller Playbook`, slug: `${CANARY_TAG}-omni`, is_active: true, magnet_type: "seller_guide", landing_content: { headline: "The Seller's Playbook", subhead: "What actually matters when you list", bullets: ["Pricing", "Prep", "Timing"] }, settings: { lifecycle: { state: "published" } }, fields: [], created_at: nowIso() },
      { id: DRAFT_MAGNET, brokerage_id: B, agent_id: AG, name: `${CANARY_TAG} Draft Guide`, slug: `${CANARY_TAG}-draft`, is_active: false, magnet_type: "buyer_guide", landing_content: {}, settings: { lifecycle: { state: "draft" } }, fields: [], created_at: nowIso() },
      { id: FORM, brokerage_id: B, agent_id: AG, name: `${CANARY_TAG} Buyer Guide`, slug: `${CANARY_TAG}-door`, is_active: true, magnet_type: "buyer_guide", redirect_url: null, thank_you_message: "Thanks!", landing_content: {}, settings: {}, fields: [{ name: "email", type: "email", required: true }, { name: "first_name", type: "text" }], created_at: nowIso() },
    ],
    keyword_intelligence: [{ id: uuid(), brokerage_id: B, keyword: `how to sell a house fast ${CANARY_TAG}`, search_volume_monthly: 500, trend_change_pct: 35, trend_direction: "rising", intent_category: "seller", zip_code: "32501", expires_at: null }],
    ai_search_citation_observations: [{ id: uuid(), brokerage_id: B, query: `best time to sell a home in Pensacola ${CANARY_TAG}`, competitors_cited: ["Rival Realty"], outcome: "not_cited", observed_on: new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10) }],
  })
  setSvc(svc)

  // ── 1 · a REAL idea from the tenant's evidence (pure) ──
  const { suggestLeadMagnetIdeas } = await import("../../lib/lead-magnets/suggestions")
  const ideas = suggestLeadMagnetIdeas({ now: new Date("2026-10-19T12:00:00Z"), magnets: [{ id: "m-weak", name: "Home Value Report", magnetType: "home_value", isActive: true, views30d: 200, submissions30d: 1 }, { id: "m-ok", name: "Buyer Guide", magnetType: "buyer_guide", isActive: true, views30d: 150, submissions30d: 12 }], contactMix: { buyers: 40, sellers: 2 }, territories: ["Canary Heights"] })
  const under = ideas.find((i) => i.kind === "underperformer")
  c.step("IDEATION FROM EVIDENCE: a live magnet with 200 views and 1 submission (0.5 %) is an UNDERPERFORMER idea with its numbers as evidence and a concept a human hands to the AI draft; ≤ 5 ideas, every one keyed (dedupe identity), none a finished piece of copy", !!under && under.magnetId === "m-weak" && under.evidence.views30d === 200 && /0\.5%/.test(under.why) && ideas.length <= 5 && ideas.every((i) => i.key && i.concept.length > 20 && i.why.length > 0), ideas.map((i) => i.kind).join(","))

  // ── 2 · fair housing gates PUBLIC copy; never a private financial line ──
  const { detectFairHousingViolations } = await import("../../lib/compliance-rules/fair-housing-patterns")
  const { realEstateComplianceGate } = await import("../../lib/kernel/marketing/real-estate-compliance-gate")
  const bad = "Perfect starter home for a young family in a safe Christian neighborhood — no kids' noise next door!"
  const good = "Three-bedroom home near parks and transit, open Saturday 1–3. Equal Housing Opportunity."
  const cdaLine = "Net to agent $16,800.00 by direct deposit; brokerage split 30 %; gross commission $24,000.00."
  const hitsBad = detectFairHousingViolations(bad), hitsGood = detectFairHousingViolations(good), hitsCda = detectFairHousingViolations(cdaLine)
  const gateBad = await realEstateComplianceGate({ content: bad, contentType: "ad", brokerageName: "Canary Realty", requireAttribution: false })
  const gateGood = await realEstateComplianceGate({ content: good, contentType: "ad", brokerageName: "Canary Realty", requireAttribution: false })
  c.step("FAIR-HOUSING GATE on public copy: the ad naming family status / religion is BLOCKED with the specific phrase + a compliant rewrite suggestion; the clean ad passes; the same phrase set is the ONE every public gate shares", hitsBad.length > 0 && hitsBad.every((h) => h.phrase && h.fix) && !gateBad.passed && gateBad.blockers.some((b) => /Fair Housing/.test(b)) && hitsGood.length === 0 && gateGood.passed, `${hitsBad.length} phrase(s): ${hitsBad.map((h) => h.phrase).join("; ").slice(0, 80)}`)
  c.step("POSITIVE CONTROL (scope): a private CDA / financial line (net to agent, split, direct deposit) raises NO fair-housing finding — the moderation is for PUBLIC housing marketing, not internal financial records", hitsCda.length === 0, hitsCda.map((h) => h.phrase).join(";") || "0 findings")
  const { draftFairHousingVerdict } = await import("../../lib/lead-magnets/ai-draft")
  const verdict = draftFairHousingVerdict({ name: "Guide", description: bad, headline: "", subhead: "", cta: "", bullets: [], thankYou: "", fields: [], faq: [] } as never)
  c.step("THE LEAD-MAGNET DRAFT is scanned post-hoc on everything a visitor reads and a HIGH-severity hit REFUSES it (ok:false, the phrases named) — as it stands it refuses rather than rewrites (the 142E loop)", !verdict.ok && verdict.flagged.length > 0, `flagged ${verdict.flagged.length}, high ${verdict.high.length}`)

  // ── 3 · the APPROVED ASSET is real: the booklet renders multi-page PDF bytes (the book survivor) ──
  const { guideChaptersFor } = await import("../../lib/marketing/guide-booklet-content")
  const { renderClientPdf, guideBookletSpec } = await import("../../lib/documents/client-pdf")
  const { PDFDocument } = await import("pdf-lib")
  const chapters = guideChaptersFor("seller_guide")
  const bytes = await renderClientPdf(guideBookletSpec({ kind: "seller_guide", title: "The Seller's Playbook", intro: "What actually matters when you list.", chapters, areaLabel: "Canary Heights" }, { brokerageName: "Canary Realty", agentName: "Canary Agent", licenseLine: "Lic #000000 (XX)", primaryColor: "#1D4ED8", showEhoMark: true }, "October 2026"))
  const doc = await PDFDocument.load(bytes)
  c.step(`REAL ASSET: the seller booklet renders ${bytes.length} bytes of genuine PDF (%PDF- header) across ${doc.getPageCount()} pages from ${chapters.length} chapters with the EHO mark — the artifact the delivery runner ships; a status column never stands in for it`, Buffer.from(bytes.slice(0, 5)).toString() === "%PDF-" && doc.getPageCount() >= 2 && chapters.length >= 5 && chapters.every((ch) => ch.heading && ch.body.length > 40), `${doc.getPageCount()} pages`)

  // ── 4 · omnipresence + the forms door (stripped source) ──
  const fanout = strippedRepo("lib/agents/marketing-agent-actions.ts") ?? ""
  const branch = /case\s+["']omnipresence_topic_fanout["']:([\s\S]*?)\n\s*case\s+["']/.exec(fanout)?.[1] ?? ""
  c.step("OMNIPRESENCE exists on the ONE marketing-agent action rail: omnipresence_topic_fanout stages the same topic across newsletter / blog / social / postcard through each channel's own staging (never a direct publish)", branch.length > 0 && /newsletter/i.test(branch) && /blog/i.test(branch) && /social/i.test(branch) && /postcard/i.test(branch), "")
  const submit = strippedRepo("app/api/forms/submit/route.ts") ?? ""
  const magnets = strippedRepo("lib/kernel/lead-magnets.ts") ?? ""
  // THE RULE (lane 142E landed): the public forms door is a THIN door onto the ONE kernel command — no second capture path.
  c.step("ATTRIBUTION survives capture: the lead-magnet kernel carries campaign / ad / creative / utm attribution through captureFormSubmission (landed 141E) and the public forms door (/api/forms/submit) DELEGATES to that SAME command (landed 142E) — it no longer calls captureContact itself and inserts no contacts / form_submissions row of its own", /\b(campaign_id|ad_id|creative_id|utm_source)\b/.test(magnets) && /captureFormSubmission/.test(magnets) && /captureFormSubmission\(/.test(submit) && !/captureContact\(/.test(submit) && !/\.from\(\s*["'](contacts|form_submissions)["']\s*\)\s*\.insert/.test(submit), "")

  // ── WAVE142 HOOK (integrator): 142E — suggestion sources, the rewrite loop, the fan-out asset reference, the book pipeline, the forms-door merge. ──
  for (const h of hooksFor("autonomous-marketing")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, /SUGGESTION SOURCES/.test(h.contract) ? "measured: suggestions.ts reads magnets / contactMix / territories / season only — no topic-bank, competitive or AI-search input" : /REWRITE/.test(h.contract) ? "measured above: the draft REFUSES on a high hit; the rewrite loop exists for video only" : /OMNIPRESENCE/.test(h.contract) ? "measured: the fan-out branch carries no marketing_assets / magnet reference (postcard arm asset_id: null)" : /BOOK/.test(h.contract) ? `measured above: the survivor is the ${chapters.length}-chapter booklet (no research / fact-check / edit / cover stages)` : "measured: /api/forms/submit calls captureContact directly beside captureFormSubmission (two doors)"); continue }
    if (/SUGGESTION SOURCES/.test(h.contract)) {
      // WAVE142 HOOK (integrator): 142E — wired 142K: the intelligence signals (pure) + the runner on the tenant's own rows.
      const { runLeadMagnetSuggestions } = await import("../../lib/lead-magnets/suggestions")
      type Signal = Parameters<typeof suggestLeadMagnetIdeas>[0]["signals"] extends (infer S)[] | undefined ? S : never
      const signals: Signal[] = [
        { id: "t1", source: "topic_bank", title: "What a pre-listing inspection changes", angle: "fewer surprises at the table", score: 82, evidence: { is_brokerage_local: true, categories: ["seller"] } },
        { id: "t2", source: "competitor_intel", title: "Downsizing without the overwhelm", angle: null, score: 91, evidence: { categories: ["competitor_intel"] } },
        { id: "k1", source: "keyword", title: "how to sell a house fast canary heights", angle: null, score: 40, evidence: { trend_change_pct: 35, search_volume_monthly: 500, intent_category: "seller", zip_code: "32501" } },
        { id: null, source: "ai_search_gap", title: "best time to sell a home in Pensacola", angle: null, score: 25, evidence: { competitors: ["Rival Realty"], observations: 2 } },
        { id: "t3", source: "topic_bank", title: "a lower-scored topic", angle: null, score: 10, evidence: {} },
      ]
      const withSignals = suggestLeadMagnetIdeas({ now: new Date("2026-10-19T12:00:00Z"), magnets: [], contactMix: { buyers: 0, sellers: 0 }, territories: [], signals })
      const kinds = withSignals.map((i) => i.kind)
      const comp = withSignals.find((i) => i.kind === "competitor_insight"), trend = withSignals.find((i) => i.kind === "trending_topic"), gap = withSignals.find((i) => i.kind === "ai_search_gap")
      const topicBank = async () => [{ id: "bank-1", topic_title: `Pricing in a shifting market ${CANARY_TAG}`, value_angle: "what a week on market really signals", categories: ["seller"], engagement_score: 77, is_brokerage_local: true }]
      const run1 = await runLeadMagnetSuggestions(svc as never, B, { now: new Date("2026-10-19T12:00:00Z"), publish: true, readers: { topicBank } })
      // manager_signals.status DEFAULT 'open' is a column default the in-memory client does not model (the fixture the
      // user-invite canary stamps the same way) — the runner's dedupe reads it.
      for (const s of svc.tables.manager_signals ?? []) if (s.brokerage_id === B && s.status === undefined) s.status = "open"
      const run2 = await runLeadMagnetSuggestions(svc as never, B, { now: new Date("2026-10-19T12:00:00Z"), publish: true, readers: { topicBank } })
      const published = (svc.tables.manager_signals ?? []).filter((s) => s.brokerage_id === B && s.signal_type === "lead_magnet_suggestion")
      c.step(`${h.lane} landed (${at}) — SUGGESTION SOURCES: beside the tenant's own book the suggester takes INTELLIGENCE SIGNALS — the best of each source becomes one idea, at most three, ranked ai_search_gap (a page we are losing to a competitor) → trending topic (the topic bank) → competitor insight → search demand, never a firehose; a competitor-derived idea is INSPIRATION ONLY (an ORIGINAL concept, inspiration_only evidence, never the competitor's title as the creative); the AI-search gap names the competitor cited instead of us; the RUNNER reads the three live sources on the tenant's own rows (the topic bank through the ONE picker seam, rising keywords, AI-search citation gaps — each count honest) and publishes every NEW idea once on the bus (ai_isa → campaign_orchestrator), deduping on the idea key the second time`, kinds.slice(0, 3).join() === "ai_search_gap,trending_topic,competitor_insight" && withSignals.filter((i) => ["ai_search_gap", "trending_topic", "competitor_insight", "search_demand"].includes(i.kind)).length === 3 && trend?.evidence.topic_id === "t1" && !!comp && comp.evidence.inspiration_only === true && /ORIGINAL/.test(comp.concept) && comp.concept !== "Downsizing without the overwhelm" && !!gap && /Rival Realty/.test(gap.why) && withSignals.every((i) => i.key) && run1.ok && run1.sources?.topic_bank === 1 && run1.sources?.keyword === 1 && run1.sources?.ai_search_gap === 1 && run1.suggestions.some((s) => s.kind === "trending_topic") && run1.suggestions.some((s) => s.kind === "search_demand") && run1.suggestions.some((s) => s.kind === "ai_search_gap") && run1.published >= 3 && published.length === run1.published && published.every((s) => s.from_manager === "ai_isa" && s.to_manager === "campaign_orchestrator") && run2.ok && run2.published === 0 && run2.deduped === run1.published, `pure: ${kinds.join(",")}; runner sources ${JSON.stringify(run1.sources)}; published ${run1.published} then deduped ${run2.deduped}`)
      continue
    }
    if (/REWRITE/.test(h.contract)) {
      // WAVE142 HOOK (integrator): 142E — wired 142K: the ONE public-copy loop with the REAL gate and a rewriter seam.
      const R = await import("../../lib/kernel/marketing/public-copy-rewrite")
      const scanAd = await R.scanPublicCopy(bad, "ad", { brokerageName: "Canary Realty" })
      const scanCda = await R.scanPublicCopy(cdaLine, "cda")
      const fixed = await R.rewritePublicCopyUntilCompliant({ text: bad, surface: "ad", brokerageName: "Canary Realty", rewrite: async (_t, findings) => (findings.length ? good : null) })
      const stubborn = await R.rewritePublicCopyUntilCompliant({ text: bad, surface: "ad", brokerageName: "Canary Realty", rewrite: async (t, _f, attempt) => `${t} (attempt ${attempt})` })
      let cleanCalls = 0
      const clean = await R.rewritePublicCopyUntilCompliant({ text: good, surface: "ad", rewrite: async () => { cleanCalls++; return null } })
      const callers = ["lib/ads/ad-creator.ts", "lib/lead-magnets/ai-draft.ts", "app/actions/marketing/lead-magnet-copy.ts", "lib/lead-magnets/book-creator.ts"].filter((f) => /rewritePublicCopyUntilCompliant\(/.test(strippedRepo(f) ?? ""))
      c.step(`${h.lane} landed (${at}) — FAIR-HOUSING REWRITE LOOP for PUBLIC copy: the flagged ad is scanned (the specific phrase, its compliant fix and the reference), REWRITTEN with those findings, rechecked → compliant on rewrite 1 with the reviewer's trail (attempt 0 findings → attempt 1 clean); a rewriter that never resolves them is CAPPED at ${R.PUBLIC_COPY_MAX_REWRITES} rewrites and ESCALATED to a human (findings kept, a trail of ${R.PUBLIC_COPY_MAX_REWRITES + 1}); clean copy never calls the rewriter; SCOPE: a CDA / financial line on a private surface is never scanned (said in the warning — not public housing marketing), the surface rule is isPublicMarketingSurface; the ad creator, the lead-magnet draft, landing copy and the book all run this ONE loop (${callers.length} callers)`, !scanAd.ok && scanAd.findings.length > 0 && scanAd.findings.every((f) => f.phrase && f.fix && f.reference) && fixed.ok && fixed.rewrites === 1 && !fixed.escalated && fixed.text === good && fixed.trail.length === 2 && fixed.trail[0].findings.length > 0 && fixed.trail[1].findings.length === 0 && !stubborn.ok && stubborn.rewrites === R.PUBLIC_COPY_MAX_REWRITES && stubborn.escalated && stubborn.findings.length > 0 && stubborn.trail.length === R.PUBLIC_COPY_MAX_REWRITES + 1 && clean.ok && clean.rewrites === 0 && cleanCalls === 0 && scanCda.ok && scanCda.findings.length === 0 && scanCda.warnings.some((w) => /not public housing marketing/.test(w)) && !R.isPublicMarketingSurface("cda") && !R.isPublicMarketingSurface("financial_record") && !R.isPublicMarketingSurface("internal_form") && R.isPublicMarketingSurface("ad") && R.isPublicMarketingSurface("book") && R.isPublicMarketingSurface("lead_magnet") && callers.length === 4, `ad findings ${scanAd.findings.length}; fixed in ${fixed.rewrites}; stubborn escalated after ${stubborn.rewrites}; callers ${callers.length}`)
      continue
    }
    if (/OMNIPRESENCE/.test(h.contract)) {
      // WAVE142 HOOK (integrator): 142E — wired 142K: the fan-out executed through the marketing agent's own door.
      const { executeAction } = await import("../../lib/agents/marketing-agent-actions")
      const A1 = uuid(), A2 = uuid()
      ;(svc.tables.marketing_agent_actions ??= []).push(
        { id: A1, brokerage_id: B, action_type: "omnipresence_topic_fanout", action_input: { lead_magnet_id: MAGNET, channels: ["social", "direct_mail_postcard"] }, status: "proposed", created_at: nowIso() },
        { id: A2, brokerage_id: B, action_type: "omnipresence_topic_fanout", action_input: { lead_magnet_id: DRAFT_MAGNET, channels: ["social"] }, status: "proposed", created_at: nowIso() },
      )
      const prevOrigin = process.env.NEXT_PUBLIC_APP_URL
      process.env.NEXT_PUBLIC_APP_URL = "https://canary.test"
      const out = await executeAction(A1, AG_U)
      const outDraft = await executeAction(A2, AG_U)
      if (prevOrigin === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = prevOrigin
      const social = (svc.tables.social_posts ?? []).find((p) => (p.post_brief as Record<string, unknown> | null)?.lead_magnet_id === MAGNET)
      const result = out.result as { lead_magnet_id?: string | null; fanout?: Record<string, { ok: boolean; ref?: string; error?: string }> }
      const draftResult = outDraft.result as { error?: string }
      c.step(`${h.lane} landed (${at}) — OMNIPRESENCE carries the APPROVED creative: the fan-out executed through the marketing agent's own approval door takes an approved, PUBLISHED lead magnet (tenant-pinned read) and stages it per channel through each channel's own staging — the social draft carries the creative reference (lead_magnet_id + the capture page's landing URL in its brief) so follow-up finds the asset; a channel that cannot honour a magnet (direct mail fans out from a topic row) is REPORTED, never faked as queued; a DRAFT magnet is refused ('not published — approve and publish it first'); the result names the magnet; the action row records the outcome`, out.status === "succeeded" && result.lead_magnet_id === MAGNET && result.fanout?.social?.ok === true && !!social && social.status === "draft" && (social.post_brief as Record<string, unknown>)?.landing_url === `https://canary.test/lm/${CANARY_TAG}-omni` && /canary\.test\/lm\//.test(String(social.content)) && result.fanout?.direct_mail_postcard?.ok === false && /farm-mail/.test(result.fanout?.direct_mail_postcard?.error ?? "") && outDraft.status === "failed" && /not published/.test(draftResult.error ?? "") && (svc.tables.marketing_agent_actions ?? []).find((a) => a.id === A1)?.status === "succeeded" && (svc.tables.marketing_agent_actions ?? []).find((a) => a.id === A2)?.status === "failed" && /lead_magnet_id/.test(branch) && /not published/.test(branch), `fanout ${JSON.stringify(result.fanout).slice(0, 160)}; draft: ${draftResult.error?.slice(0, 60)}`)
      continue
    }
    if (/BOOK/.test(h.contract)) {
      // WAVE142 HOOK (integrator): 142E — wired 142K: concept → research → outline → chapters → fact-check → edit → layout
      // → ready_for_review on the magnet row, with the model lanes stubbed and the PDF rendered FOR REAL.
      const Book = await import("../../lib/lead-magnets/book-creator")
      const { renderClientPdf } = await import("../../lib/documents/client-pdf")
      const { leadMagnetBookRefOf } = await import("../../lib/kernel/lead-magnets")
      const chapterText = (heading: string) => Array.from({ length: 6 }, () => `${heading} matters because a home is both a place to live and the largest purchase most people ever make. Here is how the process usually unfolds, what to expect at each step, and the questions worth asking before you decide. Your agent explains the paperwork, the timing and the trade-offs in plain words, and the decision stays yours. Nothing here is legal, tax or lending advice; it is the map a good coach draws before the first conversation.`).join("\n\n")
      const headings = ["Pricing with a plan", "Preparing the home", "Marketing that reaches buyers", "From offer to closing"]
      let writerCalls = 0, checkerCalls = 0, entitlementCalls = 0, pdfBytes: Uint8Array | null = null
      const manuscriptWriter: NonNullable<Parameters<typeof Book.advanceBookProject>[1]>["manuscriptWriter"] = async (req) => {
        writerCalls++
        if (/Return ONLY JSON: \{"title"/.test(req.prompt)) return { text: JSON.stringify({ title: "The Canary Seller's Playbook", subtitle: "A calm guide to listing well", tagline: "Sell with a plan, not a guess", introduction: "Selling a home is a sequence of decisions.\n\nThis book walks them in order.", closing: "When you are ready, talk to your agent.", chapters: headings.map((heading) => ({ heading, summary: "What this chapter covers and why it matters.", key_points: ["the first thing", "the second thing", "the third thing"] })) }), tokens: 120, model: "canary-stub" }
        const heading = /Write chapter \d+ of \d+: "([^"]+)"/.exec(req.prompt)?.[1] ?? /Chapter \d+: "([^"]+)"/.exec(req.prompt)?.[1] ?? "This chapter"
        return { text: chapterText(heading), tokens: 400, model: "canary-stub" }
      }
      const deps: NonNullable<Parameters<typeof Book.advanceBookProject>[1]> = {
        client: svc as never,
        entitlement: async () => { entitlementCalls++; return { allowed: true, reason: "canary" } },
        researcher: async () => [{ topic: "How long does it take to sell a home here?" }, { topic: "What should I fix before listing?" }] as never,
        topicReader: async () => [`Pricing in a shifting market ${CANARY_TAG}`],
        manuscriptWriter,
        factCheckWriter: async () => { checkerCalls++; return { text: JSON.stringify({ findings: [] }), tokens: 30, model: "canary-stub" } },
        brandResolver: async () => ({ brokerageName: "Canary Realty", agentName: "Canary Broker", licenseLine: "Lic #000000 (XX)", primaryColor: "#1D4ED8", showEhoMark: true }),
        producer: async (_svc, args) => { const bytes = await renderClientPdf(args.spec); pdfBytes = bytes; const pdf = await PDFDocument.load(bytes); return { ok: true, pdfUrl: `memory://${CANARY_TAG}/book.pdf`, documentId: uuid(), pageCount: pdf.getPageCount(), error: null } },
        now: new Date("2026-10-19T12:00:00Z"),
      }
      const magnetsBefore = (svc.tables.lead_capture_forms ?? []).length
      const refused = await Book.startBookProject({ brokerageId: B, agentId: AG, createdBy: AG_U, concept: "A seller's book for first-time sellers in Pensacola", audience: "seller" }, { ...deps, entitlement: async () => ({ allowed: false, reason: "canary_refused", message: "AI book writing is not available on this plan." }) })
      const started = await Book.startBookProject({ brokerageId: B, agentId: AG, createdBy: AG_U, concept: "A seller's book for first-time sellers in Pensacola", audience: "seller", area: "Pensacola", brand: "Canary Realty" }, deps)
      const stages: string[] = []
      let done = false, lastError: string | null = null
      for (let i = 0; i < 12 && started.success && started.magnetId && !done; i++) {
        const step = await Book.advanceBookProject({ brokerageId: B, magnetId: started.magnetId, actorUserId: AG_U }, deps)
        if (!step.success) { lastError = step.error ?? "advance failed"; break }
        stages.push(String(step.stage)); done = step.done === true
      }
      const row = (svc.tables.lead_capture_forms ?? []).find((f) => f.id === started.magnetId)
      // Wave 145 (lane 145G, owner ruling 19): the BOOK is its own row (book_projects); the magnet only POINTS at it.
      const bookEntityRow = (svc.tables.book_projects ?? []).find((b) => b.id === started.bookId)
      const project = bookEntityRow?.project as Record<string, unknown> | undefined
      const chaptersOut = (project?.chapters ?? []) as Array<{ heading: string; words: number; edited?: { fair_housing_rewrites: number; escalated: boolean } }>
      const ref = leadMagnetBookRefOf({ book: project ?? null })
      const pages = pdfBytes ? (await PDFDocument.load(pdfBytes)).getPageCount() : 0
      const magnetsSrc = strippedRepo("lib/kernel/lead-magnets.ts") ?? ""
      const magnetsAfterRefusal = (svc.tables.lead_capture_forms ?? []).filter((f) => f.id !== started.magnetId).length
      const bookChecks: Array<[string, boolean]> = [
        ["refused entitlement writes nothing", !refused.success && /not available/.test(refused.error ?? "") && magnetsAfterRefusal === magnetsBefore],
        ["concept opens the project — the BOOK is its own entity and the draft magnet points at it", started.success && !!started.magnetId && !!bookEntityRow && bookEntityRow.distribution_form_id === started.magnetId && (row?.settings as { book_id?: string } | undefined)?.book_id === started.bookId],
        ["walks every stage to ready_for_review", done && lastError === null && stages.join(",") === "outline,chapters,chapters,fact_check,edit,edit,layout,ready_for_review"],
        ["entitlement asked on the start + every advance", entitlementCalls === stages.length + 1],
        ["model lanes: 1 outline + 4 chapters, 1 fact-check, 0 edits", writerCalls === 5 && checkerCalls === 1],
        ["4 chapters ≥ the word floor, each through the fair-housing loop, nobody escalated", chaptersOut.length === 4 && chaptersOut.every((ch) => ch.words >= Book.BOOK_MIN_CHAPTER_WORDS && ch.edited?.fair_housing_rewrites === 0 && ch.edited?.escalated === false) && (project?.needs_human_review as unknown[])?.length === 0],
        ["the outline's title landed", project?.title === "The Canary Seller's Playbook"],
        ["REAL multi-page PDF bytes", !!pdfBytes && Buffer.from((pdfBytes as Uint8Array).slice(0, 5)).toString() === "%PDF-" && pages >= 4],
        ["the magnet delivers the book", !!ref && ref.chapters === 4 && /^memory:/.test(ref.pdfUrl)],
        ["still a DRAFT for the human", row?.is_active !== true && (row?.settings as { lifecycle?: { state?: string } })?.lifecycle?.state !== "published"],
        ["publish gate reads the book", /leadMagnetBookRefOf|ready_for_review/.test(magnetsSrc)],
      ]
      const bookBad = bookChecks.filter(([, ok]) => !ok).map(([n]) => n)
      c.step(`${h.lane} landed (${at}) — BOOK CREATOR on the booklet survivor: a refused entitlement writes NOTHING; the concept opens a DRAFT magnet carrying the project (stage research) under the action ledger; every advance asks the entitlement BEFORE any spend and walks ONE stage: research (demand topics + the topic bank) → outline (the routed lane, stubbed: 4 chapters) → chapters (2 per advance, ≥ ${Book.BOOK_MIN_CHAPTER_WORDS} words, no figures) → fact-check (the deterministic figure scan + the checker lane: 0 findings) → edit (every chapter through the fair-housing loop, 0 rewrites, nobody escalated) → layout (brand → bookPdfSpec → REAL multi-page PDF bytes rendered by the producer) → ready_for_review; the finished book is what the magnet DELIVERS (leadMagnetBookRefOf: pdf + 4 chapters) and the row is still a DRAFT — a human reviews and publishes; the publish gate refuses an unfinished book`, bookBad.length === 0, `stages ${stages.join(" → ")}${lastError ? ` ✗ ${lastError}` : ""}; pdf ${pages} pages; chapters ${chaptersOut.map((ch) => ch.words).join("/")} words${bookBad.length ? `; FAILED: ${bookBad.join(", ")}` : ""}`)
      continue
    }
    // DUPLICATE FORMS DOOR consolidated — the thin door DRIVEN: POST /api/forms/submit lands through the ONE kernel command.
    const { POST } = await import("../../app/api/forms/submit/route")
    const { NextRequest } = await import("next/server")
    const req = new NextRequest("http://canary.test/api/forms/submit", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.7", "accept-language": "en-US" }, body: JSON.stringify({ slug: `${CANARY_TAG}-door`, data: { email: `door@${CANARY_EMAIL_DOMAIN}`, first_name: "Dora", last_name: "Canary" } }) })
    const res = await POST(req)
    const json = (await res.json()) as { success?: boolean; error?: string; contactId?: string }
    const doorContact = (svc.tables.contacts ?? []).find((x) => x.email === `door@${CANARY_EMAIL_DOMAIN}`)
    const submissions = (svc.tables.form_submissions ?? []).filter((s) => s.form_id === FORM)
    const missing = await POST(new NextRequest("http://canary.test/api/forms/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: `${CANARY_TAG}-nope`, data: { email: `x@${CANARY_EMAIL_DOMAIN}` } }) }))
    const rawRoute = readRepo("app/api/forms/submit/route.ts") ?? ""
    c.step(`${h.lane} landed (${at}) — the DUPLICATE FORMS DOOR consolidated: POST /api/forms/submit resolves the form by slug (the tenant comes from the ROW, never the body) and DELEGATES to captureFormSubmission — ONE contact under the tenant, ONE form_submissions row, the magnet's own tracking event, the reactor's hop; an unknown slug is 404; the route's own insert is gone and its header tombstones the survivor by name; the contact-type the form declares rides the ONE vocabulary (lib/lead-magnets/form-contact-types.ts)`, res.status === 200 && json.success === true && !!doorContact && doorContact.brokerage_id === B && (svc.tables.contacts ?? []).filter((x) => x.email === `door@${CANARY_EMAIL_DOMAIN}`).length === 1 && submissions.length === 1 && submissions[0].brokerage_id === B && missing.status === 404 && /SURVIVOR: captureFormSubmission/.test(rawRoute) && /declarableContactType|FORM_DECLARABLE_CONTACT_TYPES/.test(strippedRepo("lib/lead-magnets/form-contact-types.ts") ?? ""), `${res.status} ${JSON.stringify(json).slice(0, 100)}; contacts ${(svc.tables.contacts ?? []).length}; submissions ${submissions.length}`)
  }
  // ── WAVE 143 (lane 143F): the 55+ claim is VERIFIED, never assumed; the book's retail metadata never claims rank ──
  {
    const R = await import("../../lib/kernel/marketing/public-copy-rewrite")
    const { evaluateOlderPersonsRecord } = await import("../../lib/compliance/fair-housing-older-persons")
    const { scanBookClaims } = await import("../../lib/lead-magnets/book-publishing")
    const claim = "Sun Palms Village is a 55+ community with a clubhouse."
    const rec = { community_name: "Sun Palms Village", basis: "55_plus" as const, governing_rules: "CC&Rs", occupied_units: 200, qualifying_units: 172, survey_completed_on: "2026-03-01", policies_published: true, policies_reference: "handbook", age_verification_procedures: true, program_name: null, program_determination_ref: null, sworn_certification_on_file: true, certifying_representative: "A. Manager", certification_date: "2026-03-05", state: "FL", state_law_reviewed: true, verified_at: "2026-10-01T00:00:00Z" }
    const now = new Date("2026-10-23T12:00:00Z")
    const held = await R.scanPublicCopy(claim, "lead_magnet", { now })
    const passed = await R.scanPublicCopy(claim, "lead_magnet", { olderPersons: [rec], now })
    const stale = await R.scanPublicCopy(claim, "lead_magnet", { olderPersons: [{ ...rec, survey_completed_on: "2022-01-01" }], now })
    const onCda = await R.scanPublicCopy(claim, "cda", { now })
    const rank = scanBookClaims({ description: "The #1 bestseller on selling a home" })
    c.step("55+ / SENIOR CLAIM IS VERIFIED, NEVER ASSUMED (42 U.S.C. § 3607(b); 24 CFR 100.300–100.308): with no exemption record the claim is HELD (a finding the AI rewrites around, then a human); with a record that names the community and meets every condition it PASSES; a stale record (survey over two years old) holds it again; the same words on a CDA are never scanned; and the retail metadata guard refuses a '#1 bestseller' claim (the platform never implies rank)", !held.ok && held.olderPersons?.status === "unverified" && passed.ok && passed.olderPersons?.status === "verified" && evaluateOlderPersonsRecord(rec, now).status === "verified" && !stale.ok && stale.olderPersons?.status === "conditions_unmet" && onCda.ok && onCda.findings.length === 0 && rank.length > 0, JSON.stringify({ held: held.olderPersons?.status, passed: passed.olderPersons?.status, stale: stale.olderPersons?.status, cda: onCda.ok, rank: rank.length }))
  }
  c.blind("No model is called: ideation and the gates are pure; the book's model lanes are seams (outline / chapters / fact-check answered by the canary) while the fair-housing loop ran the REAL gate on every chapter and the PDF was RENDERED for real; the booklet's chapters are the fixed survivor text. The omnipresence social arm staged a draft row (no publish); the newsletter / blog staging rails are the content-staging proofs'. The forms door ran as a request in memory (no rate-limit store, no e-mail).")
  const cl = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", cl.mismatches.length === 0 && cl.residual === 0, cl.cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cl.cleanup, cl.residual)
}
