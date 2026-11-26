/**
 * scripts/provider-gap-matrix-guard.ts — PROVIDER SELECTION BY FUNCTION, COST AND LICENSE (wave 151, lane 151G).
 * npm run test:provider-gap-matrix
 *
 * Owner (2026-11-09): "this platform os has not been released yet nor providers picked so that needs to be decided by pricing,
 * capabilities and use license"; "sold properties can also come from another source but RentCast has sold properties because
 * market data is a capability of RentCast if the tenant doesn't have a connected IDX provider"; "buyer criteria is for our
 * buyers and we show them property listings (besides the tenant's listings) which they can save and share to their family".
 *
 *   A  THE DOC IS THE CODE — every generated block of docs/operations/PROVIDER-SELECTION-WAVE151.md equals what the constants
 *      render (`--write` regenerates the blocks; the prose outside the markers is hand-written); a planted changed cell is caught.
 *   B  RENTCAST DATA TYPES NEVER COLLAPSE — RENTCAST_DATA_TYPES keeps /properties sale history (recorded sales), /markets (ZIP
 *      LISTING statistics), /listings (listing records) and /avm/value comparables (listing records) DISTINCT: closed-sale
 *      evidence only on the /properties kinds, photo rights nowhere; the market twin labels a /markets reading listing_statistics
 *      (EXECUTED); the report research prints a RentCast comparable as last_list_price and upgrades it to recorded_sale ONLY when
 *      its own property record confirms a sale on / after the day it left the market (EXECUTED with injected deps; the OLD
 *      mapping is run as the positive control and would have printed recorded_sale); a stripped-source census of the
 *      market-report readers finds no line that reads `median_sale_price` into a sold label (planted line caught).
 *   C  THE BUYER SOURCE ORDER IS THE RULE — tenant_listing → idx_mls → rentcast_listing, spelled in the saved-home origin
 *      vocabulary; resolveListingSource EXECUTED (a connected IDX wins and is exclusive; RentCast only when IDX is absent); the
 *      engine reads in-house listings BEFORE the external router (stripped source); every RentCast row is a listing record with
 *      status provider_reported and NO photo (stripped source + a planted mutant); IDX rows are feed_active.
 *   D  ESTIMATES ARE COUNTS — the audience-estimate rows are free, grain audience, consumed as a COUNT; Versium's product matrix
 *      says NUMBER for the estimate and NOT TARGETING for Online Audience Append; no evaluation measure buys contacts from an estimate.
 *   E  NOTHING SELECTED OR ACTIVATED — PROVIDER_SELECTION_STATUS (selected null, nothing activated, no purchase, no credential,
 *      paid pilot not approved); every recommendation is waiting_owner, in the five-tier vocabulary and CONSISTENT with
 *      PROVIDER_ACTIVATION by rule (PRIMARY ⇒ active; GAP_FILL / DORMANT_BACKUP ⇒ dormant survivor; WAITING_LICENSE / UNNECESSARY
 *      ⇒ dormant pending rights, UNNECESSARY also unrouted) — a tampered recommendation is caught; the design spends nothing;
 *      the pilot / scorecard modules carry no transport (stripped source).
 *   F  NO PRICE LITERAL OUTSIDE A LABELLED VARIABLE — the projection body holds no price literal (its prices come from the
 *      scorecard; a planted `0.02` is caught); an unpublished unit leaves the total null; every dollar figure in the doc's PROSE
 *      sits on a line that labels it (ASSUMED / published / UNKNOWN / quoted / projection) — a planted bare figure is caught.
 *   G  LICENSE SPELLING — no British spelling in the doc or the lane's modules and proofs (planted word caught).
 *   H  THE COHORT DESIGN — seven disjoint cohorts (hard_identity assigned first), constants, a blinded sample share in (0,1),
 *      the directive's six questions each with a basis, explicit unknowns, the arms = R9's pair + the two dormant survivors.
 *   I  OWNERSHIP — the proof has an accountable manager (MAINTENANCE_DOMAINS.provider_gap_matrix).
 *   J  THE CAPABILITY MATRIX (wave 153, lane 153G — directive G1) — every provider G1 names has a thirteen-column row; every
 *      code anchor is a real DECLARATION in stripped, string-blanked source (an import or a tombstone is not one — controlled);
 *      every proof is registered and run by the chain; every honest state is RE-DERIVED here per route (no transport can never
 *      read simulated — controlled; nothing reads ready without live evidence); the tenant-owned column follows the rulings
 *      (built only where a transport takes a tenant key; RentCast and the scrapers stay platform-gated); Exa is both doors;
 *      Datafiniti is BUILT and awaits its license on both routes (wave 153, lane 153M); a count never claims contacts; every needle
 *      playbook is a real survivor.
 *   K  SOURCE-TO-BUSINESS (wave 154, lane 154J — directive J2–J6) — every row carries what it TRULY provides in one category
 *      vocabulary, docs, credential owner, four rights cells, territory, timestamps, three costs (scorecard costs DERIVED from
 *      published units; cost per usable record UNKNOWN for all), consumer, recovery and a REGISTERED manager — an UNKNOWN
 *      always carries its reason; no row is LIVE_VERIFIED and an activation state named "active" is not live (controlled);
 *      a transport / trend / discovery row provides no identity (controlled); J3 EXECUTED: no scraped source carries purchased
 *      identity (controlled), provider-first, and the planner's verdict names all nine inputs with configured weights read as
 *      configured and missing inputs named unknown; J4 Datafiniti license-held whatever the spend plan says; J5 EXECUTES
 *      routeChatter / trendIdea; J6 the pilot authorizes nothing, keeps three tracks apart, never shows a per-match price as an
 *      expected cost, and the stack is the smallest (an all-PRIMARY stack is refused — controlled).
 *
 * BLIND SPOTS (published): no vendor is called (every price is a published page figure or UNKNOWN; every hit rate ASSUMED); the
 * research execution proves the labelling, not RentCast's data; the engine's in-house-first order is read from stripped source,
 * not driven end to end; the doc check compares the GENERATED blocks byte for byte and the prose only for spelling and labelled
 * dollar figures.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"

const _require = createRequire(import.meta.url)
try { const so = _require.resolve("server-only"); _require.cache[so] = { id: so, filename: so, loaded: true, exports: {} } as any } catch { /* not installed */ }

const ROOT = process.cwd()
const DOC = "docs/operations/PROVIDER-SELECTION-WAVE151.md"
let passed = 0, failed = 0
function check(name: string, ok: boolean, detail = "") { if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) } }
const section = (t: string) => console.log(`\n[${t}]`)
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(raw(p))
const cell = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")
// An ANCHOR is a DECLARATION in stripped, string-blanked source — a tombstone, an import or a quoted name is not one (CLAUDE.md §2).
// (Hoisted from §J by wave 154, lane 154J so §K's status rows are judged by the SAME rule.)
function anchorProblem(a: { module: string; symbol: string } | null): string | null {
  if (!a) return null
  if (!existsSync(join(ROOT, a.module))) return `${a.module} does not exist`
  const s = blankStrings(code(a.module))
  return new RegExp(`\\b(?:function\\*?|const|let|var|class)\\s+${a.symbol.replace(/\$/g, "\\$")}\\b`).test(s) ? null : `${a.module} declares no ${a.symbol}`
}
const anchorOk = (a: { module: string; symbol: string }) => anchorProblem(a) === null

// ── the generated blocks ─────────────────────────────────────────────────────
type Renderers = Record<string, () => string>

