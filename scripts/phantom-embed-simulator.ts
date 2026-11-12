#!/usr/bin/env tsx
/**
 * scripts/phantom-embed-simulator.ts   (npm run test:phantom-embed)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the two features that were computing on NOTHING, and pins them so they
 * cannot silently go back to it.
 *
 * THE DEFECT CLASS
 * A starred PostgREST embed — `select("*, vendor:vendors(*)")` — resolves fine,
 * so no guard complains, but it hides WHICH columns the consumer reads. A
 * property that is not on the table then reads as `undefined` forever: the
 * feature keeps running and keeps producing nothing. Two shapes of that were
 * live here:
 *
 *   1. VENDOR AUTO-PICK (app/actions/marketing-package-automation.ts). The score
 *      weighed base_price, avg_response_hours, completion_rate and service_area.
 *      None of those four is a column on the vendor bench — nor anywhere else in
 *      the schema — so three of the four score terms were constant and the
 *      "ranking" could not vary. Worse, the bench was filtered by the package
 *      SERVICE TYPE against a CHECK'd CATEGORY vocabulary that shares no
 *      spelling with it, so the query matched nothing and no vendor was ever
 *      picked at all.
 *
 *   2. MEMORY-VIDEO RECOMMENDATION (app/api/ai/video-recommendations/route.ts).
 *      The gate read persona_type and age_range off an embedded lead. Neither is
 *      a lead column — and there is no foreign key between transactions and
 *      leads in either direction, so the embed itself was unresolvable and
 *      PostgREST rejected the entire request. The branch never once fired.
 *
 * LAYERS
 *   1. PURE — the extracted ranking core and the memory-video gate.
 *   2. RELATIONSHIP GRAPH — every embed in the two repointed files resolves to a
 *      real foreign key. This closes a hole in the schema-drift guard: its
 *      cardinality map stores only pairs above one, so fkPairCount() answers "1"
 *      for a pair with ZERO foreign keys and a PGRST200 embed reads as fine.
 *   3. WIRING — behavioural claims about the two files.
 *   4. MUTATION / NEGATIVE CONTROL — every layer-2 and layer-3 probe is re-run
 *      against deliberately broken copies, and the run FAILS unless each probe is
 *      killed by at least one mutation. A check that cannot go red is not a check.
 *   5. LIVE (creds-gated) — seed a real contact + deal, prove the gate qualifies
 *      the seeded persona through the real column, clean up, assert residue 0.
 *
 * Run: npx tsx scripts/phantom-embed-simulator.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { SCHEMA_FK_MAP } from "./schema-fk-map"
import {
  MARKETING_SERVICE_VENDOR_CATEGORY,
  MAX_PRIORITY_BONUS,
  UNMEASURED_RANKING_INPUTS,
  VENDOR_CATEGORIES,
  isVendorCategory,
  pickBestVendor,
  rankVendors,
  vendorCategoryForService,
  MIN_AUTO_BOOK_RATING,
  isAutoBookable,
  type RankableVendor,
} from "../lib/marketing/vendor-ranking"

/**
 * The per-row scorer is NOT exported — it is an internal of rankVendors, and an
 * export nothing outside calls is indistinguishable from an unfinished feature.
 * Ranking a bench of one observes exactly the same three fields (score,
 * measured, unmeasured), so every scoring assertion below is unchanged in what
 * it proves and is now made through the surface real callers actually use.
 */
const scoreVendor = (v: RankableVendor) => rankVendors([v])[0]
import { MEMORY_VIDEO_PERSONAS, qualifiesForMemoryVideo } from "../lib/video/memory-video-gate"

let pass = 0
let fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}

const A_PKG = "app/actions/marketing-package-automation.ts"
const A_VREC = "app/api/ai/video-recommendations/route.ts"
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const vendor = (o: Partial<RankableVendor> = {}): RankableVendor => ({
  id: "v-1", name: "Acme Photo", rating: 4.0, preferred: false,
  display_priority: 0, estimated_turnaround_days: null, ...o,
})

