#!/usr/bin/env tsx
/**
 * scripts/writerless-gate-simulator.ts   (npm run test:writerless-gate)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 13 / LANE P — ALWAYS-NULL READS: the four columns a gate or a money
 * surface branched on that NOTHING in the tree ever wrote, and the four parser
 * blind spots that were ACCUSING live writers of the same crime.
 *
 * THE FOUR REAL ONES (the value now ARRIVES):
 *
 *   1. voice_calls.compliance_passed — GATE. Declared `DEFAULT true`, written by
 *      nobody, rendered as a green shield by three surfaces. Every call on every
 *      lane displayed "compliance passed" having been checked by no one, and the
 *      red `=== false` branch was unreachable. Now written by
 *      lib/voice/twilio-outbound.ts:placeOutboundAiCall — reached only past the
 *      full pre-dial stack (autonomy → suppression/DNC → TCPA consent + quiet
 *      hours → de-conflict → budget) — and m510 drops the default so a lane with
 *      no gate says NOTHING instead of claiming a pass.
 *
 *   2. approved_content_library.expires_at — GATE. The nightly compliance cron
 *      deactivates approved content by `expires_at < now()`. The reviewer's
 *      `expiresInDays` was folded into an activity metadata blob and the column
 *      was never written, so a 30-day approval never expired. Two silent
 *      defects in the same insert: brokerage_id (NOT NULL) was not named at all
 *      — PostgREST refuses the row ENTIRELY — and created_by (FK users) was
 *      handed a BROKERAGE id.
 *
 *   3+4. offer_comparison.ai_recommendation / .ai_analysis_notes — MONEY-
 *      DECISION. Both doors onto the comparison (the agent's offers manager and
 *      the seller's portal) read them; the analyzer produced the recommendation,
 *      returned it to its caller and persisted nothing.
 *
 * THE FOUR BLIND SPOTS (the census was accusing live writers):
 *   · `.insert(rows.map((r) => ({…})))` — contiguousChain stops at a callback,
 *     so the write was INVISIBLE, not opaque: 90 findings, including every money
 *     column of the brokerage P&L.
 *   · A patch object built by assignment (`update.allowed_domains = …`) — 12,
 *     including the embed loader's ORIGIN ALLOWLIST.
 *   · A computed key (`{ [column]: total }`) — 5, the whole billing meter.
 *   · A column seeded by an applied .sql — 32, every per-tier plan LIMIT.
 *
 * LAYERS
 *   STATIC   — each writer's PostgREST object is parsed with the repo's ONE
 *              parser (schema-drift-guard) and must now name the column, and the
 *              column must exist in the live schema snapshot (a phantom name
 *              refuses the whole statement, PGRST204 — a "writer" that names one
 *              writes nothing).
 *   GATE     — the migration removes the default that asserted an unrun check,
 *              and the readers still distinguish pass / fail / not-checked.
 *   CENSUS   — the census itself is re-run: every positive control passes, the
 *              four columns are GONE from class 1b, and the four blind-spot
 *              shapes are no longer accused. Slow (~2 min) and deliberately so:
 *              a static assertion about a scanner is not a proof of the scanner.
 *              Skip with WRITERLESS_GATE_SKIP_CENSUS=1.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { blankComments } from "./strip-comments"
import { readCapProgress, pickCapWindow } from "../lib/finance/cap-progress"

process.env.SCHEMA_DRIFT_AS_LIBRARY = "1"
const sd = await import("./schema-drift-guard")

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

/**
 * The keys of the write object at a `.from("<table>").<op>({ … })` site, read
 * with the shared parser rather than a regex of this file's own — two parsers
 * that disagree about what a write is would make this proof worthless.
 * Returns null when no such site exists, which is itself a finding.
 */