async function renderers(): Promise<Renderers> {
  const sc = await import("../lib/providers/provider-scorecard")
  const pilot = await import("../lib/providers/provider-pilot")
  const { CONTACT_PROVIDER_ROUTES } = await import("../lib/ai-isa/property-lookup-rail")
  const { TENANT_ACQUISITION_PROVIDERS } = await import("../lib/providers/tenant-provider-connections")
  const { VERSIUM_PRODUCT_MATRIX, VERSIUM_REACH_MCP } = await import("../lib/external/versium-client")
  const els = await import("../lib/property/external-listings-search")
  const cm = await import("../lib/providers/provider-capability-matrix")
  const label: Record<string, string> = { rentcast: "RentCast", versium: "Versium", batchdata: "BatchData", peopledata: "PeopleData", tracerfy: "Tracerfy", datazapp: "DataZapp", propertyradar: "PropertyRadar", data_axle: "Data Axle" }
  const providers = Object.keys(sc.PROVIDER_ACTIVATION) as Array<keyof typeof sc.PROVIDER_ACTIVATION>
  const routesNaming = (p: string) => Object.entries(CONTACT_PROVIDER_ROUTES).filter(([, rows]) => rows.some((r) => r.provider === p)).map(([cap]) => cap)
  const table = (header: string[], rows: string[][]) => [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n")
  return {
    status: () => {
      const s = sc.PROVIDER_SELECTION_STATUS
      return table(["Fact", "Value"], [
        ["Status", s.status], ["Selected provider", s.selected === null ? "none — null" : String(s.selected)], ["Activated for production", String(s.activatedForProduction)],
        ["Decided by", s.decidedBy], ["Purchases made", String(s.purchasesMade)], ["Credentials requested", String(s.credentialsRequested)], ["Paid pilot approved", String(s.paidPilotApproved)],
        ["What `active` means", s.meaningOfActive],
      ])
    },
    connectors: () => table(["Connector", "Activation state (technical)", "Rights status", "Rights summary", "Credential (NAME)", "Route rows (capabilities)", "Tenant-connectable", "Recommendation"], providers.map((p) => {
      const a = sc.PROVIDER_ACTIVATION[p]
      const t = TENANT_ACQUISITION_PROVIDERS[p]
      return [label[p], `${a.state}${a.survivorDoors ? ` (doors: ${a.survivorDoors})` : ""}`, a.rights.status, a.rights.summary, a.credential.envVars.length ? a.credential.envVars.map((n) => `\`${n}\``).join(", ") : "none — no product chosen", routesNaming(p).join(", ") || "none (no route row — unreachable by construction)", t ? (t.transports.length ? `${t.transports.join(" + ")} (${t.adapter.module})` : "not offered — no transport (`unsupported`)") : "not an acquisition catalogue entry", sc.PROVIDER_RECOMMENDATION[p].tier]
    })),
    "rentcast-data-types": () => table(["Kind", "Endpoint", "Closed-sale evidence", "Photo rights", "Requires", "Reader label", "Readers"], Object.values(sc.RENTCAST_DATA_TYPES).map((t) => [`\`${t.kind}\``, `\`${t.endpoint}\``, t.closedSaleEvidence ? "YES — recorded sale" : "NO — listing / estimate", "none", t.requires.join(", "), t.label, t.readers.join("; ")])),
    "buyer-order": () => table(["Step", "Origin (saved-home vocabulary)", "What it is", "Door"], els.BUYER_LISTING_SOURCE_ORDER.map((o, i) => [String(i + 1), `\`${o}\``,
      o === "tenant_listing" ? "the tenant's own in-house listings, bounded to the contact's tenant" : o === "idx_mls" ? "the tenant's authorized IDX/MLS provider when CONNECTED — exclusive, never a fall-through on an empty answer" : "RentCast listing / property records as permitted when IDX is unavailable or facts are needed — labelled by source and verified-status, never a photo",
      o === "tenant_listing" ? "lib/buyer-search/search-engine.ts (the in-house read runs first)" : o === "idx_mls" ? "lib/property/external-listings-search.ts Tier 1 (resolveListingSource: hasIdx → idx)" : "lib/property/external-listings-search.ts Tier 2 (hasRentcast → rentcast; platform-gated, metered)"])),
    versium: () => [
      table(["Product", "Interface", "Endpoint", "Capability (route)", "Status", "Contract", "Caller", "Credit keys"], VERSIUM_PRODUCT_MATRIX.map((p) => [`\`${p.id}\` — ${p.name}`, p.interface, `\`${p.endpoint}\``, p.capability ?? "none", p.status, p.contract, p.caller ? `${p.caller.file} ${p.caller.symbol}` : "none", p.creditKeys ? p.creditKeys.join(", ") : "NOT PUBLISHED"])),
      "",
      `REACH MCP verdict: \`${VERSIUM_REACH_MCP.status}\` — ${String((VERSIUM_REACH_MCP as Record<string, unknown>).verdict ?? (VERSIUM_REACH_MCP as Record<string, unknown>).why ?? "see lib/external/versium-client.ts VERSIUM_REACH_MCP")}`,
    ].join("\n"),
    "gap-matrix": () => table(["Source / field", "Provider", "State", "Rights", "Recommendation", "Recency", "Permitted licensed use", "Grain", "Matching key", "Cost per call", "Cost per usable person", "Who pays", "API stability", "Attribution", "Retention", "Consumer display rights", "Consuming survivor", "Documented"],
      sc.providerGapMatrix().map((r) => [`\`${r.source}\` → \`${r.field}\``, r.provider, r.state, r.rights, r.recommendation, r.recency, r.permittedUse, r.grain, r.matchingKey, r.costPerCall, r.costPerUsablePerson, r.whoPays, r.apiStability, r.attribution, r.retention, r.consumerDisplayRights, r.consumer, r.documented ? "yes" : "no"])),
    recommendation: () => table(["Provider", "Tier", "Decision", "Role", "Unique value (documented)", "Conditions before the owner could select it", "Why"], providers.map((p) => { const r = sc.PROVIDER_RECOMMENDATION[p]; return [label[p], `**${r.tier}**`, r.decision, r.role, r.uniqueValue.length ? r.uniqueValue.map((u) => `· ${u}`).join(" ") : "none found", r.conditions.map((c) => `· ${c}`).join(" "), r.why] })),
    "cohort-design": () => {
      const d = pilot.MATCHED_COHORT_DESIGN
      return [
        `Design id \`${d.id}\` — ${d.status}. Arms: ${d.arms.join(", ")}. Incumbents (the overlap baseline, never re-bought): ${d.incumbents.join(", ")}. Total records: ${d.cohorts.reduce((s, c) => s + c.size, 0)} (${d.cohorts.length} disjoint cohorts).`,
        "",
        "**Cohorts (assigned in this order — a record belongs to exactly one):**",
        "",
        table(["#", "Cohort", "Definition", "Drawn from (platform-held, never a vendor list)", "Expected fields (constant across arms)", "Size"], d.cohorts.map((c, i) => [String(i + 1), `\`${c.cohort}\``, c.definition, c.drawnFrom, c.expectedFields.join(", "), String(c.size)])),
        "",
        "**Held constant:**",
        "",
        table(["Constant", "Rule"], Object.entries(d.constants).map(([k, v]) => [k, v])),
        "",
        `**Blinded verification:** sample share ${d.blindedVerification.sampleShare} — ${d.blindedVerification.method}. Lawful: ${d.blindedVerification.lawful}`,
        "",
        "**Measured:**",
        "",
        ...d.measures.map((m) => `- ${m}`),
        "",
        "**The directive's questions, answered from what was read:**",
        "",
        table(["Question", "Answer", "Basis"], d.questions.map((q) => [q.question, q.answer, q.basis])),
        "",
        "**Explicit unknowns:**",
        "",
        ...d.unknowns.map((u) => `- ${u}`),
        "",
        `**Spend:** approved ${d.spend.approved}; paid calls ${d.spend.paidCalls}; cap ${d.spend.capUsd === null ? "none approved" : String(d.spend.capUsd)} — ${d.spend.note}`,
      ].join("\n")
    },
    waterfall: () => {
      const out: string[] = []
      for (const field of ["owner_phone", "owner_email"] as const) {
        for (const h of [0.4, 0.6, 0.8]) {
          const p = pilot.projectMonthlyWaterfall({ field, hitRate: h })
          out.push(`**Field \`${field}\`, ${p.variables.monthlyRecords.toLocaleString("en-US")} records/month, h = ${h} (ASSUMED), u = ${p.variables.usableShare} (ASSUMED), real-time share ${p.variables.realTimeShare} (ASSUMED).** Basis: ${p.basis}.`, "")
          out.push(table(["Stage", "Provider", "Recommendation", "Unit (published)", "Attempted", "Expected hits (× h)", "Cost (USD)", "Cost per usable person", "Note"], p.stages.map((s) => [String(s.stage), s.provider, s.recommendation, s.unit, s.attempted.toLocaleString("en-US"), s.expectedHits.toLocaleString("en-US"), s.costUsd === null ? "UNKNOWN" : `$${s.costUsd.toLocaleString("en-US")}`, s.costPerUsablePerson === null ? "UNKNOWN" : `$${s.costPerUsablePerson}`, s.note])))
          out.push("", `Total: ${p.totalUsd === null ? `UNKNOWN — withheld because ${p.unknownStages.join("; ")} has no published unit` : `$${p.totalUsd.toLocaleString("en-US")} (projection over ASSUMED variables)`}. ${p.disclaimer}`, "")
        }
      }
      out.push("Variable labels:", "", ...Object.entries(pilot.projectMonthlyWaterfall().variableLabels).map(([k, v]) => `- \`${k}\` — ${v}`))
      return out.join("\n")
    },
    // Wave 153 (lane 153G, directive G1): the thirteen-column capability matrix + the needle playbooks.
    "capability-matrix": () => table(
      ["Provider", "1 · Connector (platform / tenant-owned)", "2 · Endpoint / contract", "3 · Acquisition", "4 · Auth / secret ownership", "5 · Producer entry", "6 · Field mapping / provenance", "7 · Preview / count before paid pull", "8 · Freshness / dedup", "9 · Incremental (documented)", "10 · Rate limits / retries / webhooks / idempotency / cost", "11 · Rights (SaaS / AI / storage / photo)", "12 · Validation evidence", "13 · Honest state"],
      cm.providerCapabilityMatrix().map((r) => [
        `**${r.label}**`, r.connector, r.endpoint, r.kinds.join(", "), r.auth,
        `${r.producer.door}${r.producer.anchor ? ` — \`${r.producer.anchor.module}\` ${r.producer.anchor.symbol}` : ""}: ${r.producer.path}`,
        `${r.mapping.anchor ? `\`${r.mapping.anchor.module}\` ${r.mapping.anchor.symbol} — ` : ""}${r.mapping.provenance}`,
        `${r.preview.kind}${r.preview.anchor ? ` (\`${r.preview.anchor.module}\` ${r.preview.anchor.symbol})` : ""}: ${r.preview.note}`,
        r.freshnessDedup, r.incremental, r.limitsCost, r.rights, r.validation, `**${r.honestState}**`,
      ]),
    ),
    // Wave 153 (lane 153N): NEEDLE_PLAYBOOKS retired (owner: no invented plays) — ONLINE_HUNTING_WORKFLOWS, each a real search.
    "online-hunting-workflows": () => table(["Workflow", "Replaces", "Providers", "Search / page", "Evidence fields", "Freshness", "Rights", "Cost", "Survivor that runs it", "Output", "Never claims"], cm.ONLINE_HUNTING_WORKFLOWS.map((p) => [p.key, p.replaces ?? "—", p.providers.join(", "), p.query, p.evidenceFields, p.freshness, p.rights, p.cost, `\`${p.survivor.module}\` ${p.survivor.symbol}`, p.output, p.neverClaims])),
    // Wave 154 (lane 154J, directive J2): the source-to-business columns, beside the thirteen technical ones above.
    "business-matrix": () => table(
      ["Provider", "Truly provides (one vocabulary)", "Official docs / version", "Credential owner", "SaaS resale / processing", "AI use", "Storage / retention", "Outreach", "Territory", "Freshness / source timestamps", "Cost per attempted call", "Cost per match", "Cost per usable record", "Status (J2)", "Consumer", "Failure / recovery", "Responsible manager", "Stack (J6)"],
      cm.providerCapabilityMatrix().map((r) => { const b = r.business!; return [`**${r.label}**`, b.provides.map((c) => `\`${c}\``).join(", "), b.docs, b.credentialOwner, b.rights.resale, b.rights.ai, b.rights.retention, b.rights.outreach, b.territory, b.sourceTimestamps, b.costs.perAttempt, b.costs.perMatch, b.costs.perUsable, `**${r.businessStatus}**`, b.consumer, b.failureRecovery, `\`${b.manager}\``, `**${r.stack.tier}**${r.stack.tenantOption && r.stack.tier !== "TENANT_OWNED_OPTION" ? " + TENANT_OWNED_OPTION" : ""}`] }),
    ),
    // Wave 154 (lane 154J, directive J5): Google, Nextdoor and Meta as the owner ruled them (R1 / R2 / R3 / R5).
    "source-status": () => table(["Source", "Yields", "Identity", "Status", "Ruling", "Enforced by", "Stored on this path"], cm.acquisitionDecisionSupport().sourceStatus.map((s) => [`**${s.source}**`, s.yields, `\`${s.identity}\``, s.status, s.ruling, `\`${s.survivor.module}\` ${s.survivor.symbol}`, s.stored])),
    // Wave 154 (lane 154J, directives J4 + J6): the pilot proposal, the Datafiniti comparison and the smallest stack.
    "pilot-stack": () => {
      const p = cm.acquisitionDecisionSupport().pilot
      const rows = cm.providerCapabilityMatrix()
      const out = [
        `Pilot \`${p.id}\` — **${p.status}** (extends \`${p.extendsDesign}\`). Paid pilot approved: **${p.approved ? "yes" : "no — not approved"}**; paid calls ${p.paidCalls}. ${p.note}.`,
        "",
        `Scale: about ${p.monthlyConsumers.toLocaleString("en-US")} consumers a month (the design's SIMULATION target, never a request size). Bound: ${p.bound}.`,
        "",
        ...p.steps.map((s) => `- ${s}`),
        "",
      ]
      for (const t of p.tracks) {
        out.push(`**Track \`${t.track}\`** — ${t.what}.`, "")
        if (t.arms.length) out.push(table(["Arm", "Published unit", "Monthly figure basis", `Monthly figure at ${p.monthlyConsumers.toLocaleString("en-US")}`, "Terms / payer"], t.arms.map((a) => [a.provider, a.unit, a.basis === "ceiling_at_full_match" ? "CEILING at a 100% match rate (the match rate is UNMEASURED — never an expected cost)" : a.basis === "every_record_attempted" ? "every record attempted (published per-record unit)" : "UNKNOWN", a.monthlyUsd === null ? "UNKNOWN" : `$${a.monthlyUsd.toLocaleString("en-US")} (published unit × records)`, a.terms])), "")
      }
      out.push("**Metrics (each measured by an existing survivor; every value null until a live pull is on record):**", "", table(["Metric", "Measured by", "Value", "Status"], p.metrics.map((m) => [m.metric, m.measuredBy, m.value === null ? "null" : String(m.value), m.status])), "")
      const pick = (id: string) => rows.find((r) => r.provider === id)!
      out.push("**Datafiniti against Versium and the chosen property source (directive J4) — Datafiniti stays DORMANT pending rights; an approved spending plan is not a license:**", "",
        table(["Provider", "Stack", "Status", "Provides", "What only it documents", "Cost per attempted call", "Cost per match", "Resale / outreach rights"], ["datafiniti", "versium", "rentcast"].map((id) => { const r = pick(id); const rec = (r.recommendation ? sc.PROVIDER_RECOMMENDATION[id as keyof typeof sc.PROVIDER_RECOMMENDATION] : null); return [r.label, r.stack.tier ?? "none", r.businessStatus, r.business!.provides.join(", "), rec ? rec.uniqueValue.join("; ") || "none found" : "—", r.business!.costs.perAttempt, r.business!.costs.perMatch, `${r.business!.rights.resale} / ${r.business!.rights.outreach}`] })), "")
      out.push("**The recommended SMALLEST practical stack (a recommendation — the owner selects; nothing is activated):**", "",
        table(["Stack status", "Providers", "Why (per provider)"], (["PRIMARY", "CONDITIONAL_GAP_FILL", "TENANT_OWNED_OPTION", "DORMANT", "LICENSE_HELD", "NOT_NEEDED"] as const).map((tier) => { const inTier = rows.filter((r) => r.stack.tier === tier || (tier === "TENANT_OWNED_OPTION" && r.stack.tenantOption && r.stack.tier !== tier)); return [`**${tier}**`, inTier.map((r) => r.label).join(", ") || "none", inTier.map((r) => `${r.label}: ${r.stack.tier === tier ? r.stack.why : "its tenant-owned route is built — the tenant's own account, with the tenant's own LICENSE attestation captured at connect (the platform's terms with the vendor are not implied)"}`).join(" · ") || "—"] })))
      return out.join("\n")
    },
    // Wave 155 (lane 155I, owner R11): the four Datafiniti datasets and the selection result — the dataset door's own decision.
    "datafiniti-datasets": () => {
      const ds = cm.providerCapabilityMatrix().find((r) => r.provider === "datafiniti")!.datasets ?? []
      return [
        "Every row is DORMANT — no live call is on record, and LICENSE-held until the owner's licensing decision (multi-tenant use, storage, enrichment, AI processing, export, outreach, retention are not stated in the documentation read). Fields are only those the documentation pages NAME; `df_get_schema` is the field authority at run time. About 50,000 records a month is a model scenario, never permission.",
        "",
        table(["Dataset", "Need", "Fields the docs name", "Active incumbent", "Datafiniti selection", "License", "Per-record cost", "Canonical domain", "Never"], ds.map((d) => [
          `**${d.dataType}**`, d.need, d.documentedFields.join(", "), d.incumbents.join(", ") || "none", `${d.selection.replace(/_/g, " ")} — ${d.selectionWhy}`,
          d.licenseHeld ? `LICENSE-HELD (${d.licenseGaps.join("; ")})` : "recorded", d.perRecordCost, d.canonicalDomain, d.never.join("; "),
        ])),
      ].join("\n")
    },
  }
}