// ── Layer 1 · PURE ───────────────────────────────────────────────────────────

function pureLayer() {
  console.log("\n[1 · pure — the vendor ranking core]")

  check("every mapped service resolves to a category the live CHECK allows",
    Object.values(MARKETING_SERVICE_VENDOR_CATEGORY).every((c) => isVendorCategory(c)))
  check("a package service type is NEVER itself a bench category (the two vocabularies are disjoint)",
    Object.keys(MARKETING_SERVICE_VENDOR_CATEGORY).every((s) => !(VENDOR_CATEGORIES as readonly string[]).includes(s)))
  check("photo/video/drone/tour/staging services each reach a bench category",
    vendorCategoryForService("professional_photos") === "photographer" &&
    vendorCategoryForService("drone_video") === "drone_pilot" &&
    vendorCategoryForService("cinematic_video") === "videographer" &&
    vendorCategoryForService("3d_matterport") === "3d_tour" &&
    vendorCategoryForService("virtual_staging") === "stager")
  check("an in-house service (ad buys, syndication, copy) has NO bench category",
    vendorCategoryForService("facebook_ads") === null &&
    vendorCategoryForService("mls_syndication") === null &&
    vendorCategoryForService("listing_description") === null)
  check("unknown / empty service types resolve to null, never to a guessed category",
    vendorCategoryForService("nonsense") === null &&
    vendorCategoryForService("") === null &&
    vendorCategoryForService(null) === null)

  console.log("\n[1 · pure — the score varies, and says what it could not weigh]")
  const better = scoreVendor(vendor({ rating: 4.8 }))
  const worse = scoreVendor(vendor({ rating: 3.8 }))
  check("a better-rated vendor outscores a worse-rated one (the ranking VARIES)", better.score > worse.score)
  check("preferred bench membership is worth a bonus",
    scoreVendor(vendor({ preferred: true })).score > scoreVendor(vendor({ preferred: false })).score)
  check("the broker's display_priority nudges the order, capped",
    scoreVendor(vendor({ display_priority: 50 })).score - scoreVendor(vendor({ display_priority: 0 })).score === MAX_PRIORITY_BONUS)
  check("a fast turnaround scores above a slow one",
    scoreVendor(vendor({ estimated_turnaround_days: 1 })).score >
    scoreVendor(vendor({ estimated_turnaround_days: 20 })).score)
  check("price / proximity / response-latency / completion-rate are declared UNMEASURED, never scored",
    UNMEASURED_RANKING_INPUTS.every((i) => better.unmeasured.includes(i)) &&
    UNMEASURED_RANKING_INPUTS.every((i) => !better.measured.includes(i)))
  check("a NULL column is reported unmeasured rather than defaulting to a flattering number",
    scoreVendor(vendor({ rating: null })).unmeasured.includes("rating") &&
    scoreVendor(vendor({ rating: null })).score === scoreVendor(vendor({ rating: 0 })).score &&
    !scoreVendor(vendor({ rating: null })).measured.includes("rating"))

  console.log("\n[1 · pure — ranking is total and order-independent]")
  const bench: RankableVendor[] = [
    vendor({ id: "a", name: "A", rating: 4.0 }),
    vendor({ id: "b", name: "B", rating: 4.9 }),
    vendor({ id: "c", name: "C", rating: 4.4, preferred: true }),
  ]
  check("the best-rated-plus-preferred vendor wins", pickBestVendor(bench)?.id === "c")
  const forward = rankVendors(bench).map((v) => v.id).join(",")
  const reversed = rankVendors([...bench].reverse()).map((v) => v.id).join(",")
  check("the ranking does not depend on the row order the database returned", forward === reversed)
  const tied = rankVendors([vendor({ id: "z", name: "Zeta" }), vendor({ id: "y", name: "Alpha" })])
  check("identical vendors break their tie deterministically by name", tied[0].name === "Alpha")
  check("an empty bench picks nothing rather than throwing", pickBestVendor([]) === null)

  console.log("\n[1 · pure — the memory-video gate]")
  check("a downsizing seller qualifies (drifted spellings normalise in)",
    qualifiesForMemoryVideo("downsizer") && qualifiesForMemoryVideo("downsizing") && qualifiesForMemoryVideo("downsize"))
  check("a senior-move seller qualifies", qualifiesForMemoryVideo("senior"))
  check("case and padding do not defeat the gate", qualifiesForMemoryVideo("  Downsizer  "))
  check("a first-time buyer / investor / luxury buyer does NOT qualify",
    !qualifiesForMemoryVideo("first_time_buyer") && !qualifiesForMemoryVideo("investor") && !qualifiesForMemoryVideo("luxury_buyer"))
  check("a missing persona is not read as qualifying",
    !qualifiesForMemoryVideo(null) && !qualifiesForMemoryVideo(undefined) && !qualifiesForMemoryVideo(""))
  check("a contact TYPE spelling (past_client / listing_seller) is not mistaken for a persona",
    !qualifiesForMemoryVideo("past_client") && !qualifiesForMemoryVideo("listing_seller"))
  check("the gate has NO age operand — every qualifying value is a situation, not a demographic",
    MEMORY_VIDEO_PERSONAS.every((p) => !/\d/.test(p)))
}

