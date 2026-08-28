#!/usr/bin/env tsx
/**
 * scripts/revenue-share-board-simulator.ts   (npm run test:revenue-share-board)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the REVENUE-SHARE BOARD — the agent-to-agent recruiting growth engine made visible. The
 * commission waterfall already computes residual revenue share to sponsors (commission_distributions,
 * distribution_type 'residual') and the downline lives in agent_relationships; this surfaces both in the
 * one Command Center. No model narration in the numbers; honest zeros when the network is quiet.
 *
 * PURE:   summarizeRevenueShareBoard (earners top-first, paid/pending split, downline size per sponsor).
 * SOURCE: the board is wired into loadCommandCenter (brokerage-wide) + rendered in the client card.
 * LIVE (creds-gated): seed a residual distribution + an active sponsorship → loadCommandCenter surfaces
 *         the earner with their downline size → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { stripComments } from "./strip-comments"
import { summarizeRevenueShareBoard } from "../lib/intelligence/revenue-share-board"
import { benefitsPitchSection, offeredBenefitLabels, NO_BENEFITS } from "../lib/recruiting/benefit-offerings"
import {
  parseRevenueShareModel,
  edgeTermsFromModel,
  computeRevenueShare,
  REVENUE_SHARE_SOURCES,
  REVENUE_SHARE_RATE_TYPES,
} from "../lib/commission/revenue-share-model"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[summarizeRevenueShareBoard · pure — earners top-first, honest]")
  const names = new Map([["a", "Alice A"], ["b", "Bob B"]])
  const board = summarizeRevenueShareBoard(
    [
      { agent_id: "a", calculated_amount: 500, status: "paid" },
      { agent_id: "a", calculated_amount: 300, status: "pending" },
      { agent_id: "b", calculated_amount: 200, status: "paid" },
      { agent_id: null, calculated_amount: 999, status: "paid" }, // no recipient → ignored
      { agent_id: "a", calculated_amount: 0, status: "paid" },     // $0 → ignored
    ],
    [
      { sponsor_agent_id: "a", is_active: true },
      { sponsor_agent_id: "a", is_active: true },
      { sponsor_agent_id: "b", is_active: true },
      { sponsor_agent_id: "b", is_active: false }, // inactive → not counted
    ],
    names,
  )
  check("total shared = 1000 (a:800 + b:200)", board.totalShared === 1000)
  check("paid/pending split honest (paid 700, pending 300)", board.paidShared === 700 && board.pendingShared === 300)
  check("earners ranked by income (a $800 → b $200)", board.earners[0].agentId === "a" && board.earners[1].agentId === "b")
  check("downline size per sponsor (a:2 active, b:1 active)", board.earners[0].downlineSize === 2 && board.earners[1].downlineSize === 1)
  check("active sponsorships counts only is_active", board.activeRelationships === 3)
  check("earnerCount = distinct earning agents", board.earnerCount === 2)
  check("names resolved; missing → honest fallback", summarizeRevenueShareBoard([{ agent_id: "z", calculated_amount: 10, status: "paid" }], [], new Map()).earners[0].name === "An agent")
  check("quiet network → honest zeros", summarizeRevenueShareBoard([], [], new Map()).totalShared === 0)
}

/** BENEFIT OFFERINGS (owner ruling 2026-08-27): residual income IS the revenue-share setting —
 *  one mark, one settings home — plus the m574 medical/retirement marks, advertised only where
 *  the broker actually set them. Pure layer proves the fail-closed rendering; source layer proves
 *  the one home, the one loader, and the readers. */
