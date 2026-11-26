#!/usr/bin/env tsx
/**
 * scripts/schema-cache-drift-guard.ts   (npm run test:schema-cache-drift)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LIVE DATABASE IS THE SOURCE OF TRUTH FOR SCHEMA. This guard is what makes that sentence
 * enforceable rather than aspirational.
 *
 * Five files in scripts/ describe the schema — schema-snapshot.ts (columns), schema-fk-map.ts
 * (foreign keys), check-vocabularies.ts (CHECK vocabularies), live-tables.ts (which relations
 * exist at all), agent-fk-columns.ts (which id CLASS a column holds). Every schema guard in the
 * repo reads them, and they exist only because CI holds no
 * database credentials. They are a CACHE. Three of them declared themselves generated
 * while having no generator, so the only way to move them was the hand-edit their own banner
 * forbade; all had drifted from the database, and one had drifted from its own header's counts.
 * The last of the three was agent-fk-columns.ts, and it had drifted the furthest: it listed 56 of
 * the 165 tables whose contact_id FKs contacts(id), so the identity-class guard was blind to 109
 * tables it exists to watch and reported a clean zero for every one of them.
 *
 * The fourth was added because its absence was being papered over: guards asking "is this table
 * live?" were reading SCHEMA_SNAPSHOT, which is `referenced ∩ live` and cannot answer that
 * question — a live table nothing queries looks identical to a dropped one.
 *
 * TWO CHECKS, AND THIS GUARD REPORTS EXACTLY THE ONE IT RAN
 *
 *   1. SHAPE + STAMP — always, credentials or not. Each file must carry the machine-written
 *      provenance stamp, its body-sha256 must match the bytes below the BODY marker, and the
 *      counts its header advertises must match what its body actually holds. A hand-edit fails
 *      here, offline, in under a second.
 *
 *   2. LIVE COMPARISON — only where SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY exist. Re-reads the
 *      live schema through the service-role-only RPCs, rebuilds all four files IN MEMORY with the
 *      same builders the generators use, and fails on any difference — naming the table, column,
 *      FK edge or constraint value that differs.
 *
 * WHERE THERE ARE NO CREDENTIALS THE SECOND CHECK IS SKIPPED LOUDLY AND SAID TO BE SKIPPED. It is
 * never folded into the pass line. scripts/use-server-export-guard.ts carries the reason in its own
 * header: a guard that reports green for a surface it never inspected "is worse than no guard —
 * it is a green light". So the closing line here names which of the two checks actually ran.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { AGENT_FK_COLUMNS, CONTACT_FK_TABLES, USERS_FK_AGENTISH_COLUMNS } from "./agent-fk-columns"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { LIVE_TABLES } from "./live-tables"
import { SCHEMA_FK_MAP, SCHEMA_FK_PAIR_CARDINALITY } from "./schema-fk-map"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import {
  AGENT_FK_SOURCE,
  FK_MAP_SOURCE,
  LIVE_TABLES_SOURCE,
  LiveCheck,
  LiveFk,
  LiveSchema,
  SNAPSHOT_SOURCE,
  VOCAB_SOURCE,
  buildAgentFkColumns,
  buildFkMap,
  buildLiveTables,
  buildSnapshot,
  buildVocabularies,
  embeddedTables,
  referencedTables,
} from "./schema-cache-builders"
import { bodyOf, fetchLiveJson, hashBody, liveCredentials, parseStamp, stamp as stampFile } from "./schema-cache-provenance"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

let passed = 0
let failed = 0
const failures: string[] = []
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name + (detail ? ` — ${detail}` : ""))
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

const read = (rel: string) => readFileSync(join(root, rel), "utf8")

console.log("══════════════════════════════════════════════════")
console.log(" Schema-cache drift guard (the cache vs the live database)")
console.log("══════════════════════════════════════════════════")

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 0 — THE GUARD'S OWN MACHINERY.
//
// The live comparison below cannot run in CI (no credentials), so the code that would report a
// difference is the code least likely to be exercised before it is needed. It is proven here on
// synthetic readings instead, every run, everywhere.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[pure — the comparison itself]")
{
  const live = { listings: { status: ["active", "sold"] }, offers: { state: ["draft"] } }
  const cached = { listings: { status: ["active", "closed"] }, leads: { temp: ["hot"] } }
  const diffs = diffNested(live, cached, (t, c) => `${t}.${c}`)
  check("names a column the live database has and the cache misses", diffs.some((d) => d.includes("LIVE HAS, CACHE MISSES: offers.state")))
  check("names one the cache holds and the database dropped", diffs.some((d) => d.includes("CACHE HAS, LIVE DROPPED: leads.temp")))
  check("names a value that differs, showing both readings", diffs.some((d) => d.includes("VALUE DIFFERS: listings.status") && d.includes("sold") && d.includes("closed")))
  check("stays silent when the two agree", diffNested(live, live, (t, c) => `${t}.${c}`).length === 0)
}
{
  const body = "export const X = 1\n"
  const file = stampFile("/**\n * header", body, "public.f()", null)
  check("a freshly stamped file verifies against itself", hashBody(bodyOf(file)!) === parseStamp(file)!.bodySha256)
  const tampered = file.replace("export const X = 1", "export const X = 2")
  check("one edited character breaks the stamp", hashBody(bodyOf(tampered)!) !== parseStamp(tampered)!.bodySha256)
  check("an unstamped file is not mistaken for a verified one", parseStamp("export const X = 1\n") === null)
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE — THE FK COLUMN RULE, ON SYNTHETIC READINGS.
//
// buildFkMap used to collapse a column carrying two foreign keys by last-write-wins over
// constraint-NAME order, which silently resolved the live vendor_subscriptions.brokerage_id to
// vendor_plans instead of brokerages (m497 added a composite FK over that column). A rule that
// cannot be shown to DISCRIMINATE is not a rule, so it is exercised here against both cases —
// the ordinary one-FK column that must keep working, and the two-FK column that must refuse.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[pure — the FK column rule]")
{
  const fk = (src_table: string, src_col: string, tgt_table: string, name: string) => ({ src_table, src_col, tgt_table, name })

  // (a) the ordinary case — one FK per column, which is 1763 of the 1764 live edges
  const plain = buildFkMap([
    fk("listings", "brokerage_id", "brokerages", "listings_brokerage_id_fkey"),
    fk("listings", "agent_id", "agents", "listings_agent_id_fkey"),
  ])
  check("ordinary one-FK-per-column is mapped, unchanged",
    plain.map.listings?.brokerage_id === "brokerages" && plain.map.listings?.agent_id === "agents")
  check("ordinary columns are NOT reported ambiguous", plain.facts.ambiguousColumns === 0 && plain.facts.compositeFks === 0)

  // (b) a single-column FK and a COMPOSITE FK over the SAME column — the live m497 shape.
  //     The composite arrives once per column, exactly as live_foreign_keys_json() emits it.
  const COMPOSITE = "vendor_subscriptions_plan_in_same_brokerage_fkey"
  const mixed = [
    fk("vendor_subscriptions", "brokerage_id", "brokerages", "vendor_subscriptions_brokerage_id_fkey"),
    fk("vendor_subscriptions", "plan_id", "vendor_plans", "vendor_subscriptions_plan_id_fkey"),
    fk("vendor_subscriptions", "plan_id", "vendor_plans", COMPOSITE),
    fk("vendor_subscriptions", "brokerage_id", "vendor_plans", COMPOSITE),
  ]
  const built = buildFkMap(mixed)
  check("a column with TWO targets is NOT silently resolved",
    built.map.vendor_subscriptions?.brokerage_id === undefined)
  check("…and is published with BOTH candidates, sorted",
    JSON.stringify(built.ambiguousColumns.vendor_subscriptions?.brokerage_id) === JSON.stringify(["brokerages", "vendor_plans"]))
  check("the OLD last-write-wins answer (vendor_plans) is the one no longer produced",
    built.map.vendor_subscriptions?.brokerage_id !== "vendor_plans")
  check("a column whose two FKs AGREE on the target is still mapped, not called ambiguous",
    built.map.vendor_subscriptions?.plan_id === "vendor_plans" &&
    built.ambiguousColumns.vendor_subscriptions?.plan_id === undefined)
  check("the composite FK is counted as ONE relationship for the pair, not one per column",
    built.ambiguous["vendor_plans|vendor_subscriptions"] === 2)
  check("the composite FK is recognised as composite", built.facts.compositeFks === 1)

  // (c) the defect was ORDER-dependent, so the fix must not be. Reverse the rows and the
  //     constraint names and nothing may move.
  const reversed = buildFkMap([...mixed].reverse())
  check("output does not depend on row order (the old bug's root cause)",
    JSON.stringify(reversed.map) === JSON.stringify(built.map) &&
    JSON.stringify(reversed.ambiguousColumns) === JSON.stringify(built.ambiguousColumns))
  const renamed = buildFkMap(mixed.map((r) => (r.name === COMPOSITE ? { ...r, name: "aaa_sorts_first_fkey" } : r)))
  check("output does not depend on constraint-NAME order either",
    renamed.map.vendor_subscriptions?.brokerage_id === undefined &&
    JSON.stringify(renamed.ambiguousColumns.vendor_subscriptions?.brokerage_id) === JSON.stringify(["brokerages", "vendor_plans"]))
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE — THE IDENTITY-CLASS RULE, ON SYNTHETIC READINGS.
//
// Two of its branches cannot be exercised by the live schema as it stands: there are currently
// ZERO composite foreign keys to agents/users/contacts, so the arity filter never fires, and a
// filter that never fires is indistinguishable from one that is broken. Both are proven here.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[pure — the identity-class rule]")
{
  const fk = (src_table: string, src_col: string, tgt_table: string, name: string) => ({ src_table, src_col, tgt_table, name })
  const built = buildAgentFkColumns([
    fk("net_sheet_calculations", "agent_id", "agents", "net_sheet_calculations_agent_id_fkey"),
    fk("activities", "agent_user_id", "users", "activities_agent_user_id_fkey"),
    fk("blog_posts", "created_by", "users", "blog_posts_created_by_fkey"),
    fk("tasks", "contact_id", "contacts", "tasks_contact_id_fkey"),
    fk("listings", "seller_contact_id", "contacts", "listings_seller_contact_id_fkey"),
    fk("listings", "brokerage_id", "brokerages", "listings_brokerage_id_fkey"),
  ])
  check("an agents(id) column is mapped as agents-class", built.agents.net_sheet_calculations?.[0] === "agent_id")
  check("a users(id) column NAMED like an agent is mapped as the reverse hazard",
    built.usersAgentish.activities?.[0] === "agent_user_id")
  check("…and a users(id) column nothing would mistake for one is NOT",
    built.usersAgentish.blog_posts === undefined)
  check("a contact_id → contacts table is listed", built.contacts.includes("tasks"))
  check("…and a table whose only contacts FK is seller_contact_id is not",
    !built.contacts.includes("listings"))
  check("an FK to a fourth table is ignored entirely",
    built.agents.listings === undefined && built.usersAgentish.listings === undefined)

  // The arity filter: the same column, once as a single-column FK and once inside a composite.
  const composite = buildAgentFkColumns([
    fk("tasks", "contact_id", "contacts", "tasks_contact_id_fkey"),
    fk("deal_team_members", "contact_id", "contacts", "deal_team_members_tenant_contact_fkey"),
    fk("deal_team_members", "brokerage_id", "contacts", "deal_team_members_tenant_contact_fkey"),
  ])
  check("[control] a COMPOSITE FK is excluded — no one column of a tuple carries the target's id",
    !composite.contacts.includes("deal_team_members") && composite.facts.compositeSkipped === 1)
  check("[control] …and the single-column FK beside it still lands",
    composite.contacts.includes("tasks"))
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 1 — SHAPE + STAMP. Runs everywhere.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[stamp — a hand-edit cannot be silent]")

const CACHE_FILES = [
  { rel: "scripts/schema-snapshot.ts", source: SNAPSHOT_SOURCE },
  { rel: "scripts/schema-fk-map.ts", source: FK_MAP_SOURCE },
  { rel: "scripts/check-vocabularies.ts", source: VOCAB_SOURCE },
  { rel: "scripts/live-tables.ts", source: LIVE_TABLES_SOURCE },
  { rel: "scripts/agent-fk-columns.ts", source: AGENT_FK_SOURCE },
]

const bodies = new Map<string, string>()
for (const f of CACHE_FILES) {
  if (!existsSync(join(root, f.rel))) {
    check(`${f.rel} exists`, false, "the cache file is missing — regenerate it")
    continue
  }
  const text = read(f.rel)
  const body = bodyOf(text)
  const st = parseStamp(text)

  if (body === null) {
    check(`${f.rel} carries the BODY marker`, false, "not machine-shaped — regenerate it")
    continue
  }
  if (!st) {
    check(`${f.rel} carries a provenance stamp`, false, "no generated/source/body-sha256 header")
    continue
  }
  bodies.set(f.rel, body)
  check(`${f.rel} names the live source it came from`, st.source === f.source, `stamp says "${st.source}"`)
  const actual = hashBody(body)
  check(
    `${f.rel} body matches its own body-sha256`,
    actual === st.bodySha256,
    `stamped ${st.bodySha256.slice(0, 12)}…, file hashes to ${actual.slice(0, 12)}… — the file was edited by hand`,
  )
}

// The header counts are prose and therefore outside the hash. They are the exact thing that went
// stale before (a vocabulary file advertising 428 tables / 730 columns while holding 427 / 736),
// so they are checked against the body rather than trusted.
{
  const snapTables = Object.keys(SCHEMA_SNAPSHOT).length
  const advertised = /COVERAGE: (\d+) tables/.exec(read("scripts/schema-snapshot.ts"))?.[1]
  check(
    "schema-snapshot.ts's advertised coverage matches its contents",
    advertised === String(snapTables),
    `header says ${advertised}, file holds ${snapTables}`,
  )

  const fkTables = Object.keys(SCHEMA_FK_MAP).length
  const fkEdges = Object.values(SCHEMA_FK_MAP).reduce((n, cols) => n + Object.keys(cols).length, 0)
  const fkHeader = /MEASURED AT GENERATION: (\d+) edges across (\d+) source tables/.exec(read("scripts/schema-fk-map.ts"))
  const fkAmbiguous = Object.keys(SCHEMA_FK_PAIR_CARDINALITY).length
  const fkAmbAdvertised = /(\d+)\s*\n? \* ?carry more than one and are listed below/.exec(read("scripts/schema-fk-map.ts"))?.[1]
  check(
    "schema-fk-map.ts's advertised ambiguous-pair count matches its contents",
    fkAmbAdvertised === String(fkAmbiguous),
    `header says ${fkAmbAdvertised}, file holds ${fkAmbiguous}`,
  )
  check(
    "schema-fk-map.ts's advertised edge count matches its contents",
    fkHeader?.[1] === String(fkEdges) && fkHeader?.[2] === String(fkTables),
    `header says ${fkHeader?.[1]} edges / ${fkHeader?.[2]} tables, file holds ${fkEdges} / ${fkTables}`,
  )

  const vTables = Object.keys(CHECK_VOCABULARIES).length
  const vCols = Object.values(CHECK_VOCABULARIES).reduce((n, cols) => n + Object.keys(cols).length, 0)
  const vHeader = /MEASURED AT GENERATION: (\d+) tables, (\d+) columns/.exec(read("scripts/check-vocabularies.ts"))
  check(
    "check-vocabularies.ts's advertised counts match its contents",
    vHeader?.[1] === String(vTables) && vHeader?.[2] === String(vCols),
    `header says ${vHeader?.[1]}/${vHeader?.[2]}, file holds ${vTables}/${vCols}`,
  )

  const ltAdvertised = /EVERY relation the live public schema exposes — (\d+) of them/.exec(read("scripts/live-tables.ts"))?.[1]
  check(
    "live-tables.ts's advertised relation count matches its contents",
    ltAdvertised === String(LIVE_TABLES.length),
    `header says ${ltAdvertised}, file holds ${LIVE_TABLES.length}`,
  )

  const cols = (m: Record<string, string[]>) => Object.values(m).reduce((n, c) => n + c.length, 0)
  const afHeader =
    /MEASURED AT GENERATION: (\d+) agents\(id\) columns across (\d+) tables, (\d+) agent-ish users\(id\) columns across (\d+) tables, (\d+) contact_id tables/.exec(
      read("scripts/agent-fk-columns.ts"),
    )
  const afActual = [
    cols(AGENT_FK_COLUMNS),
    Object.keys(AGENT_FK_COLUMNS).length,
    cols(USERS_FK_AGENTISH_COLUMNS),
    Object.keys(USERS_FK_AGENTISH_COLUMNS).length,
    CONTACT_FK_TABLES.length,
  ]
  check(
    "agent-fk-columns.ts's advertised counts match its contents",
    afHeader !== null && afHeader.slice(1, 6).join("/") === afActual.join("/"),
    `header says ${afHeader?.slice(1, 6).join("/")}, file holds ${afActual.join("/")}`,
  )

  // The identity map is built from the FK graph, so every table it names must still be a live
  // relation. A cache naming a dropped table makes the guard police a column that is not there,
  // and — the direction that actually cost coverage — a cache MISSING a live table makes it
  // report zero for a surface it never looked at.
  const identityTables = [
    ...new Set([...Object.keys(AGENT_FK_COLUMNS), ...Object.keys(USERS_FK_AGENTISH_COLUMNS), ...CONTACT_FK_TABLES]),
  ]
  const identityDead = identityTables.filter((t) => !LIVE_TABLES.includes(t))
  check(
    "every table the identity map names is a live relation",
    identityDead.length === 0,
    `${identityDead.length} dead table(s) in agent-fk-columns.ts: ${identityDead.slice(0, 8).join(", ")}`,
  )

  // The two files are built from ONE reading, so this must hold by construction — it is asserted
  // because the failure it catches is silent: a snapshot regenerated against a newer database than
  // live-tables.ts would make some guarded table look retired, which is the exact bug the second
  // file exists to end.
  const notLive = Object.keys(SCHEMA_SNAPSHOT).filter((t) => !LIVE_TABLES.includes(t))
  check(
    "every table the column snapshot guards appears in the live relation list",
    notLive.length === 0,
    `${notLive.length} guarded table(s) missing from live-tables.ts: ${notLive.slice(0, 8).join(", ")} — the two caches were generated from different reads`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 2 — LIVE COMPARISON. Credentials only, and said out loud when absent.
// ─────────────────────────────────────────────────────────────────────────────

/** Every difference between two `{ table: { key: value } }` readings, named one by one. */
function diffNested(
  live: Record<string, Record<string, unknown>>,
  cached: Record<string, Record<string, unknown>>,
  label: (t: string, k: string) => string,
): string[] {
  const out: string[] = []
  const keys = (m: Record<string, Record<string, unknown>>) =>
    new Set(Object.entries(m).flatMap(([t, cols]) => Object.keys(cols).map((k) => `${t}\u0000${k}`)))
  const l = keys(live)
  const c = keys(cached)
  const show = (v: unknown) => (Array.isArray(v) ? `[${v.join(", ")}]` : String(v))
  for (const k of [...l].filter((x) => !c.has(x)).sort()) {
    const [t, col] = k.split("\u0000")
    out.push(`LIVE HAS, CACHE MISSES: ${label(t, col)} = ${show(live[t][col])}`)
  }
  for (const k of [...c].filter((x) => !l.has(x)).sort()) {
    const [t, col] = k.split("\u0000")
    out.push(`CACHE HAS, LIVE DROPPED: ${label(t, col)} = ${show(cached[t][col])}`)
  }
  for (const k of [...l].filter((x) => c.has(x)).sort()) {
    const [t, col] = k.split("\u0000")
    const a = JSON.stringify(live[t][col])
    const b = JSON.stringify(cached[t][col])
    if (a !== b) out.push(`VALUE DIFFERS: ${label(t, col)} — live ${a}, cache ${b}`)
  }
  return out
}

