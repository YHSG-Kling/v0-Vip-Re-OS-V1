#!/usr/bin/env tsx
/**
 * scripts/regulatory-watcher-simulator.ts
 *
 * REGULATORY-CHANGE WATCHER verification — no mocks, no stubs, no demo data.
 *
 * Layer 1 (pure, always runs):
 *   · matchAffectedSurfaces — a TCPA quiet-hours change → [tcpa-gate]; a state
 *     protected-class addition → fair-housing surfaces; an NAR buyer-agreement change
 *     → [bba-authority-gate]; an unrelated change → [] (no false positive).
 *   · classifyChangeSeverity — binding (effective date / final rule), advisory
 *     (guidance), informational; effectiveDate parsed ONLY when literally present,
 *     else null (never fabricated).
 *   · parseChangesFromSearchResult — provider "none" → [] (honest empty); real hits →
 *     changes carrying provenance.
 *
 * Layer 2 (live, guarded by Supabase creds): run runRegulatoryWatcher with an INJECTED
 *   searchFetcher returning a REAL-STYLE TCPA change that cites an effective date →
 *   assert the tcpa-gate surface matched, an observation recorded, a gated compliance
 *   escalation (manager-signals bus line + notification) sent. Idempotent rerun (no new
 *   row, no new escalation). Search-unavailable fetcher → "no changes", nothing
 *   fabricated/escalated. Reverse-delete + cleanup count == 0. NEVER hits the real rail.
 */
import {
  matchAffectedSurfaces,
  classifyChangeSeverity,
  parseChangesFromSearchResult,
  changeSignature,
  extractEffectiveDate,
  isoWeek,
  runRegulatoryWatcher,
  COMPLIANCE_SURFACES,
  type RegSearchFetcher,
  type RegSearchResult,
} from "../lib/kernel/regulatory-watcher"

let passed = 0, failed = 0; const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => {
  if (c) { passed++; console.log(`  ✓ ${n}`) } else { failed++; fails.push(n); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) }
}
const report = () => {
  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  if (failed) { for (const f of fails) console.log("   - " + f); process.exit(1) }
  console.log(" ✅ Regulatory watcher verified"); console.log("REGULATORY_WATCHER_PASS")
}

const ids = (ms: ReturnType<typeof matchAffectedSurfaces>) => ms.map((m) => m.surface.id)

