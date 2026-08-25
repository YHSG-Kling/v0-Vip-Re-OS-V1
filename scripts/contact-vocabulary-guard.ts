#!/usr/bin/env tsx
/**
 * scripts/contact-vocabulary-guard.ts  (npm run test:contact-vocabulary) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE VOCABULARY, DEFINED SO IT CANNOT DRIFT.
 *
 * OWNER, verbatim: "vocabulary needs to be defined to prevent drifting."
 * OWNER, on contact_type admitting three spellings of one idea: "collapse".
 * OWNER, on personas: "luxury is a persona also."
 * OWNER, on pricing: "pricing for the platform for tenants are solo agent tier
 *   subscription, team tier subscription, brokerage tier subscription and multiple
 *   location brokerage subscription; all are paying and global platform oversees
 *   the whole os/app."
 *
 * ── WHY A GUARD AND NOT A COMMENT ───────────────────────────────────────────
 *
 * A vocabulary is not "defined" by being written down once. It is defined when
 * something FAILS the moment code and database stop agreeing. This repo has paid
 * for that lesson repeatedly — timeline drifted to six spellings, video status to
 * twenty-two, vendor category to its own set — and most recently contact_type,
 * where migration 433 renamed past_client → lifetime_customer and left every
 * `contact_type === 'lifetime'` reader behind, so canonical past clients were
 * silently classed as BUYERS and handed a buyer's reel, voicemail and portal.
 * Nothing threw. Nothing failed. The wrong people simply got the wrong message.
 *
 * THREE VOCABULARIES ARE HELD HERE, each against the LIVE CHECK constraints as
 * cached in the GENERATED scripts/check-vocabularies.ts (CLAUDE.md §3):
 *
 *   1. contacts.contact_type + campaign_sequences.contact_type  (m539)
 *   2. contacts.contact_persona + campaign_sequences.persona    (13, incl. luxury)
 *   3. the FOUR SUBSCRIPTION TIERS, across every column that carries them
 *
 * ── THE ASYMMETRY THIS GUARD ENFORCES ───────────────────────────────────────
 *
 * READERS may still accept a retired spelling — a CRM sync or a hand-typed CSV
 * can carry `past_client` for years, and `canonicalContactType` maps it forward.
 * WRITERS and DB FILTERS may not: the database refuses a retired spelling on
 * write (23514) and matches nothing on read, and supabase-js RESOLVES both, so
 * the row is lost or the query is empty in silence. So the repo scan below flags
 * a retired spelling ONLY where it reaches Postgres — a `.insert/.update/.upsert`
 * payload key or an `.eq/.neq/.in/.or` filter on contact_type — and deliberately
 * leaves alias tables and normalizers alone.
 *
 * ── MEASUREMENT DISCIPLINE (CLAUDE.md §2) ───────────────────────────────────
 * Comments are stripped with scripts/strip-comments.ts, never a hand-rolled
 * regex. Every absence assertion carries a POSITIVE CONTROL: the finder is shown
 * a fixture containing the defect it exists to catch, and must still see it.
 * The denominator (files scanned) is printed beside the count.
 */
import { readFileSync } from "node:fs"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { stripComments } from "./strip-comments"
import {
  CONTACT_TYPES,
  LIFETIME_CONTACT_TYPES,
  SPHERE_CONTACT_TYPES,
  RETIRED_CONTACT_TYPES,
  LIFETIME_CUSTOMER_TYPE,
  canonicalContactType,
  isLifetimeCustomerType,
  isStorableContactType,
  isLifetimeRelationshipType,
} from "../lib/contact-types"
import { CAMPAIGN_CONTACT_TYPES, CAMPAIGN_PERSONAS } from "../lib/campaigns/contact-sources"
import { ADS_ELIGIBLE_PERSONAS } from "../lib/ads/audience-persona-basis"
import { FB_AUDIENCE_TEMPLATES } from "../lib/ads/fb-audience-templates"
import { TIER_ORDER, TIER_SEAT_LIMITS, TIER_LABELS, isCanonicalTier } from "../lib/kernel/tier-role-matrix"
import { CANONICAL_TIERS } from "../lib/billing/plan-catalog"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

let pass = 0
let fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|")

console.log("══════════════════════════════════════════════════")
console.log(" Contact / persona / tier vocabulary — code and database, held together")
console.log("══════════════════════════════════════════════════")

