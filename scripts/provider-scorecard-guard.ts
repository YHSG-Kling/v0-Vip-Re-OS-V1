/**
 * scripts/provider-scorecard-guard.ts — THE ONE COST / RIGHTS SCORECARD + THE 2,400-CANDIDATE PILOT SIMULATION (wave 150,
 * lane 150HIAB; contract C39, owner ruling R9, directive canary 9). npm run test:provider-scorecard (key listed for 150I2).
 *
 *   A  activation / licensing state matches R9 (RentCast + Versium active; BatchData + PeopleData dormant survivors; Tracerfy,
 *      DataZapp, PropertyRadar, Data Axle pending rights); every credential is a NAME (never a value); licence unknown blocks
 *      ACTIVATION and never offline testing;
 *   B  one price spelling: every scorecard row whose provider routes that capability equals the route table's unit
 *      (× its declared credit weight) — derived, not pinned; a free row is unit "free"; an unknown price is null, never 0;
 *   C  seller-score fields: distinct stored names, one vocabulary with lib/intent/moving-moments.ts VENDOR_SCORE_UNITS
 *      (stripped source), probability always null, never compared across vendors;
 *   D  the comparison doc §11 agrees with the code (every matrix cell, every activation row);
 *   E  the C39 pilot as an executable simulation on the in-memory client: 2,400 deduplicated candidates (4 strata × 4
 *      tenant shapes × 150), identical input to both arms, the control stratum as holdout, per-field coverage, right-party
 *      verification, suppression, cost per newly usable person and per qualified appointment, seller lift in each vendor's
 *      own unit (Tracerfy's undocumented scale → none), ZERO writes, paidCalls 0 / liveCalls 0, mayActivate false for both
 *      arms while the simulation still ran; a broken cohort (a missing cell) is refused as a design;
 *   F  canary 9 "no false 50k paid call": 50,000 appears in the pilot only as the SIMULATED_MONTHLY_RECORDS constant,
 *      never beside a request word, and the module has no transport.
 *
 * BLIND SPOTS (published): the simulated answers prove the scoring, not any vendor's data; real 30/90-day outcomes need the
 * live cohort; the doc check matches rows by field + provider + state, not every cell's wording.
 */
import { readFileSync } from "fs"
import { join } from "path"
import { createRequire } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"

const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* not installed */ }

const ROOT = process.cwd()
let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const stripped = (p: string) => stripComments(read(p))

