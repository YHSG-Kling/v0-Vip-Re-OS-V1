#!/usr/bin/env tsx
/**
 * scripts/manager-cross-cooperation-guard.ts   (npm run test:manager-cross-cooperation)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CROSS-COOPERATION GUARD — the cooperation the registry DECLARES is the
 * cooperation the bus LICENSES (wave 79, lane E; owner: "manager ownership is
 * setup to be cross-cooperated").
 *
 * THE DEFECT, measured 2026-09-23 on base bacdcdb9: MAINTENANCE_DOMAINS had 1063
 * entries; 75 said "CROSS-COOPERATED … co-owners …" in PROSE; those 75 named 152
 * (accountable, co-owner) pairs; 58 of the pairs shared NO MANAGER_COLLABORATIONS
 * domain, so canRefer() — the one gate the cross_manager_referral handler runs
 * (lib/managers/cross-referral.ts:97) — would have REFUSED a referral on the very
 * seam the entry documents. One entry (unread_compliance_verdict) even wrote "the
 * overlap is already carried by MANAGER_COLLABORATIONS" about an edge that did not
 * exist. Prose is not a wire (CLAUDE.md §1: a duplicate spelling of one fact is a
 * defect — §6). The fix is STRUCTURE: `coOwners` on the entry (lib/kernel/
 * manager-registry.ts::MaintenanceDomain) plus eleven collaboration domains whose
 * evidence is the proof-backed entries that already named the co-work.
 *
 * WHAT THIS ASSERTS (each with a positive control that a fixture defect is caught):
 *   1. every coOwners key is a real manager and never the accountable one
 *   2. every (manager, coOwner) pair is a declared edge (canRefer) — the bus admits it
 *   3. every coOwner is NAMED in the entry's own prose (key or label) — structure
 *      cannot invent a co-owner the entry never argued for
 *   4. every entry whose prose names a specific co-owner after a cooperation marker
 *      carries coOwners — prose and structure cannot drift apart
 *   5. shrink-only ratchet: the number of prose-declared entries WITHOUT coOwners
 *      (today 0) cannot grow, and the licensed-pair count cannot fall
 *
 * DENOMINATORS AND BLIND SPOTS are printed beside every number. The prose scan is
 * token proximity, not parsing: a manager named in the cooperation segment as a
 * NON-owner ("keeps this off listing_concierge") reads as named — that is why the
 * prose check runs only in the direction "structure ⊆ prose", never "prose ⇒
 * structure" for individual keys. Entries whose prose declares cooperation with
 * "every manager" and names none are counted and listed, not failed. Pure: no
 * network, no database.
 */
import { MAINTENANCE_DOMAINS, MANAGERS, MANAGER_COLLABORATIONS, canRefer, type ManagerKey } from "../lib/kernel/manager-registry"

/** The entry shape, derived from the table itself (the interface is file-local by design — no proof-only export). */
type MaintenanceDomain = (typeof MAINTENANCE_DOMAINS)[string]

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}