// ─── 1. contact_type ─────────────────────────────────────────────────────────
console.log("\n[1 · contact_type — one spelling per idea (m539)]")

const liveContactType = CHECK_VOCABULARIES.contacts?.contact_type ?? []
const liveSequenceType = CHECK_VOCABULARIES.campaign_sequences?.contact_type ?? []

check(`the live contacts.contact_type CHECK is non-empty (${liveContactType.length} values)`,
  liveContactType.length > 0,
  "an empty vocabulary would make every assertion below vacuously true")

check("CONTACT_TYPES is EXACTLY the live contacts.contact_type CHECK",
  same(CONTACT_TYPES, liveContactType),
  `code=[${[...CONTACT_TYPES].sort().join(",")}] db=[${[...liveContactType].sort().join(",")}]`)

check("campaign_sequences.contact_type is a SUBSET of contacts.contact_type (one vocabulary, two grains)",
  liveSequenceType.every((v) => (CONTACT_TYPES as readonly string[]).includes(v)),
  liveSequenceType.filter((v) => !(CONTACT_TYPES as readonly string[]).includes(v)).join(",") || "—")

check("CAMPAIGN_CONTACT_TYPES is EXACTLY the live campaign_sequences.contact_type CHECK",
  same(CAMPAIGN_CONTACT_TYPES, liveSequenceType),
  `code=[${[...CAMPAIGN_CONTACT_TYPES].sort().join(",")}] db=[${[...liveSequenceType].sort().join(",")}]`)

check("the two contact_type columns agree on how they spell the lifetime customer",
  liveContactType.includes(LIFETIME_CUSTOMER_TYPE) && liveSequenceType.includes(LIFETIME_CUSTOMER_TYPE))

const retired = Object.keys(RETIRED_CONTACT_TYPES)
check(`no RETIRED spelling is still admitted anywhere (${retired.join(", ")})`,
  retired.every((r) => !liveContactType.includes(r) && !liveSequenceType.includes(r)),
  retired.filter((r) => liveContactType.includes(r) || liveSequenceType.includes(r)).join(",") || "—")

check("every retired spelling maps to a survivor the database DOES admit",
  Object.values(RETIRED_CONTACT_TYPES).every((v) => liveContactType.includes(v)))

check("LIFETIME_CONTACT_TYPES is entirely storable (the audience/sphere filters can match)",
  LIFETIME_CONTACT_TYPES.every(isStorableContactType),
  LIFETIME_CONTACT_TYPES.filter((t) => !isStorableContactType(t)).join(",") || "—")

check("SPHERE_CONTACT_TYPES is entirely storable and is a superset of the lifetime roster",
  SPHERE_CONTACT_TYPES.every(isStorableContactType)
  && LIFETIME_CONTACT_TYPES.every((t) => (SPHERE_CONTACT_TYPES as readonly string[]).includes(t)))

console.log("\n[1b · the reader stays tolerant, the writer does not]")
check("canonicalContactType maps every retired spelling onto its survivor",
  retired.every((r) => canonicalContactType(r) === RETIRED_CONTACT_TYPES[r]))
check("canonicalContactType passes a storable value through unchanged",
  CONTACT_TYPES.every((t) => canonicalContactType(t) === t))
check("canonicalContactType returns null for a value that is not a contact_type at all",
  canonicalContactType("tenant") === null && canonicalContactType("") === null && canonicalContactType(null) === null)
check("isStorableContactType REFUSES a retired spelling (this is the write-side rule)",
  retired.every((r) => !isStorableContactType(r)))
check("isLifetimeCustomerType is true for the survivor AND for every retired spelling",
  isLifetimeCustomerType(LIFETIME_CUSTOMER_TYPE) && retired.every(isLifetimeCustomerType))
check("isLifetimeCustomerType is false for a buyer/seller",
  !isLifetimeCustomerType("buyer") && !isLifetimeCustomerType("seller") && !isLifetimeCustomerType(null))
check("isLifetimeRelationshipType covers the whole roster, and no more",
  LIFETIME_CONTACT_TYPES.every(isLifetimeRelationshipType)
  && !isLifetimeRelationshipType("buyer") && !isLifetimeRelationshipType("lead"))
check("a retired spelling still resolves as a lifetime RELATIONSHIP (a legacy row is not orphaned)",
  retired.every(isLifetimeRelationshipType))