/** The column snapshot is `{ table: [col] }`; lift it into the nested shape so one differ serves all three. */
function liftColumns(m: Record<string, string[]>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [t, cols] of Object.entries(m)) out[t] = { columns: cols }
  return out
}

const creds = liveCredentials()
let liveRan = false

if (!creds) {
  console.log("\n[live comparison]")
  console.log("  ○ SKIPPED — no SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in this environment.")
  console.log("    The five cache files were NOT compared against the database. Nothing below")
  console.log("    claims they match it; only that they are machine-shaped and unedited.")
} else {
  console.log("\n[live comparison — the cache rebuilt from the database]")
  try {
    const [schema, fkRows, checks] = (await Promise.all([
      fetchLiveJson("live_schema_json", creds),
      fetchLiveJson("live_foreign_keys_json", creds),
      fetchLiveJson("live_check_constraints_json", creds),
    ])) as [LiveSchema, LiveFk[], LiveCheck[]]

    liveRan = true

    const rebuiltSnapshot = buildSnapshot(schema, referencedTables(root), embeddedTables(root))
    const snapshotDiff = diffNested(
      liftColumns(
        Object.fromEntries(rebuiltSnapshot.guarded.map((t) => [t, schema[t].slice().sort()])),
      ),
      liftColumns(SCHEMA_SNAPSHOT),
      (t) => `${t}.columns`,
    )
    check(
      `columns: ${rebuiltSnapshot.guarded.length} guarded tables agree with the live schema`,
      snapshotDiff.length === 0,
      snapshotDiff.slice(0, 8).join(" · "),
    )
    check(
      "columns: the committed bytes are what the generator would write",
      bodies.get("scripts/schema-snapshot.ts") === rebuiltSnapshot.body,
      "the file's data matches but its formatting does not — it was rewritten by something other than the generator",
    )

    const rebuiltLiveTables = buildLiveTables(schema)
    const ltMissing = rebuiltLiveTables.tables.filter((t) => !LIVE_TABLES.includes(t))
    const ltStale = LIVE_TABLES.filter((t) => !rebuiltLiveTables.tables.includes(t))
    check(
      `relations: all ${rebuiltLiveTables.tables.length} live relations agree with the cached list`,
      ltMissing.length === 0 && ltStale.length === 0,
      [
        ltMissing.length ? `LIVE HAS, CACHE MISSES: ${ltMissing.slice(0, 8).join(", ")}` : "",
        ltStale.length ? `CACHE HAS, LIVE DROPPED: ${ltStale.slice(0, 8).join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    )
    check(
      "relations: the committed bytes are what the generator would write",
      bodies.get("scripts/live-tables.ts") === rebuiltLiveTables.body,
      "the file's data matches but its formatting does not",
    )

    const baselinePath = join(root, "scripts/schema-drift-unguarded-baseline.json")
    const committedBaseline = JSON.parse(readFileSync(baselinePath, "utf8")) as string[]
    check(
      "columns: the unguarded baseline (referenced in code, absent from live) is current",
      JSON.stringify(committedBaseline) === JSON.stringify(rebuiltSnapshot.unguarded),
      `live says [${rebuiltSnapshot.unguarded.join(", ")}], file says [${committedBaseline.join(", ")}]`,
    )

    const rebuiltFk = buildFkMap(fkRows)
    const fkDiff = diffNested(rebuiltFk.map, SCHEMA_FK_MAP, (t, c) => `${t}.${c} →`)
    // Ambiguous pairs are flat, so they are lifted into the same nested shape to be differed.
    const liftPairs = (m: Record<string, number>): Record<string, Record<string, unknown>> => ({
      "ambiguous FK pair": m as unknown as Record<string, unknown>,
    })
    fkDiff.push(...diffNested(liftPairs(rebuiltFk.ambiguous), liftPairs(SCHEMA_FK_PAIR_CARDINALITY), (_t, k) => k))
    check(
      `foreign keys: ${rebuiltFk.facts.edges} edges and ${rebuiltFk.facts.ambiguousPairs} ambiguous pairs agree with the live schema`,
      fkDiff.length === 0,
      fkDiff.slice(0, 8).join(" · "),
    )
    check(
      "foreign keys: the committed bytes are what the generator would write",
      bodies.get("scripts/schema-fk-map.ts") === rebuiltFk.body,
      "the file's data matches but its formatting does not",
    )

    // The identity-class map comes off the SAME FK rows as the map above, so it is rebuilt from
    // this one reading rather than a second one — the two files describe the same edges and must
    // not be able to disagree about one.
    const rebuiltAgentFk = buildAgentFkColumns(fkRows)
    const liftList = (l: readonly string[]): Record<string, Record<string, unknown>> => ({
      "contact_id FK": Object.fromEntries(l.map((t) => [t, true])),
    })
    const agentFkDiff = [
      ...diffNested(liftColumns(rebuiltAgentFk.agents), liftColumns(AGENT_FK_COLUMNS), (t) => `agents(id) ${t}`),
      ...diffNested(
        liftColumns(rebuiltAgentFk.usersAgentish),
        liftColumns(USERS_FK_AGENTISH_COLUMNS),
        (t) => `agent-ish users(id) ${t}`,
      ),
      ...diffNested(liftList(rebuiltAgentFk.contacts), liftList(CONTACT_FK_TABLES), (_t, k) => `contact_id on ${k}`),
    ]
    check(
      `identity classes: ${rebuiltAgentFk.facts.agentColumns} agents(id) columns, ${rebuiltAgentFk.facts.usersAgentishColumns} agent-ish users(id) columns and ${rebuiltAgentFk.facts.contactTables} contact_id tables agree with the live schema`,
      agentFkDiff.length === 0,
      agentFkDiff.slice(0, 8).join(" · "),
    )
    check(
      "identity classes: the committed bytes are what the generator would write",
      bodies.get("scripts/agent-fk-columns.ts") === rebuiltAgentFk.body,
      "the file's data matches but its formatting does not",
    )

    const rebuiltVocab = buildVocabularies(checks)
    const vocabDiff = diffNested(rebuiltVocab.map, CHECK_VOCABULARIES, (t, c) => `${t}.${c}`)
    check(
      `CHECK vocabularies: ${rebuiltVocab.columns} columns agree with the live constraints`,
      vocabDiff.length === 0,
      vocabDiff.slice(0, 8).join(" · "),
    )
    check(
      "CHECK vocabularies: the committed bytes are what the generator would write",
      bodies.get("scripts/check-vocabularies.ts") === rebuiltVocab.body,
      "the file's data matches but its formatting does not",
    )
    for (const u of rebuiltVocab.unparsed) console.log(`   · unread text ANY-array: ${u}`)
    for (const c of rebuiltVocab.conflicts) console.log(`   · ${c}`)

    // The full difference list, so a failure names every drifted object rather than the first eight.
    const all = [...snapshotDiff, ...fkDiff, ...agentFkDiff, ...vocabDiff]
    if (all.length) {
      console.log(`\n  DRIFT, in full (${all.length}):`)
      for (const d of all) console.log(`    · ${d}`)
      console.log("\n  Fix: npm run schema:regen, review the diff, commit it with any code it breaks.")
    }
  } catch (e) {
    check("the live schema RPCs answered", false, (e as Error)?.message ?? String(e))
  }
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(" ✗ Failures:")
  for (const f of failures) console.log(`   - ${f}`)
  console.log(" ❌ SCHEMA_CACHE_DRIFT_FAIL — the cache is not the database")
  process.exit(1)
}
console.log(
  liveRan
    ? " ✅ SCHEMA_CACHE_DRIFT_PASS — stamps verified AND the cache matches the live database"
    : " ✅ SCHEMA_CACHE_STAMP_PASS — stamps verified; the live comparison did NOT run (no credentials)",
)