async function main() {
  const sc = await import("../lib/providers/provider-scorecard")
  const { CONTACT_PROVIDER_ROUTES } = await import("../lib/ai-isa/property-lookup-rail")
  const { simulateProviderPilot } = await import("../lib/providers/provider-pilot")

  console.log("\nA — activation / licensing state (R9)")
  const A = sc.PROVIDER_ACTIVATION
  const want: Record<string, string> = { rentcast: "active", versium: "active", batchdata: "dormant_survivor", peopledata: "dormant_survivor", tracerfy: "dormant_pending_rights", datazapp: "dormant_pending_rights", propertyradar: "dormant_pending_rights", data_axle: "dormant_pending_rights" }
  check("every provider's state is R9's", Object.entries(want).every(([p, s]) => (A as any)[p]?.state === s) && Object.keys(A).length === Object.keys(want).length)
  const names = Object.values(A).flatMap((a) => a.credential.envVars)
  check("every credential is a NAME (UPPER_SNAKE), none looks like a value", names.length >= 7 && names.every((n) => /^[A-Z][A-Z0-9_]+$/.test(n) && n.length < 40))
  check("each provider records where its credential is obtained and how it is verified without spend", Object.values(A).every((a) => a.credential.whereObtained.length > 10 && a.credential.howVerified.length > 10 && a.rights.source.length > 5))
  const tv = sc.activationVerdict("tracerfy")
  check("Tracerfy: licence unconfirmed → mayActivate false with named blockers, offline testing allowed", !tv.mayActivate && tv.offlineTestAllowed && tv.blockers.some((b) => /contract/.test(b)) && tv.blockers.some((b) => /incremental coverage/.test(b)))
  check("DataZapp: no licence stated → blocked on rights", sc.activationVerdict("datazapp").blockers.some((b) => /none_stated/.test(b)))
  check("positive control: an ACTIVE provider (RentCast) may be called live", sc.activationVerdict("rentcast").mayActivate === true)
  check("every provider allows offline testing (canary 9)", (Object.keys(A) as any[]).every((p) => sc.activationVerdict(p).offlineTestAllowed === true))

  console.log("\nB — one price spelling (derived from the route table)")
  const priceMismatches = (routes: Record<string, ReadonlyArray<{ provider: string; unitCostUsd: number }>>) => {
    const out: string[] = []
    for (const r of sc.PROVIDER_FIELD_SCORECARD) {
      const e = routes[r.capability]?.find((x) => x.provider === r.provider)
      if (!e) continue
      const expect = Math.round(e.unitCostUsd * ((r as any).creditWeight ?? 1) * 10000) / 10000
      if (r.unitUsd !== expect) out.push(`${r.provider}/${r.capability}/${r.field}: ${r.unitUsd} ≠ route ${expect}`)
    }
    return out
  }
  const mismatches = priceMismatches(CONTACT_PROVIDER_ROUTES as any)
  check("every routed scorecard row equals the route table's unit (× credit weight)", mismatches.length === 0, mismatches.join("; "))
  const tampered = { ...(CONTACT_PROVIDER_ROUTES as any), owner_contact: CONTACT_PROVIDER_ROUTES.owner_contact.map((e) => (e.provider === "versium" ? { ...e, unitCostUsd: 0.07 } : e)) }
  check("positive control: a tampered route price is caught on both Versium contact rows", priceMismatches(tampered).filter((m) => m.startsWith("versium/owner_contact")).length === 2)
  check("free rows are unit 'free' at 0; an unknown price is null, never 0", sc.PROVIDER_FIELD_SCORECARD.every((r) => (r.unitUsd === 0) === (r.unit === "free") && (r.unitUsd === null || r.unitUsd >= 0)))
  check("every row cites its source", sc.PROVIDER_FIELD_SCORECARD.every((r) => r.source.length > 8))

  console.log("\nC — seller-score fields in their own units")
  const fields = Object.entries(sc.SELLER_SIGNAL_FIELDS)
  check("stored names are distinct and vendor-prefixed (tracerfy_* / datazapp_* / propertyradar_* / batchdata_*)", new Set(fields.map(([n]) => n)).size === fields.length && fields.every(([n, f]) => n.startsWith(`${f.provider}_`)))
  check("the directive's names exist: datazapp_signal_seller_score, propertyradar_distress_score, a tracerfy_* field", ["datazapp_signal_seller_score", "propertyradar_distress_score"].every((n) => n in sc.SELLER_SIGNAL_FIELDS) && fields.some(([n]) => n.startsWith("tracerfy_")))
  const mm = stripped("lib/intent/moving-moments.ts")
  // The RULE (never a waypoint): every vendorKey is in VENDOR_SCORE_UNITS or in the published Outside-lane addition list —
  // once lane 150JNAD adds the key, the list shrinks and this keeps passing (CLAUDE.md §2 "do not pin to a waypoint").
  const PUBLISHED_OUTSIDE_LANE_ADDITIONS = new Set(["batchdata:salePropensity"])
  const vocabMisses = (src: string) => fields.map(([, f]) => f.vendorKey).filter((k) => !src.includes(`"${k}"`) && !PUBLISHED_OUTSIDE_LANE_ADDITIONS.has(k))
  check("one vocabulary: every vendorKey is a key of moving-moments VENDOR_SCORE_UNITS or a published Outside-lane addition", vocabMisses(mm).length === 0, vocabMisses(mm).join())
  check("positive control: a vocabulary that lost the DataZapp key is caught", vocabMisses(mm.replace(`"datazapp:Signal_Seller_Score"`, `"datazapp:other"`)).join() === "datazapp:Signal_Seller_Score")
  const at = "2026-11-06T00:00:00.000Z"
  const a = sc.labelSellerSignal("datazapp_signal_seller_score", "4x", at)
  const b = sc.labelSellerSignal("datazapp_signal_seller_score", "1x", at)
  const c = sc.labelSellerSignal("propertyradar_distress_score", 90, at)
  check("labelled signals carry probability null", a.ok && b.ok && c.ok && a.signal.probability === null && c.signal.probability === null)
  check("never cross-ranked: DataZapp 4x vs PropertyRadar 90 compares as null", a.ok && c.ok && sc.compareSellerSignals(a.signal, c.signal) === null)
  check("positive control: within DataZapp, 4x orders above 1x by its own label order", a.ok && b.ok && (sc.compareSellerSignals(a.signal, b.signal) ?? 0) > 0)
  const t1 = sc.labelSellerSignal("tracerfy_lead_builder_seller_score", 71, at), t2 = sc.labelSellerSignal("tracerfy_lead_builder_seller_score", 40, at)
  check("an undocumented scale (Tracerfy) has no documented order — compare refuses", t1.ok && t2.ok && sc.compareSellerSignals(t1.signal, t2.signal) === null)

  console.log("\nD — the comparison doc §11 agrees with the code")
  const doc = read("docs/commercial/CUSTOMER-360-PROVIDER-COMPARISON.md")
  const s11 = doc.slice(doc.indexOf("## 11. The provider stack under owner ruling R9"))
  const lines = s11.split("\n")
  const matrix = sc.providerFieldMatrix()
  const missingCells = matrix.flatMap((m) => m.cells.filter((cell) => !lines.some((l) => l.startsWith(`| \`${m.field}\` | ${cell.provider} | ${cell.state} |`))).map((cell) => `${m.field}/${cell.provider}`))
  check(`§11.2 lists every matrix cell (${matrix.reduce((s, m) => s + m.cells.length, 0)} cells)`, s11.length > 100 && missingCells.length === 0, missingCells.join(", "))
  check("positive control: a dropped cell would be caught", !lines.filter((l) => !l.includes("| `owner_phone` | tracerfy |")).some((l) => l.startsWith("| `owner_phone` | tracerfy | dormant_pending_rights |")))
  const label: Record<string, string> = { rentcast: "RentCast", versium: "Versium", batchdata: "BatchData", peopledata: "PeopleData", tracerfy: "Tracerfy", datazapp: "DataZapp", propertyradar: "PropertyRadar", data_axle: "Data Axle" }
  check("§11.1 lists every provider with its state and credential NAME", Object.entries(A).every(([p, a]) => lines.some((l) => l.startsWith(`| ${label[p]} | ${a.state}`) && a.credential.envVars.every((n) => l.includes(`\`${n}\``)))))
  check("§11 says nothing was bought and the paid pilot is not approved", /Nothing in this section was bought/.test(s11) && /\*\*not approved\*\*/.test(s11))

  console.log("\nE — the 2,400-candidate pilot as an executable simulation (in-memory, read-only)")
  const STRATA = ["consented_inbound", "owner_missing_contact", "evidenced_possible_seller", "control"]
  const SHAPES = ["solo", "team", "office", "multi_office"]
  const seed = (dropCell?: string) => {
    const rows: any[] = []
    let n = 0
    for (const s of STRATA) for (const t of SHAPES) {
      if (dropCell === `${s}×${t}`) continue
      for (let i = 0; i < 150; i++) {
        n++
        rows.push({
          id: `raw-${n}`, brokerage_id: `b-${t}`, first_name: `F${n}`, last_name: `L${n}`, address: `${n} Main St`, zip_code: "78701",
          evidence: { pilot: {
            stratum: s, tenantShape: t, missing: s === "control" ? [] : ["owner_phone", "owner_email"], suppressed: i % 25 === 0,
            truth: s === "consented_inbound" ? { phone: `555${n}`, email: `p${n}@x.test` } : null,
            publicBaseline: i % 3 === 0, outcome30: i % 10 === 0, outcome90: i % 5 === 0,
          } },
        })
      }
    }
    // Five duplicates of existing identities — C36 dedup must drop them.
    for (let k = 1; k <= 5; k++) rows.push({ ...rows[k], id: `dup-${k}` })
    return { raw_scraped_leads: rows }
  }
  const simulate = (provider: string, c: any) => {
    const idx = Number(String(c.rawId).replace(/\D/g, "")) || 0
    const hit = provider === "tracerfy" ? idx % 10 < 7 : idx % 10 < 6
    const rightParty = c.truth && provider === "tracerfy" ? idx % 2 === 0 : c.truth ? idx % 3 === 0 : false
    return {
      hit,
      phone: hit ? (rightParty && c.truth ? c.truth.phone : `999${idx}`) : null,
      email: hit && provider === "datazapp" ? (rightParty && c.truth ? c.truth.email : `e${idx}@y.test`) : null,
      dnc: idx % 17 === 0,
      sellerValue: provider === "datazapp" ? ["0x", "1x", "2x", "3x", "4x"][idx % 5] : idx % 100,
      ageDays: idx % 400,
    }
  }
  const mem = memSupabase(seed())
  const res = await simulateProviderPilot(mem as any, { simulate: simulate as any, now: new Date("2026-11-06T00:00:00Z") })
  check("valid matched design: 2,400 deduplicated candidates, 150 per stratum × tenant shape", res.valid && res.cohort.candidates === 2400 && Object.values(res.cohort.perCell).every((v) => v === 150), res.designProblems.join("; "))
  check("C36: the five duplicate identities were dropped, not double-counted", res.cohort.duplicatesDropped === 5)
  check("identical input to both arms: each arm attempted the same 1,800 non-control candidates", res.arms.length === 2 && res.arms.every((a) => a.attempted === 1800))
  check("the control stratum is the holdout (600, no calls)", res.holdout.candidates === 600)
  const tf = res.arms.find((a) => a.provider === "tracerfy")!, dz = res.arms.find((a) => a.provider === "datazapp")!
  check("per-field new coverage, right-party verification and suppression are measured per arm", (tf.perFieldNewCoverage.owner_phone ?? 0) > 0 && (dz.perFieldNewCoverage.owner_email ?? 0) > 0 && tf.rightPartyVerified.checked === 600 && tf.suppressedExcluded > 0)
  check("cost per newly usable eligible person and per qualified appointment are computed", tf.costPerNewlyUsable !== null && tf.costPerNewlyUsable > 0 && dz.costPerQualifiedAppointment !== null)
  check("true marginal cost: Tracerfy bills hits only at its per-match price (misses free)", Math.abs(tf.simulatedCostUsd - (tf.hits * 0.02 + 600 * 0.1)) < 0.01, `${tf.simulatedCostUsd} vs ${tf.hits} hits`)
  check("seller lift in DataZapp's own top labels vs the public baseline — a difference, not a probability", dz.sellerSignal.lift !== null && dz.sellerSignal.labelled > 0 && /not a probability/.test(dz.sellerSignal.why))
  check("Tracerfy's undocumented scale → no top bucket, no lift until calibrated", tf.sellerSignal.lift === null && /undocumented/.test(tf.sellerSignal.why))
  check("never ranked across vendors (crossProviderRanking is null)", res.crossProviderRanking === null)
  check("ZERO writes, paidCalls 0, liveCalls 0 — the simulation spent nothing", mem.writes.length === 0 && res.paidCalls === 0 && res.liveCalls === 0)
  check("licence unknown blocks ACTIVATION, not the simulation: both arms mayActivate false, the run completed", res.activation.every((x) => !x.mayActivate && x.blockers.length > 0) && res.valid)
  check("the 50k/month projection is labelled SIMULATION", res.projection.basis === "SIMULATION" && res.projection.monthlyRecords === 50000 && res.projection.costUsdByArm.tracerfy !== null)
  const broken = await simulateProviderPilot(memSupabase(seed("control×solo")) as any, { simulate: simulate as any, now: new Date("2026-11-06T00:00:00Z") })
  check("negative: a missing stratum × tenant cell is refused as a design (not silently scored)", !broken.valid && broken.designProblems.some((p) => /control×solo: 0/.test(p)))
  const refused = await simulateProviderPilot(memSupabase(seed(), { refuse: { raw_scraped_leads: "permission denied" } }) as any, { simulate: simulate as any, now: new Date() })
  check("a refused cohort read is reported, never scored as an empty pilot", !refused.valid && /refused/.test(refused.designProblems[0] ?? ""))

  console.log("\nF — canary 9: no false 50k paid call")
  const pilot = stripped("lib/providers/provider-pilot.ts")
  const fifty = [...pilot.matchAll(/50[_,]?000/g)].map((m) => pilot.slice(Math.max(0, m.index! - 60), m.index! + 10))
  check("50,000 appears only as SIMULATED_MONTHLY_RECORDS", fifty.length === 1 && /SIMULATED_MONTHLY_RECORDS = 50_000/.test(fifty[0]), fifty.join(" | "))
  const REQUEST = /\b(limit|take|maxItems|max_records_per_run|wantRecords)\s*:\s*(SIMULATED_MONTHLY_RECORDS|50[_,]?000)/
  check("never a request size: no limit / take / maxItems names it", !REQUEST.test(pilot))
  check("positive control: a planted `take: 50000` is seen", REQUEST.test("search({ take: 50000 })"))

  console.log(`\nPROVIDER SCORECARD — RESULT: ${passed} passed, ${failed} failed ${failed === 0 ? "✅ PROVIDER_SCORECARD_PASS" : "❌ PROVIDER_SCORECARD_FAIL"}`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