// ─── 2. the repo scan ────────────────────────────────────────────────────────
console.log("\n[2 · repo scan — no retired spelling may reach Postgres]")

// TOMBSTONE (orphan doctrine §1.1) — the private `walk()` generator that stood
// here was one of 82 copies of the same readdirSync walker. The survivor is
// scripts/runtime-roots.ts:61 (`walkTs`), imported above.
//
// It enumerated DIRECTORIES, and a root-level FILE is not a directory, so
// `proxy.ts` — the Next 16 edge middleware, which gates auth and queries
// blog_posts, brokerages, users and tenant_custom_domains with a SERVICE client on
// EVERY request — was outside this guard's corpus. A file that is never opened
// reports green. `rootRuntimeFiles()` from the same survivor supplies the root
// files, so the directory loop is no longer the whole answer to "what ships".

export interface RetiredHit { file: string; line: number; kind: "write" | "filter"; value: string; text: string }

/**
 * PURE — every place a RETIRED contact_type spelling reaches the database.
 *
 * TWO SHAPES, and only two:
 *   · `contact_type: "past_client"` inside an .insert/.update/.upsert payload
 *   · `.eq/.neq("contact_type", "past_client")`, `.in("contact_type", [… ])`,
 *     `.or("contact_type.eq.past_client…")`
 *
 * A bare `x === "past_client"` is NOT flagged: comparing a value already read out
 * of the database against a legacy spelling is the tolerant-reader behaviour this
 * vocabulary deliberately keeps.
 */