// Wave 154 (lane 154J): a block the doc does not carry yet is ADDED by --write under its own generated heading (the doc is
// generated — no lane hand-edits it); without --write a missing block still fails §A.
const NEW_BLOCK_HEADINGS: Record<string, string> = {
  "business-matrix": "## 11. Source-to-business capability matrix (wave 154, lane 154J — directive J2; GENERATED from `providerCapabilityMatrix()`)",
  "source-status": "## 12. Google, Nextdoor and Meta status as the owner ruled it (wave 154, lane 154J — directive J5; GENERATED from `acquisitionDecisionSupport()`)",
  "pilot-stack": "## 13. The matched-record pilot proposal and the smallest practical stack (wave 154, lane 154J — directives J4 / J6; GENERATED)",
  "datafiniti-datasets": "## 14. Datafiniti — four datasets and the provider selection result (wave 155, lane 155I — owner R11; GENERATED from `datafinitiDatasetSelection()`)",
}

const START = (n: string) => `<!-- GENERATED:${n}:start — rendered by scripts/provider-gap-matrix-guard.ts --write; do not edit inside the markers -->`
const END = (n: string) => `<!-- GENERATED:${n}:end -->`

function applyBlocks(doc: string, blocks: Record<string, string>): { text: string; missing: string[] } {
  let text = doc
  const missing: string[] = []
  for (const [name, body] of Object.entries(blocks)) {
    const s = text.indexOf(START(name)), e = text.indexOf(END(name))
    if (s < 0 || e < 0 || e < s) { missing.push(name); continue }
    text = `${text.slice(0, s + START(name).length)}\n\n${body}\n\n${text.slice(e)}`
  }
  return { text, missing }
}