const KEYS = Object.keys(MANAGERS) as ManagerKey[]
const LABEL_TO_KEY = new Map<string, ManagerKey>(KEYS.map((k) => [MANAGERS[k].label, k]))
const KEY_RE = new RegExp(`\\b(${KEYS.join("|")})\\b`, "g")
const LABEL_RE = new RegExp(`(${[...LABEL_TO_KEY.keys()].map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g")
/** The cooperation marker — the spellings the registry actually uses. */
const MARKER_RE = /CROSS-COOPERATED|[Cc]o-own|CO-OWN|co-steward/

/** Manager keys named in the prose AFTER the first cooperation marker (by key or label). */
function namedInProse(entry: MaintenanceDomain): Set<ManagerKey> {
  const m = MARKER_RE.exec(entry.what)
  const out = new Set<ManagerKey>()
  if (!m) return out
  // 240 chars BEFORE the marker too: "…with finance_manager co-owning the books" puts the subject first.
  const seg = entry.what.slice(Math.max(0, m.index - 240))
  for (const x of seg.matchAll(KEY_RE)) out.add(x[1] as ManagerKey)
  for (const x of seg.matchAll(LABEL_RE)) out.add(LABEL_TO_KEY.get(x[1])!)
  // "CROSS-COOPERATED, declared not picked: MANAGER_COLLABORATIONS.<key>" names the
  // co-owners BY THE DOMAIN — the strongest naming there is, since the domain is the wire.
  for (const x of seg.matchAll(/MANAGER_COLLABORATIONS\.([a-z0-9_]+)/g)) for (const k of MANAGER_COLLABORATIONS[x[1]]?.managers ?? []) out.add(k)
  out.delete(entry.manager)
  return out
}

interface Verdict {
  unknownOrSelf: string[]
  unlicensed: string[]
  notInProse: string[]
  proseWithoutStructure: string[]
  declaredNamingNobody: string[]
  declaredEntries: number
  structuredEntries: number
  pairs: number
}

/** The whole judgement as a pure function of a registry slice, so a fixture can be judged the same way. */
function judge(domains: Record<string, MaintenanceDomain>, refer: (a: string, b: string) => boolean): Verdict {
  const v: Verdict = { unknownOrSelf: [], unlicensed: [], notInProse: [], proseWithoutStructure: [], declaredNamingNobody: [], declaredEntries: 0, structuredEntries: 0, pairs: 0 }
  for (const [key, d] of Object.entries(domains)) {
    const prose = namedInProse(d)
    const declared = MARKER_RE.test(d.what)
    if (declared) v.declaredEntries++
    if (d.coOwners) {
      v.structuredEntries++
      for (const co of d.coOwners) {
        v.pairs++
        if (!(co in MANAGERS) || co === d.manager) v.unknownOrSelf.push(`${key}: ${co}`)
        else if (!refer(d.manager, co)) v.unlicensed.push(`${key}: ${d.manager} ↔ ${co}`)
        if (!prose.has(co)) v.notInProse.push(`${key}: ${co}`)
      }
    } else if (declared) {
      if (prose.size > 0) v.proseWithoutStructure.push(`${key}: prose names ${[...prose].join(", ")}`)
      else v.declaredNamingNobody.push(key)
    }
  }
  return v
}

// ─── Positive controls — the judge sees each defect it exists for ───────────
console.log("\n[positive controls — a fixture defect is caught]")
const okWhat = "… CROSS-COOPERATED: data_steward is accountable; co-owners: compliance_officer (the consent record)."
const fx = (over: Partial<MaintenanceDomain>): MaintenanceDomain => ({ manager: "data_steward", proof: "test:x", what: okWhat, coOwners: ["compliance_officer"], ...over })
const licensed = (a: string, b: string) => a !== b
const unlicensedAll = () => false
check("CONTROL a clean entry (co-owner real, named in prose, edge licensed) raises nothing",
  JSON.stringify(judge({ ok: fx({}) }, licensed)).includes('"unlicensed":[]') && judge({ ok: fx({}) }, licensed).notInProse.length === 0 && judge({ ok: fx({}) }, licensed).proseWithoutStructure.length === 0)
check("CONTROL a coOwner with NO collaboration edge is caught (unlicensed)",
  judge({ bad: fx({}) }, unlicensedAll).unlicensed.length === 1)
check("CONTROL a coOwner equal to the accountable manager is caught",
  judge({ bad: fx({ coOwners: ["data_steward"] }) }, licensed).unknownOrSelf.length === 1)
check("CONTROL a coOwner that is not a manager key is caught",
  judge({ bad: fx({ coOwners: ["broker_ops" as ManagerKey] }) }, licensed).unknownOrSelf.length === 1)
check("CONTROL a coOwner the prose never names is caught (structure cannot invent)",
  judge({ bad: fx({ coOwners: ["finance_manager"] }) }, licensed).notInProse.length === 1)
check("CONTROL prose that names a co-owner with NO coOwners field is caught (prose and structure cannot drift)",
  judge({ bad: fx({ coOwners: undefined }) }, licensed).proseWithoutStructure.length === 1)
check("CONTROL a label spelling ('Compliance Officer') counts as naming the co-owner",
  judge({ ok: fx({ what: "… with the Compliance Officer co-owning the consent record" }) }, licensed).notInProse.length === 0)
check("CONTROL a subject BEFORE the marker ('finance_manager co-owns …') counts as named",
  judge({ ok: fx({ what: "… data_steward is accountable; finance_manager co-owns the books", coOwners: ["finance_manager"] }) }, licensed).notInProse.length === 0)
check("CONTROL naming a MANAGER_COLLABORATIONS domain names its managers (the domain IS the wire)",
  judge({ ok: fx({ what: "CROSS-COOPERATED, declared not picked: MANAGER_COLLABORATIONS.closing_money_and_risk", manager: "deal_coordinator", coOwners: ["finance_manager", "compliance_officer"] }) }, licensed).notInProse.length === 0)
check("CONTROL an entry with no marker and no coOwners is single-owned, not a finding",
  (() => { const v = judge({ solo: fx({ what: "plain single-owner prose", coOwners: undefined }) }, licensed); return v.declaredEntries === 0 && v.proseWithoutStructure.length === 0 })())
check("CONTROL prose declaring cooperation with 'every manager' and naming none is counted, not failed",
  judge({ all: fx({ what: "CROSS-COOPERATED: every manager is a co-beneficiary", coOwners: undefined }) }, licensed).declaredNamingNobody.length === 1)

// ─── The real registry ──────────────────────────────────────────────────────
console.log("\n[registry — MAINTENANCE_DOMAINS × MANAGER_COLLABORATIONS]")
const v = judge(MAINTENANCE_DOMAINS, canRefer)
const total = Object.keys(MAINTENANCE_DOMAINS).length
const edgesUsed = new Set<string>()
for (const d of Object.values(MAINTENANCE_DOMAINS)) for (const co of d.coOwners ?? []) edgesUsed.add([d.manager, co].sort().join("↔"))
console.log(`  · ${total} maintenance domains · ${v.declaredEntries} declare cooperation in prose · ${v.structuredEntries} carry coOwners · ${v.pairs} (accountable, co-owner) pairs over ${edgesUsed.size} distinct edges · ${Object.keys(MANAGER_COLLABORATIONS).length} collaboration domains`)
console.log(`  · BLIND SPOT: prose naming is token proximity (key or label within the cooperation segment + 240 chars before it), not a parse — a manager named there as a NON-owner reads as named, so the prose check only ever runs structure ⊆ prose`)
if (v.declaredNamingNobody.length) console.log(`  · ${v.declaredNamingNobody.length} entr${v.declaredNamingNobody.length === 1 ? "y" : "ies"} declare cooperation naming no specific co-owner (counted, not failed): ${v.declaredNamingNobody.join(", ")}`)

check("every coOwner is a real manager and never the accountable one", v.unknownOrSelf.length === 0, v.unknownOrSelf.join("; "))
check("every (accountable, coOwner) pair is a declared MANAGER_COLLABORATIONS edge — the referral bus admits it", v.unlicensed.length === 0, v.unlicensed.join("; "))
check("every coOwner is named in the entry's own prose — structure cannot invent a co-owner", v.notInProse.length === 0, v.notInProse.join("; "))
check("every entry whose prose names a co-owner carries coOwners — prose and structure cannot drift", v.proseWithoutStructure.length === 0, v.proseWithoutStructure.join("; "))
check("the collaboration domains added for this are NON-deliberative controls/handoffs (no seat minted for its own sake)",
  ["tenant_identity_controls", "consent_before_contact", "listing_compliance_checkpoint", "script_compliance_first", "client_moment_videos", "ai_spend_ledger", "paid_media_spend_cap", "buyer_tour_to_deal_story", "internal_door_secrets_and_clock", "listing_media_retention", "subscription_lifecycle_fanout"]
    .every((k) => MANAGER_COLLABORATIONS[k] && MANAGER_COLLABORATIONS[k].deliberate !== true && MANAGER_COLLABORATIONS[k].managers.length >= 2))
check("every wave-79 collaboration domain's evidence names at least one MAINTENANCE_DOMAINS entry that exists (evidence, not aspiration)",
  ["tenant_identity_controls", "consent_before_contact", "listing_compliance_checkpoint", "script_compliance_first", "client_moment_videos", "ai_spend_ledger", "paid_media_spend_cap", "buyer_tour_to_deal_story", "internal_door_secrets_and_clock", "listing_media_retention", "subscription_lifecycle_fanout"]
    .every((k) => { const m = MANAGER_COLLABORATIONS[k].evidence.match(/MAINTENANCE_DOMAINS\.([a-z0-9_]+)/); return !!m && m[1] in MAINTENANCE_DOMAINS }))
check("every collaboration domain is co-signed by ≥1 maintenance domain OR carries its own catalogued evidence (no edge without a reason)",
  Object.values(MANAGER_COLLABORATIONS).every((d) => d.evidence.length > 40))
// Ratchet: structure may only grow, drift may only shrink.
check("ratchet — prose-declared entries without coOwners stay at 0", v.proseWithoutStructure.length === 0)
check("ratchet — at least the 152 pairs measured 2026-09-23 are structured (a lane cannot un-declare a cooperation to move a number)", v.pairs >= 152, `now ${v.pairs}`)

// ─── Registration ───────────────────────────────────────────────────────────
console.log("\n[registration]")
import { readFileSync } from "node:fs"
import { join } from "node:path"
const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> }
check("package.json wires this proof and the guard chain runs it", pkg.scripts["test:manager-cross-cooperation"]?.includes("manager-cross-cooperation-guard") === true && pkg.scripts.guard.includes("npm run test:manager-cross-cooperation"))
check("MAINTENANCE_DOMAINS carries this guard, itself cross-cooperated through the field it introduces",
  MAINTENANCE_DOMAINS.manager_cross_cooperation?.proof === "test:manager-cross-cooperation" && (MAINTENANCE_DOMAINS.manager_cross_cooperation.coOwners?.length ?? 0) > 0)

console.log(`\n──────────────────────────────────────────────────\n RESULT: ${passed} passed, ${failed} failed`)
if (failed) { console.log(` ✗ Failures:\n${failures.map((f) => `   - ${f}`).join("\n")}\n ❌ MANAGER_CROSS_COOPERATION_FAIL`); process.exit(1) }
console.log(` ✅ MANAGER_CROSS_COOPERATION_PASS — every declared co-ownership is a real, named, bus-licensed edge (${v.pairs} pairs, ${edgesUsed.size} edges, ${Object.keys(MANAGER_COLLABORATIONS).length} domains)`)