export function scanRetiredContactTypes(rawSrc: string, file: string): RetiredHit[] {
  const src = stripComments(rawSrc)
  const out: RetiredHit[] = []
  const lineOf = (i: number) => src.slice(0, i).split("\n").length
  const alt = retired.map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  if (!alt) return out

  // Payload key inside a mutation argument.
  const writeRe = new RegExp(`\\.(?:insert|update|upsert)\\s*\\(([\\s\\S]{0,900}?)\\)`, "g")
  let m: RegExpExecArray | null
  while ((m = writeRe.exec(src))) {
    const payload = m[1]
    const keyRe = new RegExp(`\\bcontact_type\\s*:\\s*["'](${alt})["']`, "g")
    let k: RegExpExecArray | null
    while ((k = keyRe.exec(payload))) {
      const at = m.index + m[0].indexOf(payload) + k.index
      out.push({ file, line: lineOf(at), kind: "write", value: k[1], text: k[0] })
    }
  }

  // Filters.
  const eqRe = new RegExp(`\\.(?:eq|neq)\\(\\s*["']contact_type["']\\s*,\\s*["'](${alt})["']\\s*\\)`, "g")
  while ((m = eqRe.exec(src))) out.push({ file, line: lineOf(m.index), kind: "filter", value: m[1], text: m[0] })

  const inRe = /\.in\(\s*["']contact_type["']\s*,\s*\[([^\]]*)\]/g
  while ((m = inRe.exec(src))) {
    const litRe = new RegExp(`["'](${alt})["']`, "g")
    let l: RegExpExecArray | null
    while ((l = litRe.exec(m[1]))) out.push({ file, line: lineOf(m.index), kind: "filter", value: l[1], text: m[0] })
  }

  const orRe = /\.or\(\s*["'`]([^"'`\n]*)["'`]/g
  while ((m = orRe.exec(src))) {
    for (const clause of m[1].split(",")) {
      const parts = clause.split(".")
      if (parts.length >= 3 && parts[0] === "contact_type" && (parts[1] === "eq" || parts[1] === "neq")) {
        const v = parts.slice(2).join(".")
        if (retired.includes(v)) out.push({ file, line: lineOf(m.index), kind: "filter", value: v, text: clause })
      }
    }
  }
  return out
}

console.log("\n  [positive controls — the finder must still recognise the defect]")
check("POSITIVE CONTROL · flags a retired spelling in a write payload",
  scanRetiredContactTypes(`svc.from("contacts").update({ contact_type: "past_client" })`, "t").length === 1)
check("POSITIVE CONTROL · flags a retired spelling in an .eq filter",
  scanRetiredContactTypes(`svc.from("contacts").select("*").eq("contact_type", "lifetime")`, "t").length === 1)
check("POSITIVE CONTROL · flags every retired element of an .in list",
  scanRetiredContactTypes(`q.in("contact_type", ["past_client", "sphere", "lifetime"])`, "t").length === 2)
check("POSITIVE CONTROL · flags a retired spelling inside a PostgREST .or clause",
  scanRetiredContactTypes(`q.or("contact_type.eq.past_client,nurture_status.eq.closed")`, "t").length === 1)
check("accepts the SURVIVOR in all four shapes",
  scanRetiredContactTypes(
    `svc.from("contacts").update({ contact_type: "lifetime_customer" })\n` +
    `q.eq("contact_type", "lifetime_customer")\n` +
    `q.in("contact_type", ["lifetime_customer", "sphere"])\n` +
    `q.or("contact_type.eq.lifetime_customer")`, "t").length === 0)
check("does NOT flag a tolerant READER comparing a stored value to a legacy spelling",
  scanRetiredContactTypes(`if (c.contact_type === "past_client") return "homeowner"`, "t").length === 0)
check("does NOT flag nurture_status, which is a different column with no CHECK",
  scanRetiredContactTypes(`q.or("nurture_status.eq.past_client")`, "t").length === 0)
check("never reads its own documentation",
  scanRetiredContactTypes(`// q.eq("contact_type", "past_client")`, "t").length === 0)

const files: string[] = []
for (const d of ["app", "lib", "services", "scripts", "components", "hooks", "contexts", "constants", "workflows"]) {
  for (const f of walkTs(join(ROOT, d))) files.push(f)
}
// Root-level runtime FILES are not directories, so the loop above cannot reach them.
for (const f of rootRuntimeFiles(ROOT)) files.push(f)
const hits: RetiredHit[] = []
for (const f of files) {
  let src = ""
  try { src = readFileSync(f, "utf8") } catch { continue }
  const rel = relative(ROOT, f).replace(/\\/g, "/")
  // This file's own POSITIVE CONTROLS are retired spellings on purpose — scanning
  // them would make the guard permanently red at itself.
  if (rel === "scripts/contact-vocabulary-guard.ts") continue
  if (!/lifetime|past_client|past_seller/.test(src)) continue
  hits.push(...scanRetiredContactTypes(src, rel))
}
console.log(`  · ${files.length} .ts/.tsx files scanned across app/ lib/ services/ scripts/ components/ hooks/ contexts/ constants/ workflows/`)
console.log(`  · BLIND SPOTS, stated: remote/e2e/ and remotion/ are not scanned; a filter built through a`)
console.log(`    variable rather than a literal is invisible here, as is one assembled by string concat.`)
check(`no retired contact_type spelling reaches Postgres (${hits.length} found)`,
  hits.length === 0,
  hits.slice(0, 10).map((h) => `${h.file}:${h.line} ${h.kind} "${h.value}"`).join("; "))

// ─── 3. the lifetime-customer promotion invariant ────────────────────────────
console.log("\n[3 · promotion writers — contact_type and lifecycle_state are one fact in two columns]")
//
// m539 DROPPED `contacts_lifetime_consistent` rather than re-pointing it onto the
// survivor: all three promotion writers swallow their result, so a refused UPDATE
// would look exactly like a success and closed deals would stop becoming lifetime
// customers in silence (CLAUDE.md §3 — supabase-js RESOLVES refusals). The
// invariant lives at the writers instead, and this is what keeps it there.
const PROMOTION_WRITERS = [
  "lib/kernel/transactions.ts",
  "lib/transactions/stage-progression.ts",
  "app/actions/listing-lifecycle-core.ts",
]
for (const rel of PROMOTION_WRITERS) {
  let src = ""
  try { src = stripComments(readFileSync(join(ROOT, rel), "utf8")) } catch { /* reported below */ }
  const mutations = [...src.matchAll(/\.update\s*\(\s*\{([\s\S]{0,700}?)\}\s*\)/g)].map((m) => m[1])
  const promotions = mutations.filter((p) => /\bcontact_type\s*:\s*(?:LIFETIME_CUSTOMER_TYPE|["']lifetime_customer["'])/.test(p))
  check(`${rel} promotes to lifetime_customer at least once`, promotions.length > 0)
  check(`${rel} sets lifecycle_state in EVERY lifetime promotion it makes`,
    promotions.length > 0 && promotions.every((p) => /\blifecycle_state\s*:/.test(p)),
    `${promotions.filter((p) => !/\blifecycle_state\s*:/.test(p)).length} promotion(s) without it`)
}
check("POSITIVE CONTROL — that promotion scanner sees a promotion that FORGETS lifecycle_state",
  (() => {
    const p = `.update({ contact_type: LIFETIME_CUSTOMER_TYPE, updated_at: now })`
    const m = [...p.matchAll(/\.update\s*\(\s*\{([\s\S]{0,700}?)\}\s*\)/g)].map((x) => x[1])
    return m.length === 1 && /\bcontact_type\s*:\s*LIFETIME_CUSTOMER_TYPE/.test(m[0]) && !/\blifecycle_state\s*:/.test(m[0])
  })())

// ─── 4. persona ──────────────────────────────────────────────────────────────
console.log("\n[4 · persona — thirteen, and luxury is one of them]")

const livePersona = CHECK_VOCABULARIES.contacts?.contact_persona ?? []
const liveSeqPersona = CHECK_VOCABULARIES.campaign_sequences?.persona ?? []

check(`the live contacts.contact_persona CHECK is non-empty (${livePersona.length} values)`, livePersona.length > 0)
check("CAMPAIGN_PERSONAS is EXACTLY the live contacts.contact_persona CHECK",
  same(CAMPAIGN_PERSONAS, livePersona),
  `code=[${[...CAMPAIGN_PERSONAS].sort().join(",")}] db=[${[...livePersona].sort().join(",")}]`)
check("contacts.contact_persona and campaign_sequences.persona are the SAME vocabulary",
  same(livePersona, liveSeqPersona),
  `contacts=[${[...livePersona].sort().join(",")}] sequences=[${[...liveSeqPersona].sort().join(",")}]`)

// OWNER: "luxury is a persona also."
check("OWNER RULING — `luxury` is a persona the DATABASE admits, on both columns",
  livePersona.includes("luxury") && liveSeqPersona.includes("luxury"))
check("OWNER RULING — `luxury` is in the canonical code union",
  (CAMPAIGN_PERSONAS as readonly string[]).includes("luxury"))
check("OWNER RULING — `luxury` is ads-ELIGIBLE (nothing treats it as questionable)",
  (ADS_ELIGIBLE_PERSONAS as readonly string[]).includes("luxury"))
check("OWNER RULING — `luxury` ships an ad audience template like the other eligible personas",
  FB_AUDIENCE_TEMPLATES.some((t) => t.id === "persona_luxury" && t.description.trim().length > 0))
check("EVERY ads-eligible persona ships a template — luxury is not a special case",
  ADS_ELIGIBLE_PERSONAS.every((p) => FB_AUDIENCE_TEMPLATES.some((t) => t.id === `persona_${p}`)),
  ADS_ELIGIBLE_PERSONAS.filter((p) => !FB_AUDIENCE_TEMPLATES.some((t) => t.id === `persona_${p}`)).join(",") || "—")
check("POSITIVE CONTROL — the template finder reports a MISS for a persona that has none",
  !FB_AUDIENCE_TEMPLATES.some((t) => t.id === "persona_not_a_persona"))

// The two axes overlap in exactly ONE place, by design: both vocabularies carry the
// catch-all `other`, which names the absence of an answer on whichever axis it sits on
// rather than a shared meaning. Every OTHER collision would be the m531 defect — a
// contact TYPE stored in the persona column — so the assertion is written to allow that
// one word and nothing else.
const AXIS_CATCH_ALL = "other"
check("the two axes do not overlap, apart from the shared catch-all `other`",
  CAMPAIGN_PERSONAS.every((p) => p === AXIS_CATCH_ALL || !(CONTACT_TYPES as readonly string[]).includes(p)),
  CAMPAIGN_PERSONAS.filter((p) => p !== AXIS_CATCH_ALL && (CONTACT_TYPES as readonly string[]).includes(p)).join(",") || "—")
check("POSITIVE CONTROL — that overlap scanner catches a contact TYPE wearing a persona label",
  ([...CAMPAIGN_PERSONAS, "sphere"] as readonly string[])
    .filter((p) => p !== AXIS_CATCH_ALL && (CONTACT_TYPES as readonly string[]).includes(p)).length === 1)

// ─── 5. the four subscription tiers ──────────────────────────────────────────
console.log("\n[5 · the FOUR subscription tiers — all paying, seats 2/5/50/unlimited]")
//
// OWNER: "pricing for the platform for tenants are solo agent tier subscription, team
// tier subscription, brokerage tier subscription and multiple location brokerage
// subscription; all are paying and global platform oversees the whole os/app."
//
// FOUR AXES STAY SEPARATE (lib/kernel/tier-role-matrix.ts): tier / seats / user type /
// permission roles. A TIER RESTRICTS HOW MANY SEATS, NEVER WHICH USER TYPES — so this
// section asserts the seat ladder and says nothing about the role menu, which is
// deliberately identical on every tier.

const TIER_COLUMNS: Array<[string, string]> = [
  ["brokerages", "plan_tier"],
  ["plan_limits", "plan_tier"],
  ["subscription_tiers", "tier_name"],
  ["platform_coupons", "applies_to_tier"],
]

check(`TIER_ORDER names exactly four tiers (${TIER_ORDER.join(", ")})`, TIER_ORDER.length === 4)

for (const [table, column] of TIER_COLUMNS) {
  const live = CHECK_VOCABULARIES[table]?.[column] ?? []
  check(`${table}.${column} admits EXACTLY the four canonical tiers`,
    same(TIER_ORDER, live),
    `code=[${[...TIER_ORDER].sort().join(",")}] db=[${[...live].sort().join(",")}]`)
}

// platform_prospects.role_interest is the ONE tier-shaped column that legitimately
// carries a fifth value: a prospect who has not said which plan they want. That is a
// sales-funnel fact, not a tier — asserted explicitly so it can never quietly widen.
const prospectTiers = CHECK_VOCABULARIES.platform_prospects?.role_interest ?? []
check("platform_prospects.role_interest is the four tiers PLUS 'unknown', and nothing else",
  same(prospectTiers, [...TIER_ORDER, "unknown"]),
  `db=[${[...prospectTiers].sort().join(",")}]`)

check("lib/billing/plan-catalog.ts CANONICAL_TIERS agrees with TIER_ORDER",
  same(CANONICAL_TIERS, TIER_ORDER),
  `catalog=[${[...CANONICAL_TIERS].sort().join(",")}] matrix=[${[...TIER_ORDER].sort().join(",")}]`)

check("isCanonicalTier accepts all four and refuses anything else",
  TIER_ORDER.every(isCanonicalTier)
  && !isCanonicalTier("free") && !isCanonicalTier("enterprise") && !isCanonicalTier(null))

// OWNER: solo_agent 2 · team 5 · brokerage 50 · multi_location unlimited.
const SEAT_LADDER: Record<string, number | null> = {
  solo_agent: 2, team: 5, brokerage: 50, multi_location: null,
}
check("the seat ladder is 2 / 5 / 50 / unlimited, exactly",
  TIER_ORDER.every((t) => TIER_SEAT_LIMITS[t] === SEAT_LADDER[t]),
  TIER_ORDER.filter((t) => TIER_SEAT_LIMITS[t] !== SEAT_LADDER[t]).map((t) => `${t}=${TIER_SEAT_LIMITS[t]}`).join(",") || "—")
check("the seat cap is STRICTLY ascending, and only the top tier is unlimited",
  TIER_ORDER.slice(0, -1).every((t, i) => {
    const a = TIER_SEAT_LIMITS[t], b = TIER_SEAT_LIMITS[TIER_ORDER[i + 1]]
    return a !== null && (b === null || b > a)
  }) && TIER_SEAT_LIMITS[TIER_ORDER[TIER_ORDER.length - 1]] === null)
check("ALL FOUR tiers are PAYING — there is no free tier in the vocabulary",
  !TIER_ORDER.some((t) => /free|trial|starter_free/i.test(t))
  && TIER_ORDER.every((t) => (TIER_LABELS[t] ?? "").trim().length > 0),
  "live subscription_tiers on 2026-08-23: 9900 / 29900 / 79900 / 199900 cents monthly, all is_active")
check("POSITIVE CONTROL — the tier finder rejects a tier the vocabulary does not name",
  !same([...TIER_ORDER, "free"], TIER_ORDER) && !isCanonicalTier("free"))

// ─── Result ──────────────────────────────────────────────────────────────────
console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log(" ✗ Failures:")
  for (const f of fails) console.log(`   - ${f}`)
  console.log(" ❌ CONTACT_VOCABULARY_FAIL — code and the live CHECK constraints have drifted apart")
  process.exit(1)
}
console.log(" ✅ CONTACT_VOCABULARY_PASS — contact_type, persona and tier each mean one thing in code and in the database")