function benefitOfferingsLayer() {
  console.log("\n[benefit offerings · pure — fail-closed: unset is NOT offered, nothing renders]")
  check("all-false offerings → NO benefits section at all (fail-closed control)", benefitsPitchSection(NO_BENEFITS) === null)
  check("all-false offerings → zero labels", offeredBenefitLabels(NO_BENEFITS).length === 0)
  const onlyMedical = offeredBenefitLabels({ revenueShare: false, medical: true, retirement: false })
  check("one mark → exactly that one label (medical)", onlyMedical.length === 1 && /Medical/.test(onlyMedical[0]))
  const rs = offeredBenefitLabels({ revenueShare: true, medical: false, retirement: false })
  check("the residual-income label rides the ONE revenue-share mark (§6 — no second spelling)", rs.length === 1 && /[Rr]esidual income/.test(rs[0]))
  const all = benefitsPitchSection({ revenueShare: true, medical: true, retirement: true })
  check("all three marks → three bullets under one heading", (all?.bullets?.length ?? 0) === 3)
  check("benefit claims carry the eligibility qualifier (compliance wording — offered, never promised)",
    (all?.paragraphs ?? []).some((p) => /Eligibility/.test(p)))

  console.log("\n[benefit offerings · wiring — one settings home, one loader, real readers]")
  const setting = src("app/actions/settings/revenue-share-setting.ts")
  check("the offerings settings home reads all four marks in one gated action", /getBenefitOfferings[\s\S]*?revenue_share_enabled, offers_medical_benefits, offers_retirement_benefits, tax_assistance_enabled/.test(setting))
  check("setBenefitOffering maps benefit→column through an allow-list (client never names a column)",
    /medical:\s*"offers_medical_benefits"/.test(setting) && /retirement:\s*"offers_retirement_benefits"/.test(setting))
  check("the offering write is COUNTED (zero rows ≠ saved)", /setBenefitOffering[\s\S]*?\.select\("id"\)[\s\S]*?saved\.length === 0/.test(setting))
  const card = src("app/components/settings/BenefitOfferingsCard.tsx")
  check("ONE settings card carries residual income + medical + retirement + tax assistance", /revenue_share/.test(card) && /medical/.test(card) && /retirement/.test(card) && /tax_assistance/.test(card))
  check("RevenueShareToggle merged into the card (tombstone names the source)", /TOMBSTONE[\s\S]*?RevenueShareToggle\.tsx/.test(card))
  check("the commission settings page renders the one offerings card", /BenefitOfferingsCard/.test(src("app/settings/commission/page.tsx")))
  const kit = src("lib/recruiting/recruiting-pitch-kit.ts")
  check("the recruit pitch kit loads offerings fail-closed and renders the benefits section", /loadBenefitOfferings\(svc, b\.id\)/.test(kit) && /benefitsPitchSection\(f\.benefits\)/.test(kit))
  check("flipping a mark regenerates the kit (offerings are in the settings hash)", /ob: f\.benefits \?\? null/.test(kit))
  check("team kits inherit the BROKERAGE's marks (set before the hash)", /loadBenefitOfferings\(svc, t\.brokerage_id\)[\s\S]*?pitchSettingsHash\(facts\)/.test(kit))
  const careers = src("app/recruiting/[brokerageSlug]/page.tsx")
  check("the public careers page passes offerings fail-closed (=== true)", /revenue_share_enabled === true/.test(careers) && /offers_medical_benefits === true/.test(careers) && /offers_retirement_benefits === true/.test(careers))
  const client = src("app/recruiting/[brokerageSlug]/recruiting-client.tsx")
  check("the careers client renders benefits ONLY when a mark is set (no hollow section)",
    /offersRevenueShare \|\| brokerage\.offersMedical \|\| brokerage\.offersRetirement/.test(client))
  const radar = src("lib/recruiting/retention-radar.ts")
  check("the retention save-play surfaces offered benefits as a retention lever (best-effort, fail-closed)",
    /offeredBenefitLabels\(await loadBenefitOfferings\(svc, p\.brokerageId\)\)/.test(radar) && /labels\.length > 0/.test(radar))
  const reg = src("lib/kernel/manager-registry.ts")
  check("the benefit-offerings seam is declared (recruiting × finance × compliance)",
    /benefit_offerings:\s*\{[\s\S]*?managers: \["recruiting_manager", "finance_manager", "compliance_officer"\]/.test(reg))
}

/** THE DISTRIBUTION MODEL (owner ruling 2026-08-27, verbatim: "revenue share
 *  mark should not be created with any assumption of how it gets configured so
 *  the settings should be telling the platform how the revenue share gets
 *  distributed whether it is a portion of the income or the brokerage pays the
 *  share as a flat fee or % and duration."). m575 + revenue-share-model.ts:
 *  the mark alone pays NOTHING; the settings say source / rate / duration and
 *  the waterfall + the edge-planting writer READ them. */
function distributionModelLayer() {
  console.log("\n[distribution model · pure — configured is read, unconfigured pays nothing]")
  const fullPercentRow = {
    revenue_share_enabled: true, revenue_share_source_of_funds: "agent", revenue_share_rate_type: "percent",
    revenue_share_default_percent: 5, revenue_share_flat_cents: null, revenue_share_duration_months: 24,
  }
  const configured = parseRevenueShareModel(fullPercentRow)
  check("POSITIVE CONTROL: a fully-described model parses configured", configured.configured && configured.model?.sourceOfFunds === "agent" && configured.model?.defaultPercent === 5 && configured.model?.durationMonths === 24)
  check("a pre-m575 row (columns absent entirely) parses UNCONFIGURED — absent behaves like NULL, fail-closed",
    !parseRevenueShareModel({ revenue_share_enabled: true }).configured)
  const noSource = parseRevenueShareModel({ ...fullPercentRow, revenue_share_source_of_funds: null })
  check("missing SOURCE → unconfigured, and the missing column is NAMED (published, not guessed)",
    !noSource.configured && noSource.missing.includes("revenue_share_source_of_funds"))
  check("a percent model without a percent is unconfigured; a flat model without a flat amount is unconfigured",
    !parseRevenueShareModel({ ...fullPercentRow, revenue_share_default_percent: null }).configured &&
    !parseRevenueShareModel({ ...fullPercentRow, revenue_share_rate_type: "flat" }).configured)
  const flatRow = { ...fullPercentRow, revenue_share_rate_type: "flat", revenue_share_default_percent: null, revenue_share_flat_cents: 25000 }
  check("a flat model (brokerage tells: flat fee per closing) parses configured", parseRevenueShareModel(flatRow).configured)
  check("duration NULL is unconfigured — indefinite must be the EXPLICIT 0, never an absence",
    !parseRevenueShareModel({ ...fullPercentRow, revenue_share_duration_months: null }).configured &&
    parseRevenueShareModel({ ...fullPercentRow, revenue_share_duration_months: 0 }).configured)

  console.log("\n[edge terms · pure — new edges are stamped FROM the model, never invented]")
  const from = new Date("2026-08-27T12:00:00Z")
  const terms = edgeTermsFromModel(configured, from)!
  check("percent model stamps the percent + source and computes effective_to from the duration",
    terms.revenue_share_percent === 5 && terms.source_of_funds === "agent" && terms.effective_from === "2026-08-27" && terms.effective_to === "2028-08-27")
  check("percent model OMITS the flat-cents key entirely (naming an absent column pre-m575 refuses the WHOLE write, PGRST204)",
    !("revenue_share_flat_cents" in terms))
  const flatTerms = edgeTermsFromModel(parseRevenueShareModel(flatRow), from)!
  check("flat model stamps flat cents per closing (and a null percent)", flatTerms.revenue_share_flat_cents === 25000 && flatTerms.revenue_share_percent === null)
  check("duration 0 (explicit indefinite) stamps effective_to null",
    edgeTermsFromModel(parseRevenueShareModel({ ...fullPercentRow, revenue_share_duration_months: 0 }), from)!.effective_to === null)
  check("FAIL-CLOSED: an unconfigured model yields NO edge terms — nothing is planted",
    edgeTermsFromModel(parseRevenueShareModel({ revenue_share_enabled: true }), from) === null &&
    edgeTermsFromModel(parseRevenueShareModel({ ...fullPercentRow, revenue_share_enabled: false }), from) === null)

  console.log("\n[money step · pure — the model gates; the edge's stamped terms pay; conservation holds]")
  const edge = (over: Record<string, unknown>) => ({
    sponsor_agent_id: "sp-1", relationship_type: "sponsor", depth_level: 1, is_active: true,
    revenue_share_percent: 5, revenue_share_flat_cents: null, source_of_funds: "agent",
    effective_from: "2026-01-01", effective_to: null, ...over,
  }) as any
  const base = { agentId: "ag-1", agentFinalNetCents: 100_000, brokerageFinalCents: 50_000 }
  {
    const r = computeRevenueShare({ ...base, state: { enabled: false, configured: false, model: null, missing: [] }, relationships: [edge({})] })
    check("disabled → skip 'disabled', zero distributions, balances untouched", r.skipped === "disabled" && r.distributions.length === 0 && r.agentFinalNetCents === 100_000)
  }
  {
    const r = computeRevenueShare({ ...base, state: parseRevenueShareModel({ revenue_share_enabled: true }), relationships: [edge({})] })
    check("THE OWNER'S RULE: enabled + UNCONFIGURED model → the mark alone pays NOTHING (skip 'model_unconfigured', even with a live 5% edge present)",
      r.skipped === "model_unconfigured" && r.distributions.length === 0 && r.agentFinalNetCents === 100_000 && r.brokerageFinalCents === 50_000)
  }
  const agentState = parseRevenueShareModel(fullPercentRow)
  {
    const r = computeRevenueShare({ ...base, state: agentState, relationships: [edge({}), edge({ sponsor_agent_id: "sp-2", depth_level: 2, revenue_share_percent: 3 })] })
    const dist = Math.round(r.distributions.reduce((s, d) => s + d.calculated_amount * 100, 0))
    check("agent-funded percent: rolling multi-level (5% of 1000 = 50; 3% of remaining 950 = 28.50), agent pays, brokerage untouched",
      r.distributions[0].calculated_amount === 50 && r.distributions[1].calculated_amount === 28.5 && r.brokerageFinalCents === 50_000)
    check("CONSERVATION (agent side): agent final + shares == original agent net", r.agentFinalNetCents + dist === 100_000)
  }
  {
    const r = computeRevenueShare({ ...base, state: agentState, relationships: [edge({ source_of_funds: "brokerage" })] })
    check("brokerage-funded ('the brokerage pays the share'): agent keeps full net, the BROKERAGE final funds the distribution",
      r.agentFinalNetCents === 100_000 && r.brokerageFinalCents === 45_000 && r.distributions[0].source_of_funds === "brokerage")
    check("CONSERVATION (brokerage side — the identity step 11 validates; pre-model this was never deducted and every brokerage-funded closing threw there)",
      r.brokerageFinalCents + Math.round(r.distributions[0].calculated_amount * 100) === 50_000)
    check("PRE-CAP UNCHANGED: sufficient company dollar pays IN-DEAL — no company-books obligation arises",
      r.companyObligations.length === 0)
  }
  {
    const r = computeRevenueShare({ ...base, state: agentState, relationships: [edge({ revenue_share_percent: null, revenue_share_flat_cents: 12_500 })] })
    check("flat edge: cents PER CLOSING (the waterfall runs per transaction), calculation_type 'flat'",
      r.distributions[0].calculated_amount === 125 && r.distributions[0].calculation_type === "flat")
  }
  {
    const r = computeRevenueShare({ ...base, state: agentState, relationships: [edge({ effective_to: "2026-01-31" })], today: new Date("2026-08-27") })
    const r2 = computeRevenueShare({ ...base, state: agentState, relationships: [edge({ effective_to: "2026-12-31" })], today: new Date("2026-08-27") })
    check("DURATION ENFORCED IN THE MONEY STEP: an expired edge pays nothing (control: the same edge in-window pays)",
      r.distributions.length === 0 && r2.distributions.length === 1)
    const notYet = computeRevenueShare({ ...base, state: agentState, relationships: [edge({ effective_from: "2027-01-01" })], today: new Date("2026-08-27") })
    const openBounds = computeRevenueShare({ ...base, state: agentState, relationships: [edge({ effective_from: null, effective_to: null })], today: new Date("2026-08-27") })
    check("a future-dated edge does not pay yet; open bounds pay (null effective_to = the explicit indefinite)",
      notYet.distributions.length === 0 && openBounds.distributions.length === 1)
  }
  {
    let agentThrew = false
    try { computeRevenueShare({ ...base, agentFinalNetCents: 100, state: agentState, relationships: [edge({ revenue_share_percent: null, revenue_share_flat_cents: 5_000 })] }) } catch { agentThrew = true }
    check("AGENT-FUNDED UNCHANGED: an agent-side overdraft still REFUSES — the agent's own money on this deal cannot go negative", agentThrew)
  }

  // ══ THE POST-CAP BROKERAGE-FUNDED SHARE (owner ruling 2026-08-28) ══════════
  //
  // "usually when a cap is met, the brokerage no longer takes from the agents if
  // the agent has splits with a cap as a commission level offering." The cap
  // ends the brokerage TAKING (stage 07 zeroes its in-deal final); it does not
  // end the brokerage PAYING its own obligations. A brokerage-funded share on a
  // post-cap deal has no company dollar IN THE DEAL to fund it — so it becomes a
  // COMPANY-BOOKS OBLIGATION (reason 'post_cap_company_books'), recorded outside
  // the in-waterfall distribution set (company_books_obligations, m577): never
  // refused (the old overdraft throw failed the producing agent's entire
  // commission), never silently dropped, never an in-deal overdraft.
  console.log("\n[post-cap company books · pure — the brokerage stops taking, it does not stop paying]")
  {
    // POST-CAP: stage 07 left the brokerage $0 in this deal.
    const r = computeRevenueShare({ ...base, brokerageFinalCents: 0, state: agentState, relationships: [edge({ source_of_funds: "brokerage" })] })
    check("post-cap brokerage-funded → RECORDED as a company-books obligation (5% of the agent's net), not refused",
      r.companyObligations.length === 1 && r.companyObligations[0].calculated_amount === 50 && r.companyObligations[0].agent_id === "sp-1")
    check("…with the reason the ledger will carry ('post_cap_company_books') and the §6 vocabulary word for the class ('residual')",
      r.companyObligations[0].reason === "post_cap_company_books" && r.companyObligations[0].obligation_type === "residual")
    check("…and NOT distributed in-deal: zero distributions, both in-deal balances untouched (no overdraft, conservation trivially holds)",
      r.distributions.length === 0 && r.agentFinalNetCents === 100_000 && r.brokerageFinalCents === 0)
  }
  {
    // STRADDLING (hit_cap): $1 of company dollar remains, the flat share is $50 —
    // the share routes WHOLE to company books; the deal's $1 stays in the deal.
    const r = computeRevenueShare({ ...base, brokerageFinalCents: 100, state: agentState, relationships: [edge({ source_of_funds: "brokerage", revenue_share_percent: null, revenue_share_flat_cents: 5_000 })] })
    check("insufficient company dollar (straddling deal): the WHOLE share goes to company books — one share, one ledger row, one payer",
      r.companyObligations.length === 1 && r.companyObligations[0].calculated_amount === 50 && r.distributions.length === 0 && r.brokerageFinalCents === 100)
  }
  {
    // MIXED: two brokerage-funded flat edges against $600 of company dollar —
    // the first ($5) fits in-deal, the second ($50) does not and goes to books.
    const r = computeRevenueShare({ ...base, brokerageFinalCents: 600, state: agentState, relationships: [
      edge({ source_of_funds: "brokerage", revenue_share_percent: null, revenue_share_flat_cents: 500 }),
      edge({ sponsor_agent_id: "sp-2", depth_level: 2, source_of_funds: "brokerage", revenue_share_percent: null, revenue_share_flat_cents: 5_000 }),
    ] })
    check("a deal funds what it can: the share that fits pays in-deal, the one that does not goes to company books — conservation holds on the in-deal side",
      r.distributions.length === 1 && r.brokerageFinalCents === 100
      && r.companyObligations.length === 1 && r.companyObligations[0].agent_id === "sp-2"
      && r.brokerageFinalCents + Math.round(r.distributions[0].calculated_amount * 100) === 600)
  }
  {
    // AGENT-FUNDED shares are UNAFFECTED by the brokerage's cap state: post-cap,
    // an agent-funded edge still pays from the agent's side, no obligation.
    const r = computeRevenueShare({ ...base, brokerageFinalCents: 0, state: agentState, relationships: [edge({})] })
    check("agent-funded unaffected post-cap: pays from the agent's side as always, no company-books obligation",
      r.distributions.length === 1 && r.agentFinalNetCents === 95_000 && r.companyObligations.length === 0)
  }

  console.log("\n[post-cap company books · negative controls — each must go RED]")
  {
    const postCapInput = { ...base, brokerageFinalCents: 0, state: agentState, relationships: [edge({ source_of_funds: "brokerage" })] }
    // The probe predicates, named so the controls exercise the REAL assertions.
    const recorded = (r: ReturnType<typeof computeRevenueShare>) =>
      r.companyObligations.length === 1 && r.companyObligations[0].reason === "post_cap_company_books"
    const noOverdraft = (r: ReturnType<typeof computeRevenueShare>) =>
      r.brokerageFinalCents >= 0 && r.distributions.length === 0

    check("POSITIVE CONTROL: the real computation passes both predicates", recorded(computeRevenueShare(postCapInput)) && noOverdraft(computeRevenueShare(postCapInput)))

    // BROKEN #1 — the share is SILENTLY DROPPED (the sponsor is never paid, and
    // nothing says so). The recorded-obligation predicate must go red.
    const dropped = { ...computeRevenueShare(postCapInput), companyObligations: [] }
    check("NEGATIVE CONTROL: silently dropping the share goes RED (obligation-recorded predicate)", !recorded(dropped))

    // BROKEN #2 — the share is paid as an IN-DEAL overdraft (distributed out of
    // money the deal does not have). The no-overdraft predicate must go red.
    const real = computeRevenueShare(postCapInput)
    const overdrafted = {
      ...real,
      companyObligations: [],
      brokerageFinalCents: real.brokerageFinalCents - real.companyObligations.reduce((s, o) => s + Math.round(o.calculated_amount * 100), 0),
      distributions: real.companyObligations.map((o) => ({
        distribution_type: "residual" as const, agent_id: o.agent_id, calculation_type: o.calculation_type,
        calculation_value: o.calculation_value, calculated_amount: o.calculated_amount, source_of_funds: "brokerage" as const,
      })),
    }
    check("NEGATIVE CONTROL: paying it as an in-deal overdraft goes RED (no-overdraft predicate)", !noOverdraft(overdrafted))

    // BROKEN #3 — the old refusal resurrected: post-cap brokerage-funded throws.
    const refuses = (i: Parameters<typeof computeRevenueShare>[0]) => {
      const r = computeRevenueShare(i)
      if (r.companyObligations.length > 0) throw new Error("[revenue-share] Brokerage-funded revenue share exceeds the brokerage's dollar")
      return r
    }
    let threw = false
    try { refuses(postCapInput) } catch { threw = true }
    check("NEGATIVE CONTROL: the resurrected refusal goes RED (a real business case is not an error)", threw)
  }

  console.log("\n[vocabulary agreement — code sets equal the m575 CHECKs, derived not pinned (§2)]")
  const mig = src("supabase/migrations/m575-the-revenue-share-mark-enabled-a-payout-the-brokerage-never-described.sql")
  const sqlSet = (col: string) => {
    const m = new RegExp(`${col} in \\(([^)]*)\\)`).exec(mig)
    return new Set((m?.[1] ?? "").split(",").map((s) => s.trim().replace(/'/g, "")).filter(Boolean))
  }
  const srcSet = sqlSet("revenue_share_source_of_funds")
  const rateSet = sqlSet("revenue_share_rate_type")
  check(`SOURCE vocabulary: code == m575 CHECK ({${[...srcSet].join(", ")}}) == agent_relationships.source_of_funds spelling (§6)`,
    srcSet.size === REVENUE_SHARE_SOURCES.length && REVENUE_SHARE_SOURCES.every((s) => srcSet.has(s)))
  check(`RATE vocabulary: code == m575 CHECK ({${[...rateSet].join(", ")}}) == the repo's rate-type pair (§6)`,
    rateSet.size === REVENUE_SHARE_RATE_TYPES.length && REVENUE_SHARE_RATE_TYPES.every((s) => rateSet.has(s)))
  check("m575: every model column is nullable with NO default (NULL = unconfigured, fail-closed — a DB default would be the platform assuming again)",
    !/revenue_share_source_of_funds text (not null|default)/.test(mig) && !/revenue_share_rate_type text (not null|default)/.test(mig) &&
    !/revenue_share_duration_months integer (not null|default)/.test(mig))
  check("m575: backfill transcribes ONLY brokerages with live percent-bearing edges (the m264 population), never invents",
    /where b\.revenue_share_enabled = true[\s\S]*?exists \(\s*select 1 from public\.agent_relationships r/.test(mig))
  check("m575: the per-edge flat rate lands on agent_relationships (the edge is the record of its terms)",
    /alter table public\.agent_relationships\s+add column if not exists revenue_share_flat_cents/.test(mig))

  console.log("\n[wiring · stripped scans (§2) — the readers read, the writer stamps, nothing is assumed]")
  // POSITIVE CONTROLS: each finder proven against the defect it hunts.
  const hardcodeRe = /revenue_share_percent:\s*\d/
  check("control: the hardcoded-terms finder catches the old invented stamp",
    hardcodeRe.test(`await service.from("agent_relationships").upsert({ revenue_share_percent: 5, source_of_funds: "brokerage" })`))
  const tombstoneSpecimen = "// the old code wrote revenue_share_percent: 5 here\nconst x = 1\n"
  check("control: stripComments removes a commented token (a tombstone is not a call site)",
    hardcodeRe.test(tombstoneSpecimen) && !hardcodeRe.test(stripComments(tombstoneSpecimen)))

  const wf = stripComments(src("lib/commission/waterfall/09-revenue-share.ts"))
  check("waterfall step 09 reads the MODEL (getRevenueShareModel) and computes through the pure step",
    /getRevenueShareModel\(context\.brokerageId/.test(wf) && /computeRevenueShare\(\{/.test(wf))
  check("step 09 fail-closed + published: unconfigured → empty distributions with the skip recorded and warned (no-op, not a refusal — the waterfall's absent-config precedent)",
    /revenueShareSkipped: 'model_unconfigured'/.test(wf) && /console\.warn\(/.test(wf) && /revenueShareDistributions: \[\]/.test(wf))
  check("step 09 applies BOTH balances from the computation (brokerage-funded shares now deduct)",
    /brokerageFinalCents: result\.brokerageFinalCents/.test(wf))

  const prov = stripComments(src("app/api/recruiting/provision-agent/route.ts"))
  check("the edge-planting writer stamps terms FROM the model (edgeTermsFromModel) — the hardcoded 5%/brokerage invention is gone",
    /edgeTermsFromModel\(rsState\)/.test(prov) && !hardcodeRe.test(prov))
  check("the writer plants NO edge when the model is unconfigured, and says so", /no revenue-share edge planted/.test(prov) && /if \(!edgeTerms\)/.test(prov))

  const setting = stripComments(src("app/actions/settings/revenue-share-setting.ts"))
  check("settings home: setRevenueShareDistributionModel is the ONE writer — gated, validated against the vocabularies, COUNTED (§3)",
    /setRevenueShareDistributionModel/.test(setting) && /REVENUE_SHARE_SOURCES\.includes/.test(setting) &&
    /revenue_share_duration_months: durationMonths/.test(setting) && /saved\.length === 0/.test(setting))
  check("settings home: pre-apply honesty — PGRST204 is reported as 'm575 written, not applied', never a mystery",
    /PGRST204/.test(setting) && /m575/.test(setting))
  check("settings home: the model READ uses select('*') so the same code is correct pre-apply (absent column → unconfigured, no 42703)",
    /getRevenueShareDistributionModel/.test(setting) && /\.select\("\*"\)\.eq\("id", ctx\.brokerageId\)/.test(setting))
  const card = src("app/components/settings/BenefitOfferingsCard.tsx")
  check("the offerings card carries the model panel on the residual-income row (source / rate / duration, §5 broker-facing)",
    /RevenueShareModelPanel/.test(card) && /setRevenueShareDistributionModel\(input\)/.test(card))
  check("the panel says the truth about an unconfigured model: the toggle alone pays nothing",
    /the toggle alone pays nothing/i.test(card))
  const reg2 = src("lib/kernel/manager-registry.ts")
  check("registry: revenue_share_distribution_model domain appended with this proof",
    /revenue_share_distribution_model:\s*\{\s*manager:\s*"finance_manager",\s*proof:\s*"test:revenue-share-board"/.test(reg2))

  console.log("\n[post-cap company books · wiring — stripped scans (§2): recorded outside the deal, never swept by the deal]")
  // POSITIVE CONTROLS: each finder proven against the defect it hunts, and
  // proven comment-blind (a tombstone naming companyObligations is not a fold).
  // `[^\]]*`, not `[\s\S]*?` — the lazy form walks past the array's closing
  // bracket to the `const companyObligations = …` line below it and reports a
  // fold that is not there (the commission-cap simulator's S8 lesson).
  const foldRe = /allDistributions = \[[^\]]*companyObligations[^\]]*\]/
  check("control: the fold-finder catches obligations summed into the deal's distribution set",
    foldRe.test("const allDistributions = [\n  ...context.teamDistributions,\n  ...(context.companyObligations ?? []),\n]"))
  // The REAL step 11 carries exactly this shape: a comment inside the array
  // explaining why companyObligations is absent. Raw source counts it as a fold
  // (a tombstone is not a call site — §2); stripped source must not.
  const foldTombstone = "const allDistributions = [\n  ...context.teamDistributions,\n  // companyObligations deliberately NOT folded here\n]\n"
  check("control: a comment naming companyObligations inside the array is a tombstone, not a fold — stripped first (§2)",
    foldRe.test(foldTombstone) && !foldRe.test(stripComments(foldTombstone)))

  const wf11 = stripComments(src("lib/commission/waterfall/11-validate-persist.ts"))
  check("step 11 keeps obligations OUT of the conservation identity — companyObligations is not folded into allDistributions",
    !foldRe.test(wf11) && /const companyObligations = context\.companyObligations \?\? \[\]/.test(wf11))
  check("step 11 records them on company_books_obligations (m577), NEVER commission_distributions — the deal's payment sweeps must not mark a company payable paid",
    /\.from\('company_books_obligations'\)[\s\S]{0,600}?\.insert\(/.test(wf11)
    && !/\.from\('commission_distributions'\)[\s\S]{0,600}?companyObligations/.test(wf11))
  check("the write is COUNTED (§3: an RLS refusal is error:null + zero rows) and a refusal THROWS naming m577 — never a silently dropped obligation",
    /\.select\('id'\)/.test(wf11)
    && /obligationRows\.length !== companyObligations\.length/.test(wf11)
    && /m577/.test(wf11))
  check("idempotent per transaction: only this deal's still-PENDING rows are replaced (paid/voided rows are payment history)",
    /\.delete\(\)[\s\S]{0,200}?\.eq\('transaction_id', context\.transactionId\)[\s\S]{0,120}?\.eq\('brokerage_id', context\.brokerageId\)[\s\S]{0,120}?\.eq\('status', 'pending'\)/.test(wf11))
  check("step 09 threads the obligations from the pure computation onto the context",
    /companyObligations: result\.companyObligations/.test(stripComments(src("lib/commission/waterfall/09-revenue-share.ts"))))

  const m577 = src("supabase/migrations/m577-a-post-cap-brokerage-funded-share-is-owed-from-company-books-not-refused.sql")
  const m577Set = (col: string) => {
    // \b so `status` cannot match inside `cap_status` (underscore is a word
    // character, so the boundary lands exactly where the column name starts).
    const m = new RegExp(`\\b${col} in \\(([^)]*)\\)`).exec(m577)
    return new Set((m?.[1] ?? "").split(",").map((s) => s.trim().replace(/'/g, "")).filter(Boolean))
  }
  check("m577: the reason vocabulary admits exactly what the code writes ('post_cap_company_books')",
    m577Set("reason").size === 1 && m577Set("reason").has("post_cap_company_books"))
  check("m577: status + cap_status + calculation_type reuse commission_distributions' exact sets (§6 — no second spelling)",
    ["pending", "approved", "paid", "voided"].every((s) => m577Set("status").has(s)) && m577Set("status").size === 4
    && ["pre_cap", "hit_cap", "post_cap", "n/a"].every((s) => m577Set("cap_status").has(s)) && m577Set("cap_status").size === 4
    && ["flat", "percent"].every((s) => m577Set("calculation_type").has(s)) && m577Set("calculation_type").size === 2)
  check("m577: obligation_type admits only what is written ('residual' — the distributions vocabulary word for revenue share)",
    m577Set("obligation_type").size === 1 && m577Set("obligation_type").has("residual"))
  check("m577: RLS enabled, recipient is an agents.id FK, and the triggering deal is audit-linked (set null on delete, never cascade-erasing a payable)",
    /alter table public\.company_books_obligations enable row level security/.test(m577)
    && /agent_id\s+uuid not null references public\.agents\(id\)/.test(m577)
    && /references public\.transactions\(id\) on delete set null/.test(m577))
  check("registry: the post-cap company-books ruling is a declared finance domain",
    /post_cap_company_books/.test(reg2) && /company_books_obligations/.test(reg2))
}

function sourceLayer() {
  console.log("\n[wiring — loader slice + client card]")
  const cc = src("lib/kernel/command-center.ts")
  check("revenueShareBoard is in the CommandCenterData contract", /revenueShareBoard:\s*import\("@\/lib\/intelligence\/revenue-share-board"\)/.test(cc))
  check("loadCommandCenter generates it (brokerage-wide, best-effort)", /generateRevenueShareBoard\(brokerageId\)/.test(cc) && /revenueShareBoard = revShareRes\.value/.test(cc))
  const client = src("app/dashboard/admin/command-center/command-center-client.tsx")
  check("the client renders the revenue-share board card", /recruiting growth engine/.test(client) && /data\.revenueShareBoard/.test(client))
  const board = src("lib/intelligence/revenue-share-board.ts")
  check("reads the residual distributions the waterfall writes", /distribution_type", "residual"/.test(board))
  check("reads the downline from agent_relationships", /agent_relationships[\s\S]*?sponsor_agent_id/.test(board))
  check("GATED — board returns null unless the brokerage enabled revenue share", /revenue_share_enabled[\s\S]*?return null/.test(board))
  const wf = src("lib/commission/waterfall/09-revenue-share.ts")
  check("GATED — waterfall skips revenue share unless the brokerage enabled it", /revenue_share_enabled[\s\S]*?revenueShareDistributions: \[\]/.test(wf))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed a residual distribution + a sponsorship → loadCommandCenter surfaces the earner → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: ags } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).limit(2)
  if (!ags || ags.length < 2) { console.log("  ⊘ need 2 agents — skipping"); return }
  const sponsorId = (ags as any[])[0].id
  const recruitId = (ags as any[])[1].id
  const { data: txn } = await svc.from("transactions").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
  if (!txn) { console.log("  ⊘ no transaction — skipping"); return }
  const txnId = (txn as any).id
  // Preserve + control the opt-in flag around the test.
  const { data: prevFlag } = await svc.from("brokerages").select("revenue_share_enabled").eq("id", brokerageId).maybeSingle()
  const originalEnabled = !!(prevFlag as any)?.revenue_share_enabled
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: dist } = await svc.from("commission_distributions").insert({
      brokerage_id: brokerageId, agent_id: sponsorId, transaction_id: txnId, distribution_type: "residual",
      calculation_type: "percent", calculation_value: 5, calculated_amount: 750, source_of_funds: "brokerage", status: "pending",
    }).select("id").single()
    cleanup.push({ table: "commission_distributions", id: (dist as any).id })
    const { data: rel } = await svc.from("agent_relationships").insert({
      brokerage_id: brokerageId, agent_id: recruitId, sponsor_agent_id: sponsorId,
      revenue_share_percent: 5, depth_level: 1, is_active: true, relationship_type: "sponsor", source_of_funds: "brokerage",
    }).select("id").single()
    cleanup.push({ table: "agent_relationships", id: (rel as any).id })

    const { loadCommandCenter } = await import("../lib/kernel/command-center")

    // DISABLED — the board must be hidden even with real revenue-share data present.
    await svc.from("brokerages").update({ revenue_share_enabled: false }).eq("id", brokerageId)
    const ccOff = await loadCommandCenter({ brokerageId, limit: 100 })
    check("live: GATED OFF — no revenue-share board when the brokerage doesn't offer it", ccOff.revenueShareBoard === null)

    // ENABLED — the broker turns it on; the board appears with the earner.
    await svc.from("brokerages").update({ revenue_share_enabled: true }).eq("id", brokerageId)
    const cc = await loadCommandCenter({ brokerageId, limit: 100 })
    check("live: ENABLED — command center carries a revenue-share board", !!cc.revenueShareBoard)
    check("live: the seeded $750 residual shows in the total", (cc.revenueShareBoard?.totalShared ?? 0) >= 750)
    const earner = cc.revenueShareBoard?.earners.find((e) => e.agentId === sponsorId)
    check("live: the sponsor appears as an earner with their downline size ≥ 1", !!earner && earner!.downlineSize >= 1)
  } finally {
    await svc.from("brokerages").update({ revenue_share_enabled: originalEnabled }).eq("id", brokerageId)
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  pureLayer()
  benefitOfferingsLayer()
  distributionModelLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ REVENUE_SHARE_BOARD_FAIL"); process.exit(1) }
  console.log(" ✅ REVENUE_SHARE_BOARD_PASS — the agent-to-agent revenue-share growth engine is visible in the command center")
}
main()