async function main() {
  const sc = await import("../lib/providers/provider-scorecard")
  const pilot = await import("../lib/providers/provider-pilot")
  const contract = await import("../lib/market-reports/contract")
  const { loadMarketTwin } = await import("../lib/market-reports/market-twin")
  const { researchMarket } = await import("../lib/market-reports/research")
  const { resolveListingSource } = await import("../lib/property/listing-source")
  const els = await import("../lib/property/external-listings-search")
  const { CONTACT_PROVIDER_ROUTES } = await import("../lib/ai-isa/property-lookup-rail")
  const { VERSIUM_PRODUCT_MATRIX } = await import("../lib/external/versium-client")
  const { MAINTENANCE_DOMAINS } = await import("../lib/kernel/manager-registry")

  section("A. the doc is the code")
  {
    const R = await renderers()
    const blocks = Object.fromEntries(Object.entries(R).map(([k, f]) => [k, f()]))
    const exists = existsSync(join(ROOT, DOC))
    let onDisk = exists ? raw(DOC) : ""
    if (process.argv.includes("--write")) for (const [name, heading] of Object.entries(NEW_BLOCK_HEADINGS)) if (!onDisk.includes(START(name))) onDisk = `${onDisk.replace(/\s*$/, "")}\n\n${heading}\n\n${START(name)}\n${END(name)}\n`
    const applied = applyBlocks(onDisk, blocks)
    if (process.argv.includes("--write")) { writeFileSync(join(ROOT, DOC), applied.text); console.log(`    wrote ${Object.keys(blocks).length} generated blocks into ${DOC}`) }
    const now = existsSync(join(ROOT, DOC)) ? raw(DOC) : ""
    check(`${DOC} exists and carries every generated block (${Object.keys(blocks).length})`, exists && applied.missing.length === 0, applied.missing.join(", "))
    check("every generated block equals what the constants render (regenerate: npx tsx scripts/provider-gap-matrix-guard.ts --write)", now === applyBlocks(now, blocks).text)
    const tampered = applyBlocks(now, { ...blocks, status: blocks.status.replace("| Selected provider | none — null |", "| Selected provider | rentcast |") })
    check("POSITIVE CONTROL: a planted changed cell in a generated block is caught", tampered.text !== now)
    check("the doc states nothing is selected / activated / bought and the paid pilot is not approved", /not selected/i.test(now) && /not approved/i.test(now) && /no provider (is|was) (selected|activated)/i.test(now))
    check("the doc never carries a 'SELECTED:' decision line", !/^\s*SELECTED\s*:/im.test(now))
  }

  section("B. RentCast data types never collapse")
  {
    const T = sc.RENTCAST_DATA_TYPES
    check("six kinds, one row each, every kind distinct", Object.keys(T).length === 6 && new Set(Object.values(T).map((t) => t.kind)).size === 6 && Object.entries(T).every(([k, t]) => k === t.kind))
    check("closed-sale evidence ONLY on the /properties kinds (property_record, sold_records)", Object.values(T).every((t) => t.closedSaleEvidence === (t.kind === "property_record" || t.kind === "sold_records")))
    check("/markets is listing statistics and /avm/value comparables are listing comparables — neither is closed-sale evidence", T.listing_statistics.closedSaleEvidence === false && T.listing_comparables.closedSaleEvidence === false && /listing/i.test(T.listing_statistics.label) && !/closed sale index|sold price/i.test(T.listing_statistics.label))
    check("photo rights are false on every kind; listing records require provider rights AND freshness", Object.values(T).every((t) => t.photoRights === false) && T.listing_records.requires.includes("provider_rights") && T.listing_records.requires.includes("freshness"))
    check("sold_records names the saleDateRange filter and its three readers — the vendor leg, the capability, the report consumer (no 'none' left)", /saleDateRange/.test(T.sold_records.endpoint) && T.sold_records.readers.some((r) => /getRentcastSoldRecords/.test(r)) && T.sold_records.readers.some((r) => /getAreaSoldRecords/.test(r)) && T.sold_records.readers.some((r) => /research\.ts soldRecordsToData/.test(r)) && !T.sold_records.readers.some((r) => /^none/.test(r)))
    check("rentcastPriceBasis: /properties kinds → recorded_sale; comparables / statistics / listings → last_list_price", contract.rentcastPriceBasis("property_record") === "recorded_sale" && contract.rentcastPriceBasis("sold_records") === "recorded_sale" && contract.rentcastPriceBasis("listing_comparables") === "last_list_price" && contract.rentcastPriceBasis("listing_statistics") === "last_list_price" && contract.rentcastPriceBasis("listing_records") === "last_list_price")

    // The twin, EXECUTED: a /markets reading is labelled listing_statistics + listing_asking.
    const B1 = "00000000-0000-4000-8000-0000000000b1"
    const stats = { median_sale_price: 455000, avg_days_on_market: 38, active_listings: 180, new_listings_30d: 52, price_trend_yoy_pct: 3.1, median_price_per_sqft: 241, total_listings_at: "2026-11-01T00:00:00Z", rental: { median_rent: 2150 } }
    const twin = await loadMarketTwin(memSupabase({ listings: [], market_data: [], property_preferences: [], market_active_listings: [] }) as never, { brokerageId: B1, zips: ["32503"], allowProviderRead: true }, { now: new Date("2026-11-06T12:00:00Z"), providerRead: async () => stats, activeStatuses: async () => ["active"] })
    const z = twin.zips[0]
    check("the market twin labels a /markets reading dataType listing_statistics and its median listing_asking (EXECUTED)", z?.source.dataType === "listing_statistics" && z.listing.medianAskingPrice?.basis === "listing_asking" && z.sold.medianSoldPrice === null, JSON.stringify(z?.source))

    // The report research, EXECUTED: a RentCast comparable is a LISTING record until its own property record confirms the sale.
    const street = { grain: "street" as const, label: "around 1 Elm St", address: "1 Elm St, Austin, TX 78704", zip: "78704", city: "Austin", state: "TX", radiusMiles: 1 }
    const comps = [
      { address: "3 Elm St", salePrice: 400000, saleDate: "2026-09-01", priceBasis: "closed_sale" as const, provider: "rentcast", bedrooms: 3, sqftLiving: 1800, distanceMiles: 0.2 },
      { address: "5 Elm St", salePrice: 390000, saleDate: "2026-08-15", priceBasis: "closed_sale" as const, provider: "batchdata", bedrooms: 3, sqftLiving: 1750, distanceMiles: 0.3 },
      { address: "7 Elm St", salePrice: 420000, saleDate: "2026-09-10", priceBasis: "closed_sale" as const, provider: "rentcast", bedrooms: 4, sqftLiving: 2000, distanceMiles: 0.4 },
    ]
    const run = (saleHistory: (a: { address: string }) => Promise<{ lastSaleDate: string | null; lastSalePrice: number | null } | null>) =>
      researchMarket(memSupabase({ market_data: [], market_trends: [], listings: [] }) as never, { brokerageId: B1, territory: street }, { now: new Date("2026-11-06T12:00:00Z"), refreshMarketData: async () => ({ source: "rentcast", success: true }), streetComps: async () => comps, saleHistory })
    const noRecord = await run(async () => null)
    const rc3 = noRecord.comparables.find((c) => c.address === "3 Elm St"), bd5 = noRecord.comparables.find((c) => c.address === "5 Elm St")
    check("a RentCast comparable with no confirming record prints last_list_price with the comparables dataset (never recorded_sale)", rc3?.priceBasis === "last_list_price" && rc3.source.provider === "rentcast" && /\/avm\/value/.test(rc3.source.dataset), JSON.stringify(rc3))
    check("a BatchData backup comparable (a property-record sale) stays recorded_sale", bd5?.priceBasis === "recorded_sale")
    check("the research says how many RentCast comparables are listing records shown at their last asking price", noRecord.notes.some((n) => /2 RentCast comparable\(s\) are listing records/.test(n)), noRecord.notes.join(" | "))
    const confirmed = await run(async (a) => (a.address === "3 Elm St" ? { lastSaleDate: "2026-09-20", lastSalePrice: 405000 } : a.address === "7 Elm St" ? { lastSaleDate: "2025-01-05", lastSalePrice: 300000 } : null))
    const c3 = confirmed.comparables.find((c) => c.address === "3 Elm St"), c7 = confirmed.comparables.find((c) => c.address === "7 Elm St")
    check("a property record with a sale ON/AFTER the listing left the market upgrades it to recorded_sale at the RECORDED price and date, naming /properties", c3?.priceBasis === "recorded_sale" && c3.price === 405000 && c3.date === "2026-09-20" && /\/v1\/properties/.test(c3.source.dataset), JSON.stringify(c3))
    check("a record whose last sale PRE-DATES the listing is an earlier transaction — the comparable stays last_list_price", c7?.priceBasis === "last_list_price" && c7.price === 420000)
    const noDate = await run(async () => ({ lastSaleDate: null, lastSalePrice: 1 })), zeroPrice = await run(async () => ({ lastSaleDate: "2026-09-20", lastSalePrice: 0 }))
    check("a record with no sale date, or a non-positive price, upgrades nothing (nothing is inferred from a missing fact)", noDate.comparables.filter((c) => c.source.provider === "rentcast").every((c) => c.priceBasis === "last_list_price") && zeroPrice.comparables.filter((c) => c.source.provider === "rentcast").every((c) => c.priceBasis === "last_list_price"))
    const research = code("lib/market-reports/research.ts")
    check("LAW 3: the sale-history door is the property-lookup CAPABILITY with the BatchData backup refused — no RentCast / BatchData client call from lib/market-reports", /getPropertyRecordWithFallback\(/.test(research) && /allowed: false/.test(research) && !/getRentcast\w*\(|fetchBatchData\w*\(|callRentcastGet\(/.test(blankStrings(research)))
    const oldMapping = (c: { priceBasis: string | null }) => (c.priceBasis === "closed_sale" ? "recorded_sale" : "last_list_price")
    check("POSITIVE CONTROL: the OLD mapping (slot name → basis) would have printed the RentCast listing as recorded_sale — the defect this lane removed", oldMapping(comps[0]) === "recorded_sale" && contract.rentcastPriceBasis("listing_comparables") !== oldMapping(comps[0]))

    // The area SOLD RECORDS path, EXECUTED (owner, wave 151: "RentCast has sold properties … if the tenant doesn't have a connected
    // IDX provider"). A tenant with too few MLS-synced closed sales gets RentCast RECORDED sales labelled sold_records; a tenant with
    // enough never asks; an IDX tenant is answered from its feed and nothing is spent.
    const zipT = { grain: "zip" as const, label: "78704", zip: "78704", city: "Austin", state: "TX" }
    const soldRows = [
      { address: "10 Oak St", lastSaleDate: "2026-10-20", lastSalePrice: 510000, bedrooms: 3, bathrooms: 2, squareFeet: 1900 },
      { address: "12 Oak St", lastSaleDate: "2026-10-02", lastSalePrice: 480000, bedrooms: 3, bathrooms: 2, squareFeet: 1800 },
      { address: "14 Oak St", lastSaleDate: "2026-09-14", lastSalePrice: 530000, bedrooms: 4, bathrooms: 3, squareFeet: 2200 },
      { address: "16 Oak St", lastSaleDate: "2026-08-30", lastSalePrice: 495000, bedrooms: 3, bathrooms: 2, squareFeet: 1850 },
    ]
    const mlsSold = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `l${i}`, brokerage_id: B1, status: "sold", deleted_at: null, zip: "78704", city: "Austin", state: "TX", address: `${i + 1} Elm St`, sold_price: 400000 + i * 1000, sold_date: "2026-10-01", list_price: 410000, listing_date: "2026-08-01", bedrooms: 3, bathrooms: 2, sqft: 1700 }))
    const runZip = (listings: Record<string, unknown>[], soldRecords: NonNullable<Parameters<typeof researchMarket>[2]>["soldRecords"]) =>
      researchMarket(memSupabase({ market_data: [], market_trends: [], listings }) as never, { brokerageId: B1, territory: zipT }, { now: new Date("2026-11-06T12:00:00Z"), refreshMarketData: async () => ({ source: "rentcast", success: true }), soldRecords })
    let soldCalls = 0
    const few = await runZip(mlsSold(1), async () => { soldCalls++; return { outcome: "answered", records: soldRows, note: "4 RentCast sold record(s) in the last 180 days" } })
    const med = few.data.find((d) => d.key === "median_sold_price"), cnt = few.data.find((d) => d.key === "closed_sales_count")
    check("1 MLS-synced closed sale → the capability is asked ONCE and the sold median is computed from RentCast sold records, labelled rentcast + sold_records (never listing statistics)", soldCalls === 1 && med?.value === 502500 && med.basis === "computed_from_records" && med.source.provider === "rentcast" && /sold_records/.test(med.source.dataset) && /saleDateRange/.test(med.source.dataset) && !/listing_statistics|\/markets/.test(med.source.dataset) && med.sampleSize === 4 && cnt?.value === 4, JSON.stringify(med))
    check("the sold-record comparables are recorded_sale (rentcastPriceBasis(sold_records)) and the tenant's own MLS comparable stays beside them", few.comparables.filter((c) => c.source.provider === "rentcast").every((c) => c.priceBasis === "recorded_sale") && few.comparables.some((c) => c.source.provider === "tenant_mls" && c.address === "1 Elm St") && few.comparables.length === 5, JSON.stringify(few.comparables.map((c) => [c.address, c.priceBasis, c.source.provider])))
    check("days-to-sell and sale-to-list are said UNAVAILABLE from sold records (no listing date / list price — never computed from a figure the record lacks)", !few.data.some((d) => d.key === "median_days_to_sell" || d.key === "sale_to_list_ratio_pct") && few.unavailable.some((u) => u.key === "median_days_to_sell" && /listing date/.test(u.reason)) && few.unavailable.some((u) => u.key === "sale_to_list_ratio_pct" && /list price/.test(u.reason)))
    check("the research NOTES say the sold figures are RentCast sold records, not the brokerage's MLS", few.notes.some((n) => /fewer than 3/.test(n) && /RentCast sold records/.test(n)), few.notes.join(" | "))
    soldCalls = 0
    const enough = await runZip(mlsSold(4), async () => { soldCalls++; return { outcome: "answered", records: soldRows, note: "" } })
    check("4 MLS-synced closed sales → the capability is NEVER asked (nothing spent) and the median stays tenant_mls", soldCalls === 0 && enough.data.find((d) => d.key === "median_sold_price")?.source.provider === "tenant_mls")
    const idxT = await runZip([], async () => ({ outcome: "tenant_has_idx", records: [], note: "this tenant's connected IDX/MLS feed is its closed-sales source — RentCast sold records were not read" }))
    check("an IDX tenant with no MLS-synced sales on record gets NO provider median (its feed is the source) and the note says why", !idxT.data.some((d) => d.key === "median_sold_price") && idxT.unavailable.some((u) => u.key === "median_sold_price") && idxT.notes.some((n) => /tenant_has_idx/.test(n) && /IDX\/MLS feed/.test(n)), idxT.notes.join(" | "))
    const twoOnly = await runZip([], async () => ({ outcome: "answered", records: soldRows.slice(0, 2), note: "" }))
    check("2 sold records → still no median (the floor is MIN_RECORDS_FOR_MEDIAN) — said with the count; the 2 are shown as comparables", !twoOnly.data.some((d) => d.key === "median_sold_price") && twoOnly.unavailable.some((u) => u.key === "median_sold_price" && /only 2 RentCast sold record/.test(u.reason)) && twoOnly.comparables.length === 2)
    const research2 = code("lib/market-reports/research.ts")
    check("LAW 3 holds for the sold-records door too: research.ts reaches it through getAreaSoldRecords (the capability), never getRentcastSoldRecords", /getAreaSoldRecords\(/.test(research2) && !/getRentcastSoldRecords\(/.test(blankStrings(research2)))

    // The CAPABILITY, EXECUTED with injected seams (no network): the IDX question gates the vendor leg.
    const chain = await import("../lib/avm/provider-chain")
    let vendorCalls = 0
    const vendor = async () => { vendorCalls++; return { success: true, cacheHit: false, records: [
      { address: "10 Oak St", city: "Austin", state: "TX", zip: "78704", lastSaleDate: "2026-10-20", lastSalePrice: 510000, bedrooms: 3, bathrooms: 2, squareFeet: 1900, propertyType: "Single Family" },
      { address: "99 Old Rd", city: "Austin", state: "TX", zip: "78704", lastSaleDate: "2024-01-05", lastSalePrice: 300000, bedrooms: 3, bathrooms: 2, squareFeet: 1500, propertyType: "Single Family" },
      { address: "7 No Date", city: "Austin", state: "TX", zip: "78704", lastSaleDate: null, lastSalePrice: 450000, bedrooms: 3, bathrooms: 2, squareFeet: 1600, propertyType: "Single Family" },
      { address: "8 Zero", city: "Austin", state: "TX", zip: "78704", lastSaleDate: "2026-10-01", lastSalePrice: 0, bedrooms: 3, bathrooms: 2, squareFeet: 1600, propertyType: "Single Family" },
    ] } }
    const capNow = new Date("2026-11-06T12:00:00Z")
    const okCap = await chain.getAreaSoldRecords({ brokerageId: B1, zip: "78704", windowDays: 180 }, { eligibility: async () => ({ reason: "eligible", detail: "" }), rentcast: vendor, now: capNow })
    check("capability EXECUTED (eligible): the vendor leg is read once; only a dated, positive sale INSIDE the window counts (an old sale, a null date and a zero price are dropped)", vendorCalls === 1 && okCap.outcome === "answered" && okCap.dataType === "sold_records" && okCap.records.length === 1 && okCap.records[0]?.address === "10 Oak St" && /1 RentCast sold record/.test(okCap.note), JSON.stringify(okCap))
    vendorCalls = 0
    const idxCap = await chain.getAreaSoldRecords({ brokerageId: B1, zip: "78704", windowDays: 180 }, { eligibility: async () => ({ reason: "tenant_has_idx", detail: "connected at brokerage scope" }), rentcast: vendor, now: capNow })
    check("capability EXECUTED (tenant_has_idx): RentCast is NOT read, outcome names the feed as the source", vendorCalls === 0 && idxCap.outcome === "tenant_has_idx" && idxCap.records.length === 0 && /IDX\/MLS feed/.test(idxCap.note))
    const closedCap = await chain.getAreaSoldRecords({ brokerageId: B1, zip: "78704", windowDays: 180 }, { eligibility: async () => ({ reason: "idx_check_unreadable", detail: "credential store unreadable" }), rentcast: vendor, now: capNow })
    check("capability EXECUTED (idx_check_unreadable): fails CLOSED — not_eligible, RentCast not read (a tenant who owns an IDX feed must not be billed on an unprovable answer)", vendorCalls === 0 && closedCap.outcome === "not_eligible" && /idx_check_unreadable/.test(closedCap.note))
    const noArea = await chain.getAreaSoldRecords({ brokerageId: B1, windowDays: 180 }, { eligibility: async () => ({ reason: "eligible", detail: "" }), rentcast: vendor, now: capNow })
    check("capability: no zip and no city+state → error by name, nothing read", vendorCalls === 0 && noArea.outcome === "error" && /zip code/.test(noArea.note))
    // The vendor leg, READ (stripped source): gated property_data, metered sold_records, a saleDateRange query, the week-long cache, no owner read.
    const rcSrc = code("lib/property/rentcast.ts")
    const soldFn = rcSrc.slice(rcSrc.indexOf("export async function getRentcastSoldRecords"), rcSrc.indexOf("function normalizeRentcastSoldRecord"))
    check("getRentcastSoldRecords (stripped source): gateRentcast property_data · usageType sold_records · saleDateRange: String(days) · cached RENTCAST_CACHE_TTL_DAYS.markets · the owner block is never read", soldFn.length > 400 && /gateRentcast\(params, "property_data"\)/.test(soldFn) && /usageType: "sold_records"/.test(soldFn) && /saleDateRange: String\(days\)/.test(soldFn) && /RENTCAST_CACHE_TTL_DAYS\.markets/.test(soldFn) && !/owner/i.test(blankStrings(soldFn)) && /normalizeRentcastSoldRecord\(r\)/.test(soldFn))
    check("POSITIVE CONTROL: a mutant leg that reads the owner block is caught by the same predicate", /owner/i.test(blankStrings(soldFn.replace("normalizeRentcastSoldRecord(r)", "({ ...normalizeRentcastSoldRecord(r), owner: (r as any).owner })"))))

    // Census: no market-report reader reads median_sale_price into a sold label.
    const READERS = ["lib/market-reports/research.ts", "lib/market-reports/market-twin.ts", "lib/market-reports/producer.ts", "lib/market-reports/topics.ts", "lib/property/external-listings-search.ts"]
    const soldWord = /recorded_sale|median_sold_price|sold_price|"sold"|closed_sale/
    const offenders = (src: string, file: string) => src.split("\n").map((l, i) => ({ l, i })).filter(({ l }) => /median_sale_price/.test(l) && soldWord.test(l)).map(({ i }) => `${file}:${i + 1}`)
    const found = READERS.flatMap((f) => offenders(code(f), f))
    check(`census: no market-report reader line reads median_sale_price into a sold label (${READERS.length} files)`, found.length === 0, found.join(", "))
    check("POSITIVE CONTROL: a planted `median_sold_price … row.median_sale_price` line is caught", offenders(`${code("lib/market-reports/research.ts")}\npush("median_sold_price", "Median sold price", positive(row.median_sale_price), "usd")`, "planted").length === 1)
    check("the research module labels a RentCast market row's dataset with the listing_statistics kind", /market_data \(\$\{RENTCAST_DATA_TYPES\.listing_statistics\.kind\}\)/.test(code("lib/market-reports/research.ts")))
  }

  section("C. the buyer source order is the rule")
  {
    const order = els.BUYER_LISTING_SOURCE_ORDER
    check("BUYER_LISTING_SOURCE_ORDER = tenant_listing → idx_mls → rentcast_listing", JSON.stringify([...order]) === JSON.stringify(["tenant_listing", "idx_mls", "rentcast_listing"]))
    const engine = code("lib/buyer-search/search-engine.ts")
    const origins = engine.match(/SAVED_HOME_ORIGINS = \[([^\]]+)\]/)?.[1] ?? ""
    check("every step is a saved-home ORIGIN (one vocabulary with SAVED_HOME_ORIGINS; buyer_url + manual remain for saves)", order.every((o) => origins.includes(`"${o}"`)) && origins.includes(`"buyer_url"`) && origins.includes(`"manual"`), origins)
    check("resolveListingSource EXECUTED: a connected IDX wins and is exclusive; RentCast only when IDX is absent; neither → none", resolveListingSource({ hasIdx: true, hasRentcast: true }) === "idx" && resolveListingSource({ hasIdx: false, hasRentcast: true }) === "rentcast" && resolveListingSource({ hasIdx: false, hasRentcast: false }) === "none" && resolveListingSource({ hasIdx: true, hasRentcast: false, idxResultCount: 0 }) === "idx")
    const inHouse = engine.indexOf(".eq('brokerage_id', contact.brokerage_id ?? '')"), external = engine.indexOf("searchExternalListings(")
    check("the engine reads the tenant's IN-HOUSE listings (bounded to the contact's tenant) BEFORE it asks the external router", inHouse > 0 && external > inHouse, `${inHouse} / ${external}`)
    const router = code("lib/property/external-listings-search.ts")
    const rcFn = router.slice(router.indexOf("function rentcastToExternal"), router.indexOf("function rentcastToExternal") + 1400)
    check("every RentCast row is a listing_records row, status provider_reported, with NO photo (stripped source)", /dataType: RENTCAST_DATA_TYPES\.listing_records\.kind/.test(rcFn) && /verifiedStatus: "provider_reported"/.test(rcFn) && /photoUrl: null/.test(rcFn) && !/photoUrl: l\.photoUrl/.test(rcFn))
    check("POSITIVE CONTROL: a mutant that forwards the vendor's photo URL is caught", /photoUrl: l\.photoUrl/.test(rcFn.replace("photoUrl: null", "photoUrl: l.photoUrl")))
    const idxFn = router.slice(router.indexOf("function idxToExternal"), router.indexOf("function idxToExternal") + 900)
    check("an IDX row is the tenant's feed (idx_feed) with status feed_active", /dataType: "idx_feed"/.test(idxFn) && /verifiedStatus: "feed_active"/.test(idxFn))
    check("the IDX tier returns before the RentCast tier (exclusive by connection, not by result count)", router.indexOf('chosen === "idx"') > 0 && router.indexOf('chosen === "idx"') < router.indexOf('chosen === "rentcast"') && /resolveListingSource\(\{ hasIdx, hasRentcast \}\)/.test(router))
    check("the market-watch reference row never stores a photo (external-match.ts)", /primary_photo_url:\s*null/.test(code("lib/buyer-search/external-match.ts")))
  }

  section("D. estimates are counts")
  {
    const estimates = sc.PROVIDER_FIELD_SCORECARD.filter((r) => r.field === "preview_count")
    check("every audience-estimate row is free, grain audience, and its consumer says COUNT / preview — never contacts", estimates.length >= 2 && estimates.every((r) => r.unit === "free" && r.unitUsd === 0 && r.grain === "audience" && /count|preview/i.test(r.consumer) && !/contacts purchased|buy contacts/i.test(r.consumer)))
    const est = VERSIUM_PRODUCT_MATRIX.find((p) => p.id === "b2c_listgen_estimate"), oaa = VERSIUM_PRODUCT_MATRIX.find((p) => p.id === "online_audience_append")
    check("Versium's matrix: the estimate is 'A NUMBER' and Online Audience Append is 'NOT TARGETING' (the audit's two confusions, refused in code)", /A NUMBER/.test(est?.note ?? "") && /NOT TARGETING/.test(oaa?.note ?? "") && est?.capability === "audience_estimate" && oaa?.capability === "online_audience_match")
    const gm = sc.providerGapMatrix()
    check("the gap matrix carries the count rule on Versium's rows (a COUNT, never contacts; append ≠ targeting)", gm.some((r) => r.provider === "versium" && r.field === "preview_count" && /COUNT, never contacts/.test(r.consumerDisplayRights) && /never ad targeting/.test(r.consumerDisplayRights)))
    check("no evaluation measure buys contacts from an estimate", !pilot.MATCHED_COHORT_DESIGN.measures.some((m) => /purchase|buy contacts/i.test(m)))
  }

  section("E. nothing selected or activated")
  {
    const s = sc.PROVIDER_SELECTION_STATUS
    check("PROVIDER_SELECTION_STATUS: selected null, not activated, 0 purchases, 0 credentials requested, paid pilot not approved, WAITING_OWNER_APPROVAL", s.selected === null && s.activatedForProduction === false && s.purchasesMade === 0 && s.credentialsRequested === 0 && s.paidPilotApproved === false && s.status === "WAITING_OWNER_APPROVAL")
    const providers = Object.keys(sc.PROVIDER_ACTIVATION) as Array<keyof typeof sc.PROVIDER_ACTIVATION>
    check("every provider has a recommendation, every decision is waiting_owner, every tier is in the five-tier vocabulary", providers.every((p) => sc.PROVIDER_RECOMMENDATION[p] && sc.PROVIDER_RECOMMENDATION[p].decision === "waiting_owner" && (sc.RECOMMENDATION_TIERS as readonly string[]).includes(sc.PROVIDER_RECOMMENDATION[p].tier)) && Object.keys(sc.PROVIDER_RECOMMENDATION).length === providers.length)
    check("all five tiers are used at least once (the vocabulary is real, not a template)", sc.RECOMMENDATION_TIERS.every((t) => providers.some((p) => sc.PROVIDER_RECOMMENDATION[p].tier === t)))
    const consistent = (rec: Record<string, { tier: string }>) => providers.flatMap((p) => {
      const a = sc.PROVIDER_ACTIVATION[p], t = rec[p].tier
      const routed = Object.values(CONTACT_PROVIDER_ROUTES).some((rows) => rows.some((r) => r.provider === (p as string)))
      const ok = t === "PRIMARY" ? a.state === "active" : t === "GAP_FILL" || t === "DORMANT_BACKUP" ? a.state === "dormant_survivor" : t === "WAITING_LICENSE" ? a.state === "dormant_pending_rights" : a.state === "dormant_pending_rights" && !routed
      return ok ? [] : [`${p}: ${t} vs ${a.state}`]
    })
    check("the recommendation is CONSISTENT with PROVIDER_ACTIVATION by rule (PRIMARY ⇒ active; GAP_FILL / DORMANT_BACKUP ⇒ dormant survivor; WAITING_LICENSE / UNNECESSARY ⇒ pending rights; UNNECESSARY unrouted)", consistent(sc.PROVIDER_RECOMMENDATION).length === 0, consistent(sc.PROVIDER_RECOMMENDATION).join("; "))
    check("POSITIVE CONTROL: a tampered recommendation (Tracerfy PRIMARY) is caught by the rule", consistent({ ...sc.PROVIDER_RECOMMENDATION, tracerfy: { tier: "PRIMARY" } }).join() === "tracerfy: PRIMARY vs dormant_pending_rights")
    check("the design spends nothing: approved false, paidCalls 0, no cap", pilot.MATCHED_COHORT_DESIGN.spend.approved === false && pilot.MATCHED_COHORT_DESIGN.spend.paidCalls === 0 && pilot.MATCHED_COHORT_DESIGN.spend.capUsd === null && pilot.MATCHED_COHORT_DESIGN.selection.selected === null)
    const TRANSPORT = /\bfetch\(|https?:\/\/api\.|new\s+[A-Z]\w*Client\(|process\.env\.[A-Z_]*(KEY|TOKEN|SECRET)/
    const pilotSrc = code("lib/providers/provider-pilot.ts"), scSrc = code("lib/providers/provider-scorecard.ts")
    check("no transport in the pilot or the scorecard (stripped source: no fetch, no api host, no client, no credential read)", !TRANSPORT.test(pilotSrc) && !TRANSPORT.test(scSrc))
    check("POSITIVE CONTROL: the transport finder sees a planted fetch", TRANSPORT.test(`${pilotSrc}\nawait fetch("https://api.tracerfy.com/v1/trace")`))
    check("WAITING_LICENSE providers have no route row (unreachable live by construction)", providers.filter((p) => sc.PROVIDER_RECOMMENDATION[p].tier === "WAITING_LICENSE").every((p) => !Object.values(CONTACT_PROVIDER_ROUTES).some((rows) => rows.some((r) => r.provider === (p as string)))))
  }

  section("F. no price literal outside a labelled variable")
  {
    const pilotSrc = code("lib/providers/provider-pilot.ts")
    const fnStart = pilotSrc.indexOf("export function projectMonthlyWaterfall")
    const fn = pilotSrc.slice(fnStart, pilotSrc.indexOf("\n}\n", fnStart))
    const varsLine = fn.slice(0, fn.indexOf("\n", fn.indexOf("const v: WaterfallVariables")))
    // Strings blanked (CLAUDE.md §2: a quoted label such as "re-run at 0.4 / 0.6 / 0.8" is prose, not a price literal in code).
    const body = blankStrings(fn.slice(varsLine.length))
    const PRICE = /\$\s?\d|\b\d+\.\d+\b/
    check("the projection body carries no price literal — every unit price is read from PROVIDER_FIELD_SCORECARD (the ASSUMED defaults live on the labelled variables line only)", fnStart > 0 && !PRICE.test(body) && /hitRate: vars\.hitRate \?\? 0\.6/.test(varsLine), body.match(PRICE)?.[0])
    check("POSITIVE CONTROL: a planted `0.02` in the body is caught", PRICE.test(`${body}\nconst price = 0.02`))
    const phone = pilot.projectMonthlyWaterfall({ field: "owner_phone" }), email = pilot.projectMonthlyWaterfall({ field: "owner_email" })
    check("an unpublished unit (PropertyRadar phone) leaves the total UNKNOWN (null) and is named", phone.totalUsd === null && phone.unknownStages.some((u) => /propertyradar/.test(u)))
    check("with every unit published (owner_email) the total is a number and the incumbent (Versium) is stage 1", email.totalUsd !== null && email.totalUsd > 0 && email.stages[0]?.provider === "versium" && email.unknownStages.length === 0)
    check("the projection labels its basis and every variable; the monthly records equal the pilot's SIMULATION target", email.basis === "PROJECTION_WITH_LABELED_VARIABLES" && Object.keys(email.variableLabels).length === 5 && email.variables.monthlyRecords === pilot.projectMonthlyWaterfall().variables.monthlyRecords && /ASSUMED/.test(email.disclaimer))
    check("a per-match stage bills hits only; a per-record stage bills attempts (true marginal cost)", (() => { const v = email.stages.find((s) => s.provider === "versium")!; return v.costUsd === Math.round(v.expectedHits * 0.05 * 100) / 100 })())
    // The doc's PROSE (outside generated blocks): every dollar figure sits on a labelled line.
    const doc = raw(DOC)
    const prose = doc.replace(/<!-- GENERATED:[\s\S]*?:end -->/g, "")
    const LABEL = /ASSUMED|published|UNKNOWN|quoted|projection|labell?ed|not approved|cap|minimum|plan/i
    const bare = prose.split("\n").filter((l) => /\$\s?\d/.test(l) && !LABEL.test(l))
    check("every dollar figure in the doc's prose is on a line that labels it (ASSUMED / published / UNKNOWN / quoted / projection …)", bare.length === 0, bare.join(" | "))
    check("POSITIVE CONTROL: a planted bare '$1,234 a month' prose line is caught", ["Our cost will be $1,234 a month."].filter((l) => /\$\s?\d/.test(l) && !LABEL.test(l)).length === 1)
  }

  section("G. LICENSE spelling")
  {
    const FILES = [DOC, "lib/providers/provider-scorecard.ts", "lib/providers/provider-pilot.ts", "lib/providers/dormant-adapters.ts", "lib/market-reports/contract.ts", "lib/market-reports/research.ts", "lib/market-reports/market-twin.ts", "lib/market-reports/producer.ts", "lib/property/external-listings-search.ts", "lib/buyer-search/external-match.ts", "scripts/provider-gap-matrix-guard.ts", "scripts/provider-scorecard-guard.ts", "scripts/market-twin-guard.ts", "lib/providers/provider-capability-matrix.ts"]
    const BRITISH = /licen[c]e/i
    const hits = FILES.filter((f) => BRITISH.test(raw(f).replace(/licen\[c\]e/g, "")))
    check(`LICENSE, never the British spelling, in the doc and the lane's modules and proofs (${FILES.length} files)`, hits.length === 0, hits.join(", "))
    check("POSITIVE CONTROL: the finder sees the British spelling", BRITISH.test("a written licen" + "ce comes first"))
    const rail = raw("lib/ai-isa/property-lookup-rail.ts")
    check("PROVIDER_ACTIVATION labels (the rail) spell LICENSE", !BRITISH.test(rail.slice(rail.indexOf("export const PROVIDER_ACTIVATION"))))
  }

  section("H. the cohort design")
  {
    const d = pilot.MATCHED_COHORT_DESIGN
    const fields = new Set(sc.PROVIDER_FIELD_SCORECARD.map((r) => r.field as string))
    check("seven disjoint cohorts with distinct ids, each sized > 0, expected fields all scorecard fields", d.cohorts.length === 7 && new Set(d.cohorts.map((c) => c.cohort)).size === 7 && d.cohorts.every((c) => c.size > 0 && c.expectedFields.every((f) => fields.has(f))))
    check("the directive's seven populations are present and hard_identity is assigned FIRST (so no other cohort absorbs it)", ["owner_occupied", "absentee_owner", "seller_candidate", "buyer_candidate", "sparse_rural", "dense_urban", "hard_identity"].every((c) => d.cohorts.some((x) => x.cohort === c)) && d.cohorts[0].cohort === "hard_identity")
    check("constants: raw identity, data age, expected fields and ask order are held constant across arms", ["rawIdentity", "dataAge", "expectedFields", "order"].every((k) => (d.constants as Record<string, string>)[k]?.length > 20))
    check("a blinded verification sample share in (0, 1), provider names removed, lawful contact only", d.blindedVerification.sampleShare > 0 && d.blindedVerification.sampleShare < 1 && /REMOVED/.test(d.blindedVerification.method) && /no verification call/.test(d.blindedVerification.lawful))
    const Q = ["tracerfy_vs_versium_overlap", "tracerfy_seller_score_definition", "batchdata_unique_functions", "peopledata_missing_from_versium", "tracerfy_listing_feeds_photos", "rentcast_facts_and_sold_records"]
    check("the directive's six questions are answered, each with a basis (documented / documented absence / unresolved)", Q.every((id) => d.questions.some((q) => q.id === id && q.answer.length > 40 && ["documented", "documented absence", "unresolved"].includes(q.basis))))
    check("Tracerfy's seller score is UNRESOLVED (no published definition or validation) and its listing feeds / photos are a documented ABSENCE — never presumed", d.questions.find((q) => q.id === "tracerfy_seller_score_definition")?.basis === "unresolved" && d.questions.find((q) => q.id === "tracerfy_listing_feeds_photos")?.basis === "documented absence" && /Never presumed/.test(d.questions.find((q) => q.id === "tracerfy_listing_feeds_photos")?.answer ?? ""))
    check("the arms are R9's pair plus the two dormant survivors; the incumbents are the overlap baseline", JSON.stringify([...d.arms]) === JSON.stringify(["tracerfy", "datazapp", "batchdata", "peopledata"]) && JSON.stringify([...d.incumbents]) === JSON.stringify(["versium", "rentcast"]))
    check("explicit unknowns are listed (≥ 6) and the measures cover license, storage rights and read/write/update capabilities", d.unknowns.length >= 6 && d.measures.some((m) => /LICENSE/.test(m)) && d.measures.some((m) => /storage/.test(m)) && d.measures.some((m) => /read \/ write \/ update/.test(m)))
    const sim = pilot.simulateProviderPilot
    check("the executable simulation names the design it runs the half of", typeof sim === "function" && /design: MATCHED_COHORT_DESIGN\.id/.test(code("lib/providers/provider-pilot.ts")))
  }

  section("J. the capability matrix — every choosable provider, every anchor real, every state derived (wave 153, lane 153G)")
  {
    const cm = await import("../lib/providers/provider-capability-matrix")
    const { SNAPSHOT_TRANSPORT_FACTS } = await import("../lib/providers/scrape-checkpoint")
    const { PROVIDER_TENANCY } = await import("../lib/providers/tenancy-matrix")
    const { TENANT_ACQUISITION_PROVIDERS } = await import("../lib/providers/tenant-provider-connections")
    const rows = cm.providerCapabilityMatrix()
    const DIRECTIVE = ["rentcast", "versium", "exa", "apify", "zyte", "zenrows", "batchdata", "tracerfy", "datazapp", "peopledata", "datafiniti", "data_axle", "propertyradar", "idxbroker"]
    const missingRows = DIRECTIVE.filter((p) => !rows.some((r) => r.provider === p))
    check(`every provider directive G1 names has a row (${DIRECTIVE.length}, incl. IDX / MLS) — plus the connected sources (${rows.length - DIRECTIVE.length})`, missingRows.length === 0, missingRows.join(", "))
    // An ANCHOR is a DECLARATION in stripped, string-blanked source — a tombstone, an import or a quoted name is not one (CLAUDE.md §2).
    const anchors = rows.flatMap((r) => [r.transport, r.producer.anchor, r.mapping.anchor, r.preview.anchor].filter((a): a is { module: string; symbol: string } => !!a).map((a) => ({ who: r.provider, a })))
    const badAnchors = anchors.map(({ who, a }) => { const p = anchorProblem(a); return p ? `${who}: ${p}` : null }).filter(Boolean)
    check(`every code anchor (${anchors.length}: transport / producer / mapping / preview) is a real declaration in stripped source`, badAnchors.length === 0, badAnchors.join(" | "))
    check("POSITIVE CONTROL: a missing symbol, an IMPORTED-only name and a missing module are all refused as anchors", anchorProblem({ module: "lib/providers/scrape-checkpoint.ts", symbol: "noSuchSymbol153" }) !== null && anchorProblem({ module: "lib/providers/scrape-checkpoint.ts", symbol: "isRobotsAllowed" }) !== null && anchorProblem({ module: "lib/providers/nope-153.ts", symbol: "x" }) !== null && anchorProblem({ module: "lib/providers/scrape-checkpoint.ts", symbol: "fetchCheckpointedSnapshot" }) === null)
    const pkg = JSON.parse(raw("package.json")) as { scripts: Record<string, string> }
    const badProofs = rows.filter((r) => r.proofScript).filter((r) => { const cmd = pkg.scripts[r.proofScript!] ?? ""; const file = cmd.match(/scripts\/[\w.-]+\.ts/)?.[0]; return !file || !existsSync(join(ROOT, file)) || !pkg.scripts.guard.includes(`npm run ${r.proofScript}`) }).map((r) => `${r.provider}: ${r.proofScript}`)
    check("every row's validation proof is a registered package.json script whose file exists and which the guard chain runs", badProofs.length === 0, badProofs.join(", "))
    // THE HONEST STATE, re-derived here by the rule (never read off the row): no transport → license / unavailable; no proof →
    // unavailable; a dormant survivor's platform route → awaiting key; else simulated; ready only with live evidence (none).
    const expectState = (r: (typeof rows)[number], route: "platform" | "tenant", over: { transport?: null } = {}) => {
      const transport = "transport" in over ? over.transport : r.transport
      const act = (sc.PROVIDER_ACTIVATION as Record<string, { state: string } | undefined>)[r.provider]
      if (!transport) return act?.state === "dormant_pending_rights" ? "awaiting_license" : "unavailable"
      if (!r.proofScript) return "unavailable"
      // Wave 153 (lane 153M): a built transport does not license the data — pending rights waits on the license on BOTH routes.
      if (act?.state === "dormant_pending_rights") return "awaiting_license"
      if (route === "platform" && act?.state === "dormant_survivor") return "awaiting_key"
      return "simulated"
    }
    const stateMismatch = rows.filter((r) => (r.states.platform !== null && r.states.platform !== expectState(r, "platform")) || (r.states.tenant !== null && r.states.tenant !== expectState(r, "tenant"))).map((r) => `${r.provider}: ${JSON.stringify(r.states)}`)
    check("every honest state equals the rule re-derived from the registries (per route: platform / tenant-owned)", stateMismatch.length === 0, stateMismatch.join(" | "))
    check("nothing reads READY (no live call with a real credential is on record) and only the five honest labels are used", rows.every((r) => r.states.platform !== "ready" && r.states.tenant !== "ready") && rows.every((r) => /^(platform|tenant-owned): (simulated|awaiting license|awaiting key|unavailable)( · tenant-owned: (simulated|awaiting license|awaiting key|unavailable))?$/.test(r.honestState)), rows.map((r) => r.honestState).join(" | "))
    check("POSITIVE CONTROL: the same row with its transport removed can never read simulated (Zyte → unavailable, Tracerfy stays awaiting license)", expectState(rows.find((r) => r.provider === "zyte")!, "platform", { transport: null }) === "unavailable" && expectState(rows.find((r) => r.provider === "tracerfy")!, "platform") === "awaiting_license")
    const empty = rows.flatMap((r) => (["connector", "endpoint", "auth", "freshnessDedup", "incremental", "limitsCost", "rights", "validation", "honestState"] as const).filter((k) => !String(r[k] ?? "").trim()).map((k) => `${r.provider}.${k}`).concat(r.kinds.length ? [] : [`${r.provider}.kinds`], r.producer.path.trim() ? [] : [`${r.provider}.producer`], r.preview.note.trim() ? [] : [`${r.provider}.preview`], r.mapping.provenance.trim() ? [] : [`${r.provider}.mapping`]))
    check("all thirteen columns are filled for every row (an unknown is written as unknown / not read — never blank)", empty.length === 0, empty.join(", "))
    const z = rows.find((r) => r.provider === "zyte")!, zr = rows.find((r) => r.provider === "zenrows")!
    check("Zyte / ZenRows incremental column says NO cursor is documented and carries the documented conditional rule from SNAPSHOT_TRANSPORT_FACTS", /cursor: none/.test(z.incremental) && z.incremental.includes(SNAPSHOT_TRANSPORT_FACTS.zyte.conditionalRequests.how) && /cursor: none/.test(zr.incremental) && zr.incremental.includes(SNAPSHOT_TRANSPORT_FACTS.zenrows.conditionalRequests.how))
    // The tenant-owned column follows the owner's rulings, not a wish: built only where a transport takes a tenant key.
    const tenancyOf = (p: string) => PROVIDER_TENANCY.find((t) => t.provider === (["zyte", "zenrows", "apify"].includes(p) ? "scrapers" : p))
    const tenantMismatch = rows.filter((r) => {
      const built = /tenant-owned: built/.test(r.connector)
      const catalogueBuilt = TENANT_ACQUISITION_PROVIDERS[r.provider]?.adapter.state === "transport_built"
      const tenancyKey = tenancyOf(r.provider)?.models.includes("tenant_optional_key") ?? false
      return built !== (catalogueBuilt || tenancyKey)
    }).map((r) => r.provider)
    check("the tenant-owned route reads 'built' exactly where the tenant catalogue has a transport or the tenancy model is tenant_optional_key (BatchData, IDX)", tenantMismatch.length === 0, tenantMismatch.join(", "))
    check("RentCast and the scraper fleet keep the owner's PLATFORM-GATED ruling (tenant-owned: ruled out)", ["rentcast", "zyte", "zenrows", "apify"].every((p) => /tenant-owned: ruled out/.test(rows.find((r) => r.provider === p)!.connector)) && !(tenancyOf("rentcast")?.models.includes("tenant_optional_key")))
    const exa = rows.find((r) => r.provider === "exa")!
    check("Exa is BOTH: persons through THE ONE RawData door (grounded) and content / market to research — never the Lead door for content", exa.kinds.includes("person") && exa.kinds.includes("content") && exa.producer.door === "rawdata" && /grounded/.test(exa.producer.path) && /never the Lead door/.test(exa.producer.path))
    const df = rows.find((r) => r.provider === "datafiniti")!
    // Wave 153 (lane 153M, owner B1): Datafiniti People Data is BUILT — the rule is now "transport + proof, rights pending →
    // awaiting license on both routes, LICENSE-HELD rights, a free count that is a count".
    check("Datafiniti: transport + RawData producer + proof built, both routes AWAITING LICENSE (never simulated / ready), rights LICENSE-HELD, the free count a count", df.transport !== null && df.producer.door === "rawdata" && df.proofScript === "test:datafiniti-connector" && df.states.platform === "awaiting_license" && df.states.tenant === "awaiting_license" && /LICENSE-HELD/.test(df.rights) && df.preview.kind === "free_estimate" && /never contacts/.test(df.preview.note))
    check("a preview that is a COUNT never claims contacts (Versium estimate / BatchData observed count)", ["versium", "batchdata"].every((p) => /count/i.test(rows.find((r) => r.provider === p)!.preview.note) && /(never contacts|not contacts|≠ delivered contacts)/.test(rows.find((r) => r.provider === p)!.preview.note)))
    // Wave 153 (lane 153N): every workflow is CONCRETE — a real survivor, matrix providers, a search / page, evidence fields,
    // freshness, rights and cost all stated; no strategy-name combination ("×") survives as a workflow.
    const W = cm.ONLINE_HUNTING_WORKFLOWS as ReadonlyArray<Record<string, any>>
    const workflowProblems = (ws: ReadonlyArray<Record<string, any>>) => ws.flatMap((p) => [
      anchorProblem(p.survivor),
      ...(p.providers as string[]).filter((x) => !rows.some((r) => r.provider === x)).map((x) => `${p.key}: ${x} is not a matrix row`),
      ...["query", "evidenceFields", "freshness", "rights", "cost", "neverClaims"].filter((f) => !String(p[f] ?? "").trim()).map((f) => `${p.key}: no ${f}`),
      /×/.test(`${p.key} ${p.query}`) ? `${p.key}: a combination name, not a workflow` : null,
    ]).filter(Boolean)
    const badPlays = workflowProblems(W)
    check(`every online hunting workflow (${W.length}) is run by a REAL survivor with matrix providers, a real search, evidence fields, freshness, rights and cost`, W.length >= 5 && badPlays.length === 0, badPlays.join(" | "))
    check("POSITIVE CONTROL: a retired-style combination row (no query, '×' name) is refused by the same rule", workflowProblems([{ key: "relocation_demand_x_inventory_mismatch", providers: ["exa"], survivor: W[0].survivor, query: "a × b × c", evidenceFields: "", freshness: "", rights: "", cost: "", neverClaims: "x" }]).length >= 4)
    check("NEEDLE_PLAYBOOKS is retired (no export of that name remains)", !("NEEDLE_PLAYBOOKS" in cm))
  }

  section("K. source-to-business matrix, structured data first, J5 status, the pilot and the smallest stack (wave 154, lane 154J)")
  {
    const cm = await import("../lib/providers/provider-capability-matrix")
    const { MANAGERS } = await import("../lib/kernel/manager-registry")
    const { GOOGLE_INDEXED_DISCOVERY_ROUTE } = await import("../lib/providers/exa/hunting")
    const rows = cm.providerCapabilityMatrix()
    type Row = (typeof rows)[number]
    // J2 — every row carries every new column, and an UNKNOWN always carries its reason.
    const unreasoned = (c: string) => !c.trim() || (/\bUNKNOWN\b/.test(c) && !/—|\(/.test(c)) || (/LICENSE-HELD/.test(c) && !/—/.test(c))
    const j2Problems = (rs: readonly Row[]) => rs.flatMap((r) => {
      const b = r.business
      if (!b) return [`${r.provider}: no business facts`]
      const cells: Record<string, string> = { docs: b.docs, territory: b.territory, sourceTimestamps: b.sourceTimestamps, consumer: b.consumer, failureRecovery: b.failureRecovery, ...b.rights, ...b.costs }
      return [...Object.entries(cells).filter(([, v]) => unreasoned(String(v ?? ""))).map(([k]) => `${r.provider}.${k}`), ...(b.provides.length ? [] : [`${r.provider}.provides`]), ...(b.manager in MANAGERS ? [] : [`${r.provider}.manager '${b.manager}' is not a registered manager`])]
    })
    const j2 = j2Problems(rows)
    check(`J2: every row (${rows.length}) carries provides / docs / credential owner / four rights / territory / timestamps / three costs / consumer / recovery and a REGISTERED manager — an UNKNOWN always says why`, j2.length === 0, j2.join(" | "))
    const planted = rows.map((r) => r.provider === "zyte" ? { ...r, business: { ...r.business!, rights: { ...r.business!.rights, ai: "UNKNOWN" }, manager: "nobody_manager" } } : r)
    check("POSITIVE CONTROL: a bare 'UNKNOWN' cell and an unregistered manager are both caught", j2Problems(planted).filter((p) => /^zyte\./.test(p)).length === 2)
    check("J2: cost per USABLE record is UNKNOWN for every provider (no measured usable ratio — no live pull on record)", rows.every((r) => /^UNKNOWN — needs a measured usable ratio/.test(r.business!.costs.perUsable)))
    const scorecardCostOk = rows.filter((r) => r.recommendation).every((r) => { const rows2 = sc.PROVIDER_FIELD_SCORECARD.filter((x) => x.provider === r.provider && x.unit !== "free" && x.unitUsd !== null); return rows2.length === 0 ? /^UNKNOWN — no published unit/.test(r.business!.costs.perAttempt) : rows2.every((x) => `${r.business!.costs.perAttempt} ${r.business!.costs.perMatch}`.includes(`$${x.unitUsd}`)) })
    check("J2: every scorecard provider's cost cells are DERIVED from its published PROVIDER_FIELD_SCORECARD units (never retyped)", scorecardCostOk)
    // J2 — status: LIVE_VERIFIED only with a recorded live call; an activation state "active" is not one.
    const expectStatus = (r: Row) => { const s = r.states.platform ?? r.states.tenant; return s === "ready" ? "LIVE_VERIFIED" : s === "simulated" ? "SIMULATED_ONLY" : s === "awaiting_license" ? "PENDING_RIGHTS" : s === "awaiting_key" ? "NO_KEY" : null }
    const statusBad = rows.filter((r) => { const e = expectStatus(r); return e ? r.businessStatus !== e : !["NO_ACCOUNT", "UNAVAILABLE"].includes(r.businessStatus) }).map((r) => `${r.provider}: ${r.businessStatus}`)
    check("J2: every status is re-derived from the honest route state (LIVE_VERIFIED / SIMULATED_ONLY / PENDING_RIGHTS / NO_KEY / NO_ACCOUNT / UNAVAILABLE)", statusBad.length === 0, statusBad.join(", "))
    check("J2: NO row claims LIVE_VERIFIED (no live call with a real credential is on record)", rows.every((r) => r.businessStatus !== "LIVE_VERIFIED"))
    check("POSITIVE CONTROL: RentCast's activation state reads 'active' yet its status is SIMULATED_ONLY — a registry entry named active/live is not proof", sc.PROVIDER_ACTIVATION.rentcast.state === "active" && rows.find((r) => r.provider === "rentcast")!.businessStatus === "SIMULATED_ONLY")
    // J2 — categories never conflated.
    const IDENTITY = ["people", "contact_field_append", "property_owner_identity"]
    const conflated = (rs: readonly Row[]) => rs.filter((r) => { const p = r.business!.provides as readonly string[]; return (p.includes("raw_web_transport") || p.includes("trend_insight") || p.includes("public_web_discovery")) && p.some((c) => IDENTITY.includes(c)) }).map((r) => r.provider)
    check("J2: a transport, a trend index or a discovery search provides NO identity category (people / contact append / owner identity)", conflated(rows).length === 0, conflated(rows).join(", "))
    check("POSITIVE CONTROL: Zyte planted with 'people' is caught as conflated", conflated(rows.map((r) => r.provider === "zyte" ? { ...r, business: { ...r.business!, provides: ["raw_web_transport", "people"] as never } } : r)).join() === "zyte")
    check("J2: Zyte, ZenRows and Apify provide raw web transport ONLY; Exa provides public-web discovery ONLY", ["zyte", "zenrows", "apify"].every((p) => JSON.stringify(rows.find((r) => r.provider === p)!.business!.provides) === '["raw_web_transport"]') && JSON.stringify(rows.find((r) => r.provider === "exa")!.business!.provides) === '["public_web_discovery"]')
    const photoRows = rows.filter((r) => (r.business!.provides as readonly string[]).includes("licensed_listing_photos")).map((r) => r.provider)
    check("J2: licensed listing photos come ONLY from the tenant's IDX / MLS feed (RentCast carries none; imagery is never scraped)", photoRows.join() === "idxbroker", photoRows.join())
    const credBad = rows.filter((r) => { const built = /tenant-owned: built/.test(r.connector); const o = r.business!.credentialOwner; return (built && !["either", "tenant"].includes(o)) || (o === "either" && !built) }).map((r) => r.provider)
    check("J2: credential owner agrees with the routes ('either' only where a tenant-owned transport is built)", credBad.length === 0, credBad.join(", "))
    const exa = rows.find((r) => r.provider === "exa")!
    check("J2: the Exa row carries lane 154B's note (Google-indexed pages through Exa; Custom Search JSON API not used, withdrawn by 2027-01-01) and agrees with GOOGLE_INDEXED_DISCOVERY_ROUTE", /Custom Search JSON API is not used/.test(exa.endpoint) && exa.endpoint.includes("2027-01-01") && GOOGLE_INDEXED_DISCOVERY_ROUTE.includes("2027-01-01") && /Custom Search JSON API is not used/.test(GOOGLE_INDEXED_DISCOVERY_ROUTE))
    check("J2: Google Trends, Search Console and the Meta / Apify idea actors have rows (Trends / Search Console NO_ACCOUNT, idea actors trend insight only)", ["google_trends", "search_console"].every((p) => rows.find((r) => r.provider === p)?.businessStatus === "NO_ACCOUNT") && JSON.stringify(rows.find((r) => r.provider === "apify_idea_actors")?.business?.provides) === '["trend_insight"]')

    // J3 — structured data first: a scraper is never an identity database; a provider-supplied fact is not scraped.
    const sim = await import("../lib/lead-pipeline/source-intent-map")
    const planner = await import("../lib/lead-pipeline/source-discovery-planner")
    const { evaluatePrePullValue } = await import("../lib/lead-pipeline/pre-pull-value")
    const TRANSPORT_VENDORS = new Set(["zenrows", "zyte", "apify"])
    const scrapedIdentity = (paid: Record<string, boolean>) => (Object.keys(sim.SOURCE_VENDOR) as Array<keyof typeof sim.SOURCE_VENDOR>).filter((k) => TRANSPORT_VENDORS.has(sim.SOURCE_VENDOR[k]) && paid[k])
    const transportSources = (Object.keys(sim.SOURCE_VENDOR) as string[]).filter((k) => TRANSPORT_VENDORS.has((sim.SOURCE_VENDOR as Record<string, string>)[k]))
    check(`J3: no transport-scraped source (${transportSources.length}) carries PURCHASED identity — a scraper is never an identity database (identity on a scraped row is only what the subject published, e.g. an FSBO card's own phone, or comes from a licensed enrichment rung)`, transportSources.length > 0 && scrapedIdentity(sim.SOURCE_PAID_PERSON_DATA).length === 0, scrapedIdentity(sim.SOURCE_PAID_PERSON_DATA).join(", "))
    check("POSITIVE CONTROL: a scraped source planted as paid person data is caught", scrapedIdentity({ ...sim.SOURCE_PAID_PERSON_DATA, zenrows_zillow: true }).join() === "zenrows_zillow")
    check("J3: a fact a configured structured provider supplies is planned from the provider, not scraped (rental listings → RentCast); without the provider the scrape line stays plannable", planner.providerFirstVerdict("rental_listing", ["rentcast"])?.provider === "rentcast" && planner.providerFirstVerdict("rental_listing", []) === null)
    const plan = planner.planSourceDiscovery({ territory: { id: "t-j3", brokerageId: "b-j3", label: "J3 territory" }, budgetUsd: 500, enabledSources: ["batchdata_motivated"], history: { batchdata_motivated: { rawRows: 200, promoted: 20, duplicates: 30, costUsd: 10 } }, previews: { batchdata_motivated: { count: 100, at: "2026-11-18T00:00:00Z", via: "observed count" } }, quotes: { batchdata_motivated: { unitUsd: 0.05, basis: "catalogue" } }, now: new Date("2026-11-18T00:00:00Z") })
    const v = plan.lines[0]?.value
    const basisOf = (i: string) => v?.inputs.find((x) => x.input === i)?.basis
    check("J3: the paid line's verdict names all nine inputs, each with its basis, and the decision still runs", !!v && v.inputs.length === 9 && new Set(v.inputs.map((i) => i.input)).size === 9 && ["proceed", "preview_first", "hold", "refuse"].includes(v.decision), v ? v.inputs.map((i) => `${i.input}:${i.basis}`).join(" ") : "no verdict")
    check("J3: the planner's CONFIGURED weights read as configured (opportunity relevance, territory) — never as measured; measured history reads measured (duplicate likelihood)", basisOf("opportunity_relevance") === "configured" && basisOf("territory") === "configured" && basisOf("duplicate_likelihood") === "measured" && basisOf("provider_price") === "stated" && basisOf("source_rights") === "stated")
    check("J3: what the planner does not have is NAMED unknown (the specific missing fields; held-field completeness) — never an invented probability", !!v && v.unknownInputs.includes("specific_missing_data") && v.unknownInputs.includes("fields_already_verified"))
    const bare = evaluatePrePullValue({ factors: { territoryMatch: null, freshness: null, sourceReliability: null, expectedNewUsableFields: null, identityMatchLikelihood: null, usefulOpportunityFactor: null }, cost: { recordCount: 10, providerUnitUsd: null, paid: true } })
    check("POSITIVE CONTROL: with nothing known, every input but none is named unknown and the decision still returns (refuse at an unknown price)", bare.decision === "refuse" && bare.unknownInputs.length === 9)

    // J4 — Datafiniti stays dormant; a spending plan is not a license.
    const df = rows.find((r) => r.provider === "datafiniti")!
    check("J4: Datafiniti is LICENSE_HELD in the stack, PENDING_RIGHTS in status, and offers NO tenant option while its license is pending (its tenant route is built but not licensed)", df.stack.tier === "LICENSE_HELD" && df.businessStatus === "PENDING_RIGHTS" && df.stack.tenantOption === false && df.states.tenant === "awaiting_license")
    const dfPlan = planner.paidPullApproval([{ id: "plan-j4", brokerage_id: "b-j4", status: "approved", valid_until: "2027-01-01T00:00:00Z", lines: [{ source: "datafiniti_people", status: "approved", maxSpendUsd: 100, approvedAt: "2026-11-01T00:00:00Z" }] }], { brokerageId: "b-j4", source: "datafiniti_people" }, new Date("2026-11-18T00:00:00Z"))
    check("J4: an approved spending plan opens the SPEND gate only — the matrix still reads Datafiniti awaiting LICENSE on both routes (the rights gate is separate: test:datafiniti-connector)", dfPlan.allowed === true && df.states.platform === "awaiting_license")
    // Wave 155 (lane 155I, owner R11): Datafiniti is four datasets, every one LICENSE-held while the platform row is awaiting license.
    const dsRows = df.datasets ?? []
    check("J4 (wave 155): the Datafiniti row carries property / people / business / product, each LICENSE-held while the route awaits its license, product never more than not-needed, and no dataset claims a price the scorecard did not publish", dsRows.map((d) => d.dataType).join() === "property,people,business,product" && dsRows.every((d) => d.licenseHeld === (df.states.platform === "awaiting_license")) && dsRows.find((d) => d.dataType === "product")?.selection === "not_needed" && dsRows.filter((d) => d.dataType !== "people").every((d) => /^unknown/.test(d.perRecordCost)), JSON.stringify(dsRows.map((d) => [d.dataType, d.selection, d.licenseHeld])))

    // J5 — Google, Nextdoor and Meta as ruled; the survivors are EXECUTED.
    const chatter = await import("../lib/content-intel/public-chatter-topics")
    const sd = await import("../lib/content-intel/search-demand")
    const { COMMUNITY_TOPIC_RESEARCH_PURPOSE, SCRAPE_PURPOSES } = await import("../lib/providers/scrape-checkpoint")
    const firstPerson = () => ({ firstPerson: true, requestsAgentContact: false, statesHousingNeed: true })
    const fenced = chatter.fenceUntrusted("We are selling our home next spring and need an agent.")
    const nd = chatter.routeChatter(fenced, "community_post", firstPerson), fb = chatter.routeChatter(fenced, "facebook_group_question", firstPerson)
    check("J5: a first-person Nextdoor post routes to a TOPIC with the person path LICENSE-HELD; a first-person Facebook group post is IDEAS ONLY (routeChatter executed)", nd.route === "first_person_topic_only" && /^license_held:nextdoor/.test(nd.personPath) && fb.route === "first_person_topic_only" && /^ideas_only:facebook/.test(fb.personPath))
    check("POSITIVE CONTROL: an anonymous discussion is never a person; no classifier → not evaluated", chatter.routeChatter(fenced, "community_post", () => ({ firstPerson: false, requestsAgentContact: false, statesHousingNeed: false })).personPath.startsWith("none") && chatter.routeChatter(fenced, "community_post", null).personPath === "not_evaluated")
    check("J5: the topic purpose is NOT a person purpose (community_topic_research is outside SCRAPE_PURPOSES)", !(SCRAPE_PURPOSES as readonly string[]).includes(COMMUNITY_TOPIC_RESEARCH_PURPOSE))
    const t = sd.trendIdea({ term: "Mortgage rates", geo: { city: "Destin", state: "FL", label: "Destin, FL" }, relativeIndex: 64, windowStart: "2026-10-01", windowEnd: "2026-11-01" }, new Date("2026-11-18T00:00:00Z"))
    const IDENT_KEYS = /\b(email|phone|name|author|profile|person|contact)\b/i
    check("J5: a Trends point becomes a TOPIC with no identity field and a relative-index evidence label — never a searcher, never a count", !!t.idea && !Object.keys(t.idea).some((k) => IDENT_KEYS.test(k)) && t.idea.evidence.kind === "proxy" && /not a count/.test(t.idea.evidence.note ?? ""))
    check("POSITIVE CONTROL: the identity-key finder sees a planted 'authorEmail' field", Object.keys({ ...t.idea, author_email: "x" }).some((k) => IDENT_KEYS.test(k.replace(/_/g, " "))))
    const ss = cm.acquisitionDecisionSupport().sourceStatus
    const statusOf = (k: string) => ss.find((s) => s.key === k)
    check("J5: Trends / Search Console identity 'never'; Nextdoor person LICENSE-HELD; Facebook person and Meta Ad Library ideas only; Nextdoor / Facebook topics LISTED FOR COUNSEL", ["google_trends", "search_console", "google_custom_search"].every((k) => statusOf(k)?.identity === "never") && statusOf("nextdoor_person")?.identity === "license_held" && statusOf("facebook_person")?.identity === "ideas_only" && statusOf("meta_ad_library")?.identity === "ideas_only" && ["nextdoor_topics", "facebook_group_topics"].every((k) => /COUNSEL/.test(statusOf(k)?.status ?? "")))
    const ssAnchors = ss.map((s) => anchorOk(s.survivor) ? null : `${s.key}: ${s.survivor.module} ${s.survivor.symbol}`).filter(Boolean)
    check(`J5: every status row names a REAL enforcing survivor (${ss.length})`, ssAnchors.length === 0, ssAnchors.join(" | "))

    // J6 — the pilot proposal authorizes nothing; the stack is the smallest, never "everything active".
    const p = cm.acquisitionDecisionSupport().pilot
    check("J6: the pilot is a PROPOSAL — not approved (the earlier $1,000 paid pilot is NOT approved), zero paid calls, about 50,000 consumers a month", p.approved === false && sc.PROVIDER_SELECTION_STATUS.paidPilotApproved === false && p.paidCalls === 0 && p.monthlyConsumers === 50000 && /NOT approved/.test(p.note))
    check("J6: owner contacts, market statistics and licensed imagery / IDX are three SEPARATE tracks — only owner contacts has purchasable arms", JSON.stringify(p.tracks.map((x) => x.track)) === '["owner_contacts","market_statistics","licensed_imagery_idx"]' && p.tracks[0].arms.length > 0 && p.tracks.slice(1).every((x) => x.arms.length === 0))
    check("J6: a per-match price is shown only as a CEILING at full match (never an expected cost); an unpublished unit stays UNKNOWN (null)", p.tracks[0].arms.every((a) => (/per_match/.test(a.unit) ? a.basis === "ceiling_at_full_match" : true) && (a.basis === "unknown" ? a.monthlyUsd === null : a.monthlyUsd !== null)))
    const unmeasured = (ms: ReadonlyArray<{ value: unknown }>) => ms.every((m) => m.value === null)
    check("J6: all nine directive metrics are named with their measuring survivor and every value is null (nothing measured is invented)", p.metrics.length === 9 && unmeasured(p.metrics) && p.metrics.every((m) => m.measuredBy.length > 20))
    check("POSITIVE CONTROL: a planted measured value is caught", !unmeasured([...p.metrics, { value: 0.42 }]))
    const tierOk = (rs: readonly Row[]) => {
      const tiers = rs.map((r) => r.stack.tier)
      const of = (id: string) => rs.find((r) => r.provider === id)?.stack.tier
      const problems: string[] = []
      if (tiers.some((x) => !x)) problems.push("a row has no stack tier")
      for (const id of ["datafiniti", "tracerfy", "datazapp", "propertyradar"]) if (of(id) !== "LICENSE_HELD") problems.push(`${id} is not LICENSE_HELD`)
      if (of("peopledata") !== "DORMANT") problems.push("peopledata is not DORMANT")
      if (of("data_axle") !== "NOT_NEEDED") problems.push("data_axle is not NOT_NEEDED")
      if (tiers.filter((x) => x === "PRIMARY").length * 3 > rs.length) problems.push("more than a third PRIMARY — not the smallest stack")
      for (const tier of ["DORMANT", "LICENSE_HELD", "NOT_NEEDED"]) if (!tiers.includes(tier as never)) problems.push(`no ${tier}`)
      if (rs.some((r) => r.stack.tier === "PRIMARY" && r.businessStatus === "PENDING_RIGHTS")) problems.push("a PENDING_RIGHTS provider is PRIMARY")
      return problems
    }
    check("J6: the stack is the SMALLEST practical one — license-held and dormant providers marked correctly, PRIMARY ≤ a third, no pending-rights PRIMARY", tierOk(rows).length === 0, tierOk(rows).join("; "))
    check("POSITIVE CONTROL: an 'everything PRIMARY' stack is refused by the same rule", tierOk(rows.map((r) => ({ ...r, stack: { ...r.stack, tier: "PRIMARY" as const } }))).length >= 5)
    const stackMap: Record<string, string> = { PRIMARY: "PRIMARY", GAP_FILL: "CONDITIONAL_GAP_FILL", DORMANT_BACKUP: "DORMANT", WAITING_LICENSE: "LICENSE_HELD", UNNECESSARY: "NOT_NEEDED" }
    const derivedBad = rows.filter((r) => r.recommendation && r.stack.tier !== stackMap[r.recommendation]).map((r) => r.provider)
    check("J6: every scorecard provider's stack status is DERIVED from PROVIDER_RECOMMENDATION (one decision, one translation — never retyped)", derivedBad.length === 0, derivedBad.join(", "))
  }

  section("I. ownership")
  {
    check("MAINTENANCE_DOMAINS.provider_gap_matrix owns test:provider-gap-matrix (data_steward, co-owned with finance_manager)", MAINTENANCE_DOMAINS.provider_gap_matrix?.proof === "test:provider-gap-matrix" && MAINTENANCE_DOMAINS.provider_gap_matrix.manager === "data_steward" && (MAINTENANCE_DOMAINS.provider_gap_matrix.coOwners ?? []).includes("finance_manager"))
    const pkg = JSON.parse(raw("package.json")) as { scripts: Record<string, string> }
    // "runs it", not "ends with it": every lane appends its own proof after this one (CLAUDE.md §2 — never pin a waypoint).
    check("package.json registers the proof and the guard chain runs it", /provider-gap-matrix-guard/.test(pkg.scripts["test:provider-gap-matrix"] ?? "") && /npm run test:provider-gap-matrix(?= &&|$)/.test(pkg.scripts.guard))
  }

  console.log(`\nPROVIDER GAP MATRIX — RESULT: ${passed} passed, ${failed} failed ${failed === 0 ? "✅ PROVIDER_GAP_MATRIX_PASS" : "❌ PROVIDER_GAP_MATRIX_FAIL"}`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