// ── Layer 2 · RELATIONSHIP GRAPH ─────────────────────────────────────────────

/** Does ANY foreign key join these two tables, in either direction? */
export function fkPairExists(a: string, b: string): boolean {
  const out = SCHEMA_FK_MAP[a] ?? {}
  if (Object.values(out).includes(b)) return true
  const back = SCHEMA_FK_MAP[b] ?? {}
  return Object.values(back).includes(a)
}

export interface EmbedRef { parent: string; relation: string; alias: string | null }

/**
 * Extract the TOP-LEVEL embeds of every `.from("t").select("…")` chain in a file.
 * An embed is `rel(` or `alias:rel(` inside the select literal; `rel` is either a
 * table name or an FK column name (both resolvable against the FK map).
 */
export function extractEmbeds(source: string): EmbedRef[] {
  const out: EmbedRef[] = []
  const starts = [...source.matchAll(/\.from\(\s*["'`]([a-z0-9_]+)["'`]\s*\)/g)]
  for (let s = 0; s < starts.length; s++) {
    const m = starts[s]
    // A chain ends where the NEXT .from() begins — otherwise a query with no
    // select of its own borrows the next query's embeds and reports a phantom.
    const from = m.index ?? 0
    const to = s + 1 < starts.length ? (starts[s + 1].index ?? source.length) : source.length
    const chain = source.slice(from, to)
    const sel = chain.match(/\.select\(\s*(?:\n\s*)?["'`]([\s\S]*?)["'`]/)
    if (!sel) continue
    const literal = sel[1]
    let depth = 0
    let token = ""
    for (let i = 0; i < literal.length; i++) {
      const ch = literal[i]
      if (ch === "(") {
        if (depth === 0) {
          const t = token.trim().replace(/^\.\.\./, "")
          const [aliasOrRel, maybeRel] = t.split(":")
          const relation = (maybeRel ?? aliasOrRel).trim().split("!")[0]
          if (/^[a-z0-9_]+$/.test(relation)) {
            out.push({ parent: m[1], relation, alias: maybeRel ? aliasOrRel.trim() : null })
          }
        }
        depth++
        token = ""
        continue
      }
      if (ch === ")") { depth--; token = ""; continue }
      if (depth === 0) { if (ch === ",") token = ""; else token += ch }
    }
  }
  return out
}

/** Resolve an embed's relation name to its target table (table name, or FK column). */
export function resolveRelation(parent: string, relation: string): string | null {
  const byColumn = SCHEMA_FK_MAP[parent]?.[relation]
  if (byColumn) return byColumn
  if (SCHEMA_FK_MAP[relation] || fkPairExists(parent, relation)) return relation
  return null
}

interface Probe { name: string; run: (pkg: string, vrec: string) => boolean }

const PROBES: Probe[] = [
  {
    name: "GRAPH: every embed in both repointed files joins on a REAL foreign key (no PGRST200)",
    run: (pkg, vrec) =>
      [...extractEmbeds(pkg), ...extractEmbeds(vrec)].every((e) => {
        const target = resolveRelation(e.parent, e.relation)
        return target !== null && fkPairExists(e.parent, target)
      }),
  },
  {
    // Scoped to the two tables whose columns were being phantom-read. The other
    // starred embeds in the package action (listings off a transaction) resolve
    // on real FKs and have no phantom reader; widening this probe to every star
    // would be a claim this change does not deliver.
    name: "GRAPH: no embed of vendors or leads is starred — a star hides which columns are read",
    run: (pkg, vrec) => [pkg, vrec].every((s) => !/\b(vendors|leads)\(\s*\*\s*\)/.test(s)),
  },
  {
    name: "GRAPH: the deal→client embed names its FK column (transactions reaches contacts 3 ways)",
    run: (_pkg, vrec) => extractEmbeds(vrec)
      .filter((e) => e.parent === "transactions")
      .every((e) => SCHEMA_FK_MAP.transactions?.[e.relation] === "contacts"),
  },
  {
    name: "BOOK: the auto-pick translates the service type into a bench category before querying",
    run: (pkg) => /vendorCategoryForService\(/.test(pkg) && !/\.eq\(\s*"category",\s*serviceType\s*\)/.test(pkg),
  },
  {
    name: "BOOK: the ordering comes from the published ranking core, not an inline score",
    run: (pkg) => /pickBestVendor\(/.test(pkg) && /rankVendors\(/.test(pkg) && !/finalScore/.test(pkg),
  },
  {
    name: "BOOK: no phantom vendor property survives anywhere in the action",
    run: (pkg) => !/\bbase_price\b|\bavg_response_hours\b|\bcompletion_rate\b|\bservice_area\b|\bcontact_email\b/.test(pkg),
  },
  {
    // The bench read must destructure its error AND branch on it before the
    // empty-bench branch, so "permission denied" cannot answer "no vendors".
    name: "BOOK: a REFUSED bench read is distinguishable from an empty bench",
    run: (pkg) => {
      const iErr = pkg.indexOf("if (benchError)")
      const iEmpty = pkg.search(/if \(!vendors \|\| vendors\.length === 0\)/)
      return /error: benchError/.test(pkg) && iErr > 0 && iEmpty > iErr
    },
  },
  {
    name: "BOOK: estimated_cost is not written from a price the bench does not carry",
    run: (pkg) => !/estimated_cost:\s*vendor\./.test(pkg),
  },
  {
    name: "VIDEO: the memory-video gate is the published persona gate, not an inline field compare",
    run: (_pkg, vrec) => /qualifiesForMemoryVideo\(/.test(vrec) && !/persona_type/.test(vrec),
  },
  {
    name: "VIDEO: the gate reads contact_persona — the column that exists — and no age operand",
    run: (_pkg, vrec) => /contact_persona/.test(vrec) && !/age_range/.test(vrec),
  },
  {
    name: "VIDEO: nothing in the route reads a lead off a transaction any more",
    run: (_pkg, vrec) => !/txn\.leads/.test(vrec) && !/txn\.lead_id/.test(vrec),
  },
  {
    name: "VIDEO: the already-commissioned check uses the real contact_id column, not a jsonb key",
    run: (_pkg, vrec) => /\.eq\("contact_id", seller\.id\)/.test(vrec) && !/video_metadata->>lead_id/.test(vrec),
  },
  {
    name: "VIDEO: every read in the route destructures its error (a refusal is never an absence)",
    run: (_pkg, vrec) => {
      const reads = [...vrec.matchAll(/await supabase\s*\n?\s*\.from\(/g)].length
      const guarded = [...vrec.matchAll(/error: \w*[Ee]rror\b/g)].length
      return reads > 0 && guarded >= reads
    },
  },
]

function graphAndWiringLayer() {
  console.log("\n[2+3 · relationship graph + wiring — behavioural claims about the repointed files]")
  const pkg = src(A_PKG)
  const vrec = src(A_VREC)
  for (const p of PROBES) check(p.name, p.run(pkg, vrec))

  console.log("\n[2 · the guard hole this closes]")
  check("transactions and leads share NO foreign key — the old embed could never resolve",
    !fkPairExists("transactions", "leads"))
  check("transactions↔contacts and listing_marketing_services↔vendors DO resolve",
    fkPairExists("transactions", "contacts") && fkPairExists("listing_marketing_services", "vendors"))
  check("the extractor sees a starred embed as an embed (it is not silently skipped)",
    extractEmbeds('.from("transactions").select("*, leads(*)")').some((e) => e.relation === "leads"))
  check("the extractor resolves an aliased FK-column embed to its target table",
    resolveRelation("transactions", "seller_contact_id") === "contacts")
}

// ── Layer 4 · MUTATION / NEGATIVE CONTROL ────────────────────────────────────

interface Mutation { name: string; pkg?: (s: string) => string; vrec?: (s: string) => string }

/** Each mutation reintroduces exactly one shape of the defect that was fixed. */
const MUTATIONS: Mutation[] = [
  { name: "restore the starred vendor embed",
    pkg: (s) => s.replace(/vendor:vendors\([^)]*\)/, "vendor:vendors(*)") },
  { name: "restore the starred lead embed on the deal",
    vrec: (s) => s.replace(/client:contact_id\([^)]*\)/, "leads(*)") },
  { name: "embed leads off transactions with no foreign key to join on",
    vrec: (s) => s.replace(/seller:seller_contact_id\([^)]*\)/, "leads(id, persona)") },
  { name: "drop the FK-column hint so the contacts embed becomes ambiguous",
    vrec: (s) => s.replace(/client:contact_id\(/, "contacts(") },
  { name: "filter the bench by the raw service type again",
    pkg: (s) => s.replace(/\.eq\("category", category\)/, '.eq("category", serviceType)') },
  { name: "remove the service→category translation entirely",
    pkg: (s) => s.replace(/vendorCategoryForService\(/g, "String(") },
  { name: "score inline with finalScore instead of the published ranking",
    pkg: (s) => s.replace(/pickBestVendor\(/g, "finalScore(").replace(/rankVendors\(/g, "finalScore(") },
  { name: "read base_price off a vendor again",
    pkg: (s) => s.replace(/status: "scheduled",/, 'status: "scheduled", estimated_cost: vendor.base_price,') },
  { name: "read contact_email / company_name off a vendor again",
    pkg: (s) => s.replace(/vendor\.email/g, "vendor.contact_email") },
  { name: "swallow the bench-read refusal",
    pkg: (s) => s.replace(/if \(benchError\) \{/, "if (false) {") },
  { name: "restore the persona_type gate",
    vrec: (s) => s.replace(/qualifiesForMemoryVideo\(seller\.contact_persona\)/, 'seller.persona_type === "downsizer"') },
  { name: "restore the age_range operand",
    vrec: (s) => s.replace(/qualifiesForMemoryVideo\(seller\.contact_persona\)/, 'seller.age_range === "55+"') },
  { name: "read the lead back off the transaction",
    vrec: (s) => s.replace(/seller\.id/g, "txn.lead_id") },
  { name: "go back to digging the client id out of the metadata jsonb",
    vrec: (s) => s.replace(/\.eq\("contact_id", seller\.id\)/, '.eq("video_metadata->>lead_id", txn.lead_id)') },
  { name: "stop destructuring the read errors",
    vrec: (s) => s.replace(/error: \w*[Ee]rror\b/g, "error: _unused") },
]

function mutationLayer(): void {
  console.log("\n[4 · negative control — every probe must die to at least one mutation]")
  const pkg0 = src(A_PKG)
  const vrec0 = src(A_VREC)

  const killedBy = new Map<string, string[]>(PROBES.map((p) => [p.name, []]))
  for (const m of MUTATIONS) {
    const pkg = m.pkg ? m.pkg(pkg0) : pkg0
    const vrec = m.vrec ? m.vrec(vrec0) : vrec0
    const changed = pkg !== pkg0 || vrec !== vrec0
    check(`mutation applies: ${m.name}`, changed)
    if (!changed) continue
    let killedAny = false
    for (const p of PROBES) {
      let survived: boolean
      try { survived = p.run(pkg, vrec) } catch { survived = false }
      if (!survived) { killedBy.get(p.name)!.push(m.name); killedAny = true }
    }
    check(`  ↳ RED: "${m.name}" is caught by at least one probe`, killedAny)
  }

  console.log("\n[4 · coverage — no probe is unkillable]")
  const orphans = [...killedBy.entries()].filter(([, ms]) => ms.length === 0).map(([n]) => n)
  check(`every one of the ${PROBES.length} probes is killed by ≥1 mutation${orphans.length ? ` — UNKILLABLE: ${orphans.join(" | ")}` : ""}`,
    orphans.length === 0)
  check("the unmutated source passes every probe (no probe is red at rest)",
    PROBES.every((p) => p.run(pkg0, vrec0)))
}

// ── Layer 5 · LIVE (creds-gated) ─────────────────────────────────────────────

async function liveLayer(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    console.log("\n[5 · live] ⊘ skipped (no SUPABASE creds) — layers 1-4 proved the logic offline")
    return
  }
  const svc = createClient(url, key)
  console.log("\n[5 · live] seed a downsizing seller + a bench vendor → the gate and the pick fire on real rows → clean up")

  const { data: brk, error: brkError } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (brkError) { check("live: brokerage read succeeded", false); return }
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as { id: string }).id

  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: contact, error: contactError } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Phantom", last_name: "Probe",
      contact_type: "seller", contact_persona: "downsizer",
    }).select("id, contact_persona").single()
    check("live: seeded a contact carrying contact_persona", !contactError && !!contact)
    if (contactError || !contact) return
    cleanup.push({ table: "contacts", id: contact.id })

    // Read it back through the SAME column the route now reads.
    const { data: readBack, error: readBackError } = await svc
      .from("contacts").select("id, contact_persona").eq("id", contact.id).single()
    check("live: contact_persona reads back as a real value, not undefined",
      !readBackError && typeof readBack?.contact_persona === "string")
    check("live: the memory-video gate qualifies the seeded seller from the real column",
      qualifiesForMemoryVideo(readBack?.contact_persona))

    const { data: txn, error: txnError } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, contact_id: contact.id, seller_contact_id: contact.id,
      // deal_name is NOT NULL with no default on this table.
      deal_name: "Phantom Probe Deal",
      deal_type: "seller", status: "active", client_name: "Phantom Probe",
    }).select("id").single()
    check("live: seeded a seller deal linked to that contact", !txnError && !!txn)
    if (txn) cleanup.push({ table: "transactions", id: txn.id })

    if (txn) {
      // The repointed embed shape, executed for real. The old leads(*) embed
      // would fail here with PGRST200 instead of returning a row.
      const { data: embedded, error: embedError } = await svc
        .from("transactions")
        .select("id, seller:seller_contact_id(id, contact_persona)")
        .eq("id", txn.id)
        .single()
      check("live: the deal→seller-contact embed RESOLVES (the lead embed could not)", !embedError && !!embedded)
      const seller = (embedded as any)?.seller as { contact_persona: string | null } | null
      check("live: the embed carries the persona the gate needs",
        qualifiesForMemoryVideo(seller?.contact_persona))
    }

    const { data: bench, error: benchError } = await svc
      .from("vendors")
      .select("id, name, rating, preferred, display_priority, estimated_turnaround_days")
      .eq("brokerage_id", brokerageId)
      .limit(25)
    check("live: the named bench select resolves against the live table", !benchError)
    if (!benchError && (bench?.length ?? 0) > 0) {
      const ranked = rankVendors(bench as RankableVendor[])
      check("live: every ranked row exposes a numeric score and a declared unmeasured set",
        ranked.every((r) => Number.isFinite(r.score) && r.unmeasured.length >= UNMEASURED_RANKING_INPUTS.length))
    }
  } finally {
    for (const c of cleanup.reverse()) {
      // Count the rows the delete actually removed: a zero-row delete under RLS
      // resolves with error: null and would otherwise read as a clean cleanup.
      const { data: removed } = await svc.from(c.table).delete().eq("id", c.id).select("id")
      check(`live: cleanup removed the seeded ${c.table} row (proved, not assumed)`, (removed?.length ?? 0) === 1)
    }
    let residue = 0
    for (const c of cleanup) {
      const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id)
      residue += count ?? 0
    }
    check("live: residue == 0", residue === 0)
  }
}

/**
 * THE TWO PATHS USED TO DISAGREE ABOUT WHAT IS BOOKABLE.
 * The auto-pick filtered the bench at rating >= 3.75; the recommendation list
 * did not — so the list could rank a vendor at position 1 that the automation
 * would refuse to book, while its own comment claimed it showed "the order the
 * automation would actually book in". One constant now answers both, and the
 * list marks each row instead of hiding the rest.
 */
function autoBookLayer() {
  console.log("\n[auto-book · one threshold, and a list that admits what it means]")
  const AUTOMATION = "app/actions/marketing-package-automation.ts"
  const PANEL = "app/dashboard/listings/[id]/marketing-tier/marketing-package-panel.tsx"
  const automation = src(AUTOMATION)
  const panel = src(PANEL)

  check("AB1 an unrated vendor is NOT auto-booked — absence of a rating is not merit",
    isAutoBookable({ rating: null }) === false)
  check("AB2 a vendor exactly AT the threshold is auto-bookable (the bound is inclusive)",
    isAutoBookable({ rating: MIN_AUTO_BOOK_RATING }) === true)
  check("AB3 a vendor just below the threshold is not",
    isAutoBookable({ rating: MIN_AUTO_BOOK_RATING - 0.01 }) === false)

  check("AB4 the auto-pick reads the SHARED constant, not a re-typed literal",
    automation.includes('.gte("rating", MIN_AUTO_BOOK_RATING)')
      && !/\.gte\("rating",\s*3\.75\)/.test(automation))

  check("AB5 the recommendation list does NOT hide the rest of the approved bench",
    !/getVendorRecommendations[\s\S]*?\.gte\("rating"/.test(automation))

  check("AB6 …it marks each candidate instead, and says why one would not be auto-booked",
    automation.includes("autoBookable: isAutoBookable(v)")
      && automation.includes("autoBookBlockedReason"))

  check("AB7 the panel actually CONSUMES the ranking — it was an action with no caller",
    panel.includes("getVendorRecommendations")
      && /from "@\/app\/actions\/marketing-package-automation"/.test(panel))

  check("AB8 the panel shows what the ranking could not weigh, not just the winner",
    panel.includes("v.unmeasured") && panel.includes("autoBookBlockedReason"))

  // NEGATIVE CONTROL — re-introduce the drift the constant exists to prevent.
  const drifted = automation.replace('.gte("rating", MIN_AUTO_BOOK_RATING)', '.gte("rating", 3.75)')
  check("NEGATIVE CONTROL a re-typed 3.75 literal fails AB4 — went RED as required",
    !(drifted.includes('.gte("rating", MIN_AUTO_BOOK_RATING)')
      && !/\.gte\("rating",\s*3\.75\)/.test(drifted)))
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Phantom-embed simulator — starred embeds hid columns that were never there")
  console.log("══════════════════════════════════════════════════")
  pureLayer()
  graphAndWiringLayer()
  mutationLayer()
  autoBookLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ PHANTOM_EMBED_FAIL"); process.exit(1) }
  console.log(" ✅ PHANTOM_EMBED_PASS — the vendor ranking varies on real columns and the memory-video gate can fire")
}
main()