function writeKeysAt(file: string, table: string, op: "insert" | "update" | "upsert"): string[] | null {
  const text = blankComments(src(file))
  const re = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)[\\s\\S]{0,400}?\\.${op}\\(\\s*\\{`, "g")
  const m = re.exec(text)
  if (!m) return null
  const brace = m.index + m[0].length - 1
  const close = sd.matchBrace(text, brace)
  if (close <= brace) return null
  return sd.parseObjectTopLevelKeys(text.slice(brace, close + 1))
}

/** A column that is not in the live schema refuses the WHOLE statement (PGRST204). */
const isLiveColumn = (table: string, col: string) => (SCHEMA_SNAPSHOT[table] ?? []).includes(col)

function staticLayer() {
  console.log("\n[STATIC — the write object now names the column, and the column is real]")

  // ── 1. voice_calls.compliance_passed ─────────────────────────────────────
  const voice = writeKeysAt("lib/voice/twilio-outbound.ts", "voice_calls", "insert")
  check("voice_calls insert exists and is parseable", voice !== null)
  check("voice_calls.compliance_passed is WRITTEN by placeOutboundAiCall",
    !!voice?.includes("compliance_passed"), (voice ?? []).join(","))
  check("…and compliance_passed is a live voice_calls column (not a PGRST204 phantom)",
    isLiveColumn("voice_calls", "compliance_passed"))
  check("voice_calls.compliance_flags is written beside the verdict ([] = ran and raised nothing)",
    !!voice?.includes("compliance_flags") && isLiveColumn("voice_calls", "compliance_flags"))
  // The stamp is only honest BECAUSE the gate stack runs first and short-circuits.
  const outbound = blankComments(src("lib/voice/twilio-outbound.ts"))
  const gateIdx = outbound.indexOf("runOutboundCallGates")
  const insertIdx = outbound.indexOf('.from("voice_calls").insert')
  check("the gate stack runs BEFORE the row is written (a stamp past a refusal is a lie)",
    gateIdx > -1 && insertIdx > -1 && gateIdx < insertIdx)
  check("a refusal short-circuits, so an ungated call never reaches the stamp",
    /if\s*\(\s*refusal\s*\)\s*return\s+refusal/.test(outbound))

  // ── 2. approved_content_library.expires_at ───────────────────────────────
  const lib = writeKeysAt("lib/application/compliance-monitoring.ts", "approved_content_library", "insert")
  check("approved_content_library insert exists and is parseable", lib !== null)
  check("approved_content_library.expires_at is WRITTEN by the reviewer",
    !!lib?.includes("expires_at"), (lib ?? []).join(","))
  check("…and the NOT NULL tenant column is named (its absence refused the whole row)",
    !!lib?.includes("brokerage_id"))
  for (const c of ["expires_at", "brokerage_id", "created_by"]) {
    check(`…approved_content_library.${c} is a live column`, isLiveColumn("approved_content_library", c))
  }
  const cm = blankComments(src("lib/application/compliance-monitoring.ts"))
  check("created_by carries the REVIEWER's users id, not the brokerage id (disjoint spaces)",
    /created_by:\s*data\.reviewerId/.test(cm) && !/created_by:\s*approval\.brokerage_id/.test(cm))
  check("the expiry is derived from expiresInDays, not invented",
    /data\.expiresInDays[\s\S]{0,200}86_400_000/.test(cm))
  check("a refused library write is REPORTED, never swallowed",
    /libraryError[\s\S]{0,300}throw new Error/.test(cm))
  // The reader this feeds: the nightly sweep deactivates by expires_at.
  const cron = blankComments(src("app/api/cron/compliance-monitoring/route.ts"))
  check("the sweep that consumes expires_at still exists and still deactivates",
    /approved_content_library[\s\S]{0,200}\.lt\(\s*"expires_at"/.test(cron) &&
    /approved_content_library"\)\.update\(\{\s*is_active:\s*false/.test(cron))

  // ── 3+4. offer_comparison AI verdict ─────────────────────────────────────
  const cmp = writeKeysAt("lib/offers/offer-analyzer.ts", "offer_comparison", "insert")
  check("offer_comparison insert exists in the ONE analyzer both paths delegate to", cmp !== null)
  for (const c of ["ai_recommendation", "ai_analysis_notes", "offer_ids", "comparison_matrix", "net_to_seller_by_offer", "recommended_offer_id"]) {
    check(`offer_comparison.${c} is WRITTEN`, !!cmp?.includes(c), (cmp ?? []).join(","))
    check(`…offer_comparison.${c} is a live column`, isLiveColumn("offer_comparison", c))
  }
  const analyzer = blankComments(src("lib/offers/offer-analyzer.ts"))
  check("agent_id is RESOLVED users→agents, never substituted (the columns FK different tables)",
    /resolveAgentIdInBrokerage\(\s*supabase,\s*agentUserId,\s*brokerageId\s*\)/.test(analyzer) &&
    /created_by:\s*agentUserId/.test(analyzer))
  check("the model's recommended offer is VALIDATED against the offers compared (an FK it invents refuses the row)",
    /comparedIds\.has\(id\)/.test(analyzer))
  check("a refused comparison write is reported, not silent",
    /comparisonError[\s\S]{0,200}console\.error/.test(analyzer))
  // Both readers of the columns still read them.
  check("the AGENT's door reads ai_recommendation + ai_analysis_notes",
    /offer_comparison[\s\S]{0,400}ai_recommendation,\s*ai_analysis_notes/.test(blankComments(src("app/actions/seller-offers.ts"))))
  check("the SELLER's door reads ai_recommendation",
    /offer_comparison[\s\S]{0,400}ai_recommendation/.test(blankComments(src("app/actions/portal-seller.ts"))))
}

function capLayer() {
  console.log("\n[MONEY — the cap the goal-setter priced at 'Unknown' now arrives, through ONE reading]")
  const rollup = blankComments(src("app/api/cron/earnings-rollup/route.ts"))
  check("the earnings rollup reads the cap LEDGER (agent_cap_tracking), not a second guess",
    /\.from\("agent_cap_tracking"\)/.test(rollup))
  check("agent_earnings.cap_status + .cap_progress_pct are WRITTEN by the rollup",
    /cap_status:\s*cap\.status/.test(rollup) && /cap_progress_pct:\s*cap\.pct/.test(rollup))
  for (const c of ["cap_status", "cap_progress_pct"]) {
    check(`…agent_earnings.${c} is a live column`, isLiveColumn("agent_earnings", c))
  }
  check("the cap window in force TODAY is picked, not whatever row came back",
    /pickCapWindow\(/.test(rollup))

  // PURE — the reading itself, both directions.
  const below = readCapProgress({ cap_amount: 100_000, cap_paid_to_date: 25_000 })
  check("below the cap → below_cap at the real percentage", below.status === "below_cap" && below.pct === 25)
  const at = readCapProgress({ cap_amount: 100_000, cap_paid_to_date: 100_000 })
  check("cap met → at_cap", at.status === "at_cap" && at.pct === 100)
  const flagged = readCapProgress({ cap_amount: 100_000, cap_paid_to_date: 40_000, is_capped: true })
  check("the ledger's own is_capped verdict wins over the arithmetic", flagged.status === "at_cap")
  const uncapped = readCapProgress({ cap_amount: 0, cap_paid_to_date: 12_000 })
  check("NO cap → NULL status and NULL percent (never 'below_cap', never NaN%)",
    uncapped.status === null && uncapped.pct === null)
  check("a missing ledger row is uncapped, not zero-progress-capped",
    readCapProgress(null).status === null && readCapProgress(null).pct === null)
  const vocabulary = ["below_cap", "at_cap", "post_cap"]
  check("every status this can emit is inside the live CHECK vocabulary",
    [below, at, flagged].every((r) => r.status !== null && vocabulary.includes(r.status)))
  check("the window containing today is preferred over a stale one",
    pickCapWindow([
      { cap_amount: 1, cap_paid_to_date: 0, anniversary_start: "2000-01-01", anniversary_end: "2000-12-31" },
      { cap_amount: 2, cap_paid_to_date: 0, anniversary_start: "2020-01-01", anniversary_end: "2999-12-31" },
    ])?.cap_amount === 2)

  // ONE formula: the kernel summary must not keep its own.
  const fin = blankComments(src("lib/kernel/financial.ts"))
  check("lib/kernel/financial.ts shares the reading instead of dividing inline",
    /readCapProgress\(capData\)/.test(fin) && !/cap_paid_to_date\s*\/\s*capData\.cap_amount/.test(fin))
}

function gateLayer() {
  console.log("\n[GATE — the default that asserted an unrun check is removed, and the readers still branch three ways]")
  const mig = "supabase/migrations/m510-a-call-nobody-checked-must-not-claim-it-passed-compliance.sql"
  check("m510 exists", existsSync(join(process.cwd(), mig)))
  const sql = existsSync(join(process.cwd(), mig)) ? src(mig) : ""
  check("m510 drops the default on voice_calls.compliance_passed",
    /alter\s+column\s+compliance_passed\s+drop\s+default/i.test(sql))
  check("m510 does NOT flip the default to false (the opposite lie)",
    !/compliance_passed\s+set\s+default\s+false/i.test(sql))
  check("m510 refuses to pass if the default survives (an AFTER assertion, not a hope)",
    /raise\s+exception[\s\S]{0,200}still carries a default/i.test(sql))
  check("m510 does not backfill a verdict it cannot re-derive",
    !/update\s+public\.voice_calls\s+set\s+compliance_passed/i.test(sql))

  // NULL must read as "not checked" — never as a pass and never as a failure.
  const table = src("app/components/dashboard/voice/VoiceCallHistoryTable.tsx")
  check("the call-history badge distinguishes pass / fail / NOT CHECKED",
    /compliance_passed === true/.test(table) && /compliance_passed === false/.test(table) && /—/.test(table))
  const tenantLog = src("app/dashboard/superadmin/tenant-calls/page.tsx")
  check("the superadmin log's red flag is the `=== false` branch it exists for",
    /c\.compliance_passed === false/.test(tenantLog))
}

function censusLayer() {
  console.log("\n[CENSUS — re-run the instrument itself: controls green, the four columns gone, the four blind spots un-accused]")
  if (process.env.WRITERLESS_GATE_SKIP_CENSUS === "1") {
    console.log("  … skipped (WRITERLESS_GATE_SKIP_CENSUS=1)")
    return
  }
  let out = ""
  try {
    out = execFileSync("npx", ["tsx", "scripts/opposite-missing-census.ts", "--list"], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000,
    })
  } catch (e: any) {
    out = `${e?.stdout ?? ""}${e?.stderr ?? ""}`
  }
  const controls = out.match(/\[positive controls\]\s+(\d+)\/(\d+)/)
  check("the census ran and reported its controls", !!controls, out.slice(0, 400))
  check("EVERY positive control passes (a blind scanner's zero is a lie, not a pass)",
    !!controls && controls[1] === controls[2], controls ? `${controls[1]}/${controls[2]}` : "—")

  const oneB = out.split("── 1b.")[1]?.split("── 2.")[0] ?? ""
  // WHY THIS CHECK CARRIES A DIAGNOSIS NOW.
  //
  // An EMPTY oneB makes every `!oneB.includes(col)` assertion below pass
  // VACUOUSLY — an empty string contains nothing, so "1b no longer accuses X"
  // reads green for all four columns while the section was never examined. That
  // is the false-green this trio of controls exists to catch, and it works.
  //
  // What it did NOT do is say WHICH failure happened. Running inside the full
  // guard chain the census subprocess emitted its `[positive controls]` line and
  // then stopped before the section listings — so the controls above passed, the
  // section was missing, and the reported diagnosis was "the scanner did not go
  // blind", which is the opposite of the truth: the scanner was fine (171 entries
  // standalone, and this file passes 86/0 both plain and with the chain's
  // NODE_OPTIONS), the subprocess output was truncated. Someone reading that
  // message would go looking for a blinded parser that does not exist.
  //
  // So distinguish the two. A truncated run is an infrastructure problem to
  // re-run (§8's shape); an empty section from a complete run is a real finding.
  const censusLooksComplete = out.includes("TOTAL") && out.includes("── 2.")
  check("the 1b section was printed", oneB.length > 0,
    oneB.length > 0 ? undefined
      : censusLooksComplete
        ? "census output is COMPLETE and 1b is genuinely empty — investigate the scanner"
        : "census output is TRUNCATED (no TOTAL / no section 2 header) — the subprocess did not "
          + "finish, so this is not evidence about the scanner. Re-run; if it repeats at the same "
          + "commit, the census is dying under chain memory pressure and that is the finding.")

  // The four that were really writerless — the value now arrives.
  for (const col of [
    "voice_calls.compliance_passed",
    "approved_content_library.expires_at",
    "offer_comparison.ai_recommendation",
    "offer_comparison.ai_analysis_notes",
  ]) {
    check(`1b no longer accuses ${col} (the writer exists now)`, !oneB.includes(col))
  }

  // The four blind-spot shapes — live writers that were being accused.
  const falselyAccused: Array<[string, string]> = [
    ["brokerage_earnings.gross_commission_income", "inline row mapper (lib/finance/brokerage-earnings-writer.ts:76)"],
    ["brokerage_earnings.brokerage_net", "inline row mapper"],
    ["property_alert_results.match_score", "inline row mapper (lib/property-alerts/alert-engine.ts:118)"],
    ["income_gap_recommended_actions.estimated_gci_impact_cents", "inline row mapper (app/actions/income-engine.ts:164)"],
    ["embed_widgets.allowed_domains", "patch-object builder (app/actions/embed-widgets.ts:216)"],
    ["embed_widgets.enabled_modes", "patch-object builder"],
    ["billing_usage.ai_calls_count", "computed key (lib/kernel/billing.ts:592)"],
    ["billing_usage.scraper_calls", "computed key"],
    ["plan_limits.limit_value", "applied .sql seed"],
    ["feature_flags.solo_agent_limit", "applied .sql seed (scripts/*.sql)"],
    ["remotion_compositions.is_active", "applied .sql seed"],
  ]
  for (const [col, why] of falselyAccused) {
    check(`1b no longer accuses ${col} — ${why}`, !oneB.includes(col))
  }

  // The instrument must still SEE a genuine one, or the burn-down above is just
  // a scanner that went blind in a new way.
  //
  // ── REWRITTEN, WAVE 18: IT WAS TWO WAYPOINTS AND ONE OF THEM NEVER RAN ─────
  //
  // This assertion used to read
  //     /1b\. COLUMN read by code, written by NOBODY \((\d+)\)/.test(oneB.slice(0,200))
  //     || oneB.split("\n").filter(l => /\.\w+$/.test(l.trim())).length > 50
  // and BOTH halves were defective.
  //
  // The first half could never be true. `oneB` is produced by splitting on the
  // literal "── 1b." above, which CONSUMES the "1b." the regex then looks for —
  // so the section always begins " COLUMN read by code…" and the pattern never
  // matched, in any wave. The whole check rested on the second half alone, and
  // nothing said so.
  //
  // The second half was a hardcoded 50 — a waypoint (CLAUDE.md §2). It asserted
  // "there are still MORE THAN FIFTY unfixed writerless reads", which is a
  // sentence that can only stay true while the burn-down fails. Wave 18 took 1b
  // from 110 to 31 and this line went red for the one reason it must never go
  // red: the work got done.
  //
  // What the check is FOR is unchanged and worth keeping: a scanner that has
  // gone blind reports zero, and a zero reads exactly like a finished burn-down.
  // So assert the RULE and DERIVE the number. The section states its own count;
  // the entries are countable; a section that is present, non-empty, and whose
  // printed count matches the entries under it cannot be a silent truncation or
  // a blind pass — and it stays true at 31, at 3, and at any number above zero.
  const declared1b = Number(/^\s*COLUMN read by code, written by NOBODY \((\d+)\)/
    .exec(oneB)?.[1] ?? -1)
  const listed1b = oneB.split("\n").filter((l) => /^\s+\S+\.\S+$/.test(l.split("  ")[0] ?? "")
    || /\b\w+\.\w+$/.test(l.trim())).length
  check("1b still reports genuine writerless reads (the scanner did not go blind)",
    declared1b > 0 && listed1b >= declared1b,
    `declared ${declared1b} · listed ${listed1b}`)
  for (const col of ["agent_earnings.cap_status", "agent_earnings.cap_progress_pct", "document_checklist.status"]) {
    check(`1b no longer accuses ${col}`, !oneB.includes(col))
  }
  // The scanner must still SEE genuine ones, or this burn-down is just a new
  // kind of blindness — so one REAL writerless read is named as a canary.
  //
  // ── CANARY REPOINTED, WAVE 14 ──────────────────────────────────────────────
  // This used to name `lead_intelligence.pre_approved`, chosen here because wave
  // 13 deliberately did not build it. Wave 14 lane T DID build it: the fact the
  // derivation needed turned out to exist and to be written four times over
  // (contacts.lender_status, plus buyer_financial_profiles for the amount), and
  // the +30 intent branch it gated now fires. See lib/leads/pre-approval.ts for
  // the derivation and its evidence, and scripts/writerless-arrivals-simulator.ts
  // for the proof that the score moves.
  //
  // So the canary MOVED rather than being deleted — deleting it would have left
  // this census layer unable to tell a burn-down from a blindness.
  //
  // ── CANARY REPOINTED AGAIN, WAVE 18 — AND SAYING SO, AS INSTRUCTED ────────
  // Wave 17 named `ad_creative_variations.destination_url` and wrote: "If this
  // line ever goes green, either that gap was closed (repoint the canary again,
  // and say so) or the scanner went blind." It went green, and it was the FIRST
  // of those: wave 18 built the writer. lib/ads/ad-destination.ts resolves a
  // listing's published landing page, falls back to the advertiser's own site on
  // the brand ladder, and is wired into both producers
  // (lib/ads/listing-ad-producer.ts:176, lib/ads/ad-creator.ts:323). Ads no
  // longer launch pointing at nothing.
  //
  // The replacement is `calendar_sync_mappings.provider_account_id`, chosen
  // because it is the most DURABLE unfixed entry on the list rather than the
  // most convenient — a canary that a routine burn-down retires next month
  // teaches nothing. It cannot be built until the calendar provider adapter
  // exists: `provider_event_id` on that table is text NOT NULL with no default
  // and no trigger, and it holds the provider's own id for the event, which is
  // the one fact this repo cannot know while the adapter is disabled. The module
  // already records that state honestly (status 'partial', error_message
  // "Provider adapter not enabled"), and lib/kernel/calendar-sync.ts:176 carries
  // a do-not-"fix"-this note explaining why fabricating a row would make
  // `is_synced` meaningless. Same protocol as before: if this goes green, either
  // the adapter landed (repoint, and say so) or the scanner went blind.
  check("1b still reports a genuine writerless read no lane has fixed",
    oneB.includes("calendar_sync_mappings.provider_account_id"))
  // The nine this wave's sibling lane closed must be GONE — the same list its own
  // proof asserts, checked here too so the two simulators cannot drift apart.
  for (const col of [
    "lead_intelligence.pre_approved",
    "lead_intelligence.pre_approval_amount",
    "lead_intelligence.financial_readiness",
    "agent_api_credentials.api_secret",
    "integration_credentials.api_secret",
    "compliance_alerts.resolved",
    "comp_risk_flags.is_resolved",
    "approval_items.item_id",
    "listing_agreements.seller_transaction_fee",
  ]) {
    check(`1b no longer accuses ${col} (wave 14 lane T built the writer)`, !oneB.includes(col))
  }
}

function main() {
  staticLayer()
  capLayer()
  gateLayer()
  censusLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ WRITERLESS_GATE_FAIL"); process.exit(1) }
  console.log(" ✅ WRITERLESS_GATE_PASS — the compliance stamp, the approval expiry and the offer verdict now ARRIVE; the four parser blind spots no longer accuse live writers")
}
main()