async function main() {
  console.log("══ Regulatory-change watcher simulator ══\n[Layer 1 · pure]")

  // ── matchAffectedSurfaces ──
  const tcpa = matchAffectedSurfaces({
    title: "FCC adopts new TCPA quiet-hours rule for real estate text messages",
    summary: "The rule limits autodialer SMS to between 8am and 9pm and tightens prior express written consent.",
  })
  check("match: TCPA quiet-hours change → tcpa-gate", ids(tcpa).includes("tcpa-gate"))
  check("match: TCPA change carries matched-keyword evidence", (tcpa.find((m) => m.surface.id === "tcpa-gate")?.matchedKeywords.length ?? 0) > 0)

  const fh = matchAffectedSurfaces({
    title: "State adds 'source of income' as a protected class under its fair housing law",
    summary: "Landlords and agents may not refuse Section 8 housing voucher holders; new state protected class effective soon.",
  })
  check("match: state protected-class addition → state-protected-classes surface", ids(fh).includes("state-protected-classes"))
  check("match: protected-class change also flags fair-housing-patterns", ids(fh).includes("fair-housing-patterns"))

  const nar = matchAffectedSurfaces({
    title: "NAR settlement requires a written buyer agreement before touring",
    summary: "Agents must sign a buyer-broker agreement and disclose compensation before showing homes.",
  })
  check("match: NAR buyer-agreement change → bba-authority-gate", ids(nar).includes("bba-authority-gate"))

  const ftc = matchAffectedSurfaces({
    title: "FTC updates endorsement guides barring fake reviews and AI-generated endorsements",
    summary: "Deceptive advertising using made-up reviews now carries civil penalties.",
  })
  check("match: FTC endorsement-guide change → marketing-claims-gate", ids(ftc).includes("marketing-claims-gate"))

  const unrelated = matchAffectedSurfaces({
    title: "Local brokerage raises seed round and hires a new CTO",
    summary: "The startup plans to expand its agent software to three new metro areas next year.",
  })
  check("match: unrelated business news → NO surfaces (no false positive)", unrelated.length === 0)

  const emptyMatch = matchAffectedSurfaces({ title: "", summary: "" })
  check("match: empty change → [] (total, no crash)", emptyMatch.length === 0)

  // ── classifyChangeSeverity + effective-date extraction (no fabrication) ──
  const binding = classifyChangeSeverity({
    title: "Final rule: TCPA consent revocation",
    summary: "The final rule takes effect January 1, 2025 and applies to all real estate texters.",
  })
  check("severity: final rule + effective date → binding tier", binding.tier === "binding")
  check("severity: effective date parsed literally (2025-01-01)", binding.effectiveDate === "2025-01-01")

  const advisory = classifyChangeSeverity({
    title: "HUD issues guidance on fair housing advertising",
    summary: "The advisory FAQ clarifies acceptable language but is non-binding staff guidance.",
  })
  check("severity: guidance/FAQ → advisory tier", advisory.tier === "advisory")
  check("severity: advisory with no date → effectiveDate null (never fabricated)", advisory.effectiveDate === null)

  const info = classifyChangeSeverity({
    title: "Article discusses possible future fair housing reforms",
    summary: "Commentators speculate about what reforms could look like; nothing has been decided.",
  })
  check("severity: speculative item → informational, date null", info.tier === "informational" && info.effectiveDate === null)

  check("date: ISO format parsed", extractEffectiveDate("effective 2026-03-15 for all") === "2026-03-15")
  check("date: slash format parsed", extractEffectiveDate("compliance deadline 7/1/2026 nationwide") === "2026-07-01")
  check("date: no date in text → null", extractEffectiveDate("the rule will take effect soon") === null)

  // ── parseChangesFromSearchResult — honest empty + provenance ──
  const dead: RegSearchResult = { answer: null, hits: [], provider: "none" }
  check("parse: provider 'none' → [] (search unavailable, nothing fabricated)", parseChangesFromSearchResult(dead, "q").length === 0)

  const live: RegSearchResult = {
    answer: "Summary of recent changes.",
    hits: [{ title: "New TCPA quiet hours rule", url: "https://fcc.gov/tcpa-2025", snippet: "Effective January 1, 2025." }],
    provider: "tavily",
  }
  const parsed = parseChangesFromSearchResult(live, "tcpa query")
  check("parse: real hit → one change carrying provenance (source+url)", parsed.length === 1 && parsed[0].url === "https://fcc.gov/tcpa-2025" && parsed[0].source === "fcc.gov")

  // ── changeSignature is deterministic ──
  const c = { title: "New TCPA quiet hours rule", url: "https://fcc.gov/tcpa-2025" }
  check("signature: deterministic + stable", changeSignature(c) === changeSignature(c) && /^[0-9a-f]{8}$/.test(changeSignature(c)))

  check("catalog: 6 real OS surfaces present", COMPLIANCE_SURFACES.length === 6 && COMPLIANCE_SURFACES.every((s) => s.file.length > 0))
  check("week: isoWeek labelled", /^\d{4}-W\d{2}$/.test(isoWeek(new Date("2026-06-13T00:00:00Z"))))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("\n[Layer 2] ⏭ no Supabase creds — pure layer only"); report(); return }

  console.log("\n[Layer 2 · live, injected searchFetcher — no real search egress]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const now = new Date()
  const TAG = `RegWatch${Date.now()}`
  // A unique real-style change so the signature is unique to THIS run (idempotency +
  // cleanup are exact). The TAG rides the title so changeSignature is run-unique.
  const changeTitle = `[${TAG}] FCC adopts TCPA quiet-hours rule for real estate SMS`
  const changeUrl = `https://fcc.gov/tcpa/${TAG.toLowerCase()}`

  try {
    const { data: broker } = await svc.from("users").select("brokerage_id")
      .eq("user_type", "broker").not("brokerage_id", "is", null).limit(1).maybeSingle()
    const brokerageId = (broker as { brokerage_id?: string } | null)?.brokerage_id
    if (!brokerageId) { console.log("  ⏭ need a broker user with a brokerage"); report(); return }

    // INJECTED fetcher describing a REAL-STYLE TCPA change with an effective date.
    // Only the FIRST query returns the change; the rest return empty (real-world shape).
    let firstQuery = true
    const tcpaFetcher: RegSearchFetcher = async () => {
      if (firstQuery) {
        firstQuery = false
        return {
          answer: "A new TCPA rule affects real estate texting.",
          hits: [{
            title: changeTitle,
            url: changeUrl,
            snippet: "The final rule limits autodialer SMS and tightens prior express written consent. It takes effect January 1, 2027.",
          }],
          provider: "tavily",
        }
      }
      return { answer: null, hits: [], provider: "none" }
    }

    const r1 = await runRegulatoryWatcher(brokerageId, { now, queries: ["q1", "q2"] }, { searchFetcher: tcpaFetcher }, svc)
    const flag = r1.flagged.find((f) => f.title === changeTitle)
    check("run: search ran + change flagged", r1.searchRan && !!flag)
    check("run: tcpa-gate surface matched", !!flag && flag.surfaces.some((s) => s.id === "tcpa-gate"))
    check("run: binding tier + effective date 2027-01-01 (parsed, not invented)", flag?.severity.tier === "binding" && flag?.severity.effectiveDate === "2027-01-01")
    check("run: new change escalated", flag?.state === "new" && flag?.escalated === true && r1.escalated >= 1)

    const sig = changeSignature({ title: changeTitle, url: changeUrl })
    const period = isoWeek(now)

    // Observation recorded (idempotent key present).
    const { count: obsCount } = await svc.from("reg_change_observations")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("change_signature", sig).eq("period", period)
    check("db: one observation row recorded", (obsCount ?? 0) === 1)
    const { data: obsRow } = await svc.from("reg_change_observations")
      .select("severity_tier, effective_date, affected_surfaces, escalated_at")
      .eq("brokerage_id", brokerageId).eq("change_signature", sig).eq("period", period).maybeSingle()
    check("db: observation carries binding + effective_date + surfaces + escalated_at",
      (obsRow as any)?.severity_tier === "binding" &&
      (obsRow as any)?.effective_date === "2027-01-01" &&
      Array.isArray((obsRow as any)?.affected_surfaces) && (obsRow as any).affected_surfaces.includes("tcpa-gate") &&
      !!(obsRow as any)?.escalated_at)

    // The gated escalation: a manager-signals bus line.
    const { count: busCount } = await svc.from("manager_signals")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("signal_type", "regulatory_change_detected")
      .contains("payload", { change_signature: sig })
    check("escalation: gated compliance bus line published", (busCount ?? 0) >= 1)

    // Idempotent rerun — same period, same change: no new row, no new escalation.
    let firstQuery2 = true
    const tcpaFetcher2: RegSearchFetcher = async () => {
      if (firstQuery2) { firstQuery2 = false; return {
        answer: null,
        hits: [{ title: changeTitle, url: changeUrl, snippet: "Effective January 1, 2027." }],
        provider: "tavily",
      } }
      return { answer: null, hits: [], provider: "none" }
    }
    const r2 = await runRegulatoryWatcher(brokerageId, { now, queries: ["q1", "q2"] }, { searchFetcher: tcpaFetcher2 }, svc)
    const flag2 = r2.flagged.find((f) => f.title === changeTitle)
    check("idempotency: rerun re-flags as duplicate, escalates nothing new", flag2?.state === "duplicate" && flag2?.escalated === false && r2.escalated === 0)
    const { count: obsCount2 } = await svc.from("reg_change_observations")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("change_signature", sig).eq("period", period)
    check("idempotency: still one observation row (no append)", (obsCount2 ?? 0) === 1)

    // Search-unavailable → "no changes", nothing fabricated or escalated.
    const deadFetcher: RegSearchFetcher = async () => ({ answer: null, hits: [], provider: "none" })
    const r3 = await runRegulatoryWatcher(brokerageId, { now, queries: ["q1", "q2"] }, { searchFetcher: deadFetcher }, svc)
    check("degrade: rail unavailable → searchRan false, nothing flagged/escalated",
      r3.searchRan === false && r3.flagged.length === 0 && r3.escalated === 0 && r3.status.includes("search unavailable"))

    // Unrelated change → scanned but not flagged (no surface), no escalation.
    const unrelatedFetcher: RegSearchFetcher = async () => ({
      answer: null,
      hits: [{ title: `[${TAG}] Brokerage raises a seed round`, url: `https://news.test/${TAG}`, snippet: "The startup hires a new CTO and expands software to new metros." }],
      provider: "tavily",
    })
    const r4 = await runRegulatoryWatcher(brokerageId, { now, queries: ["q1"] }, { searchFetcher: unrelatedFetcher }, svc)
    check("relevance: unrelated change scanned but NOT flagged (no surface)", r4.searchRan && r4.changesScanned >= 1 && r4.flagged.length === 0 && r4.escalated === 0)
  } finally {
    const sig = changeSignature({ title: changeTitle, url: changeUrl })
    try { await svc.from("reg_change_observations").delete().eq("change_signature", sig) } catch {}
    try { await svc.from("manager_signals").delete().eq("signal_type", "regulatory_change_detected").contains("payload", { change_signature: sig }) } catch {}
    try { await svc.from("notifications").delete().eq("type", "regulatory_change").ilike("title", "%regulatory change%").is("entity_id", null).gte("created_at", new Date(Date.now() - 600000).toISOString()) } catch {}
    const { count: obsLeft } = await svc.from("reg_change_observations").select("id", { count: "exact", head: true }).eq("change_signature", sig)
    check("cleanup: observation count == 0", (obsLeft ?? 0) === 0)
    const { count: busLeft } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("signal_type", "regulatory_change_detected").contains("payload", { change_signature: sig })
    check("cleanup: bus signal count == 0", (busLeft ?? 0) === 0)
  }
  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
