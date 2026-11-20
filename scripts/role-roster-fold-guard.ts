/**
 * scripts/role-roster-fold-guard.ts — wave 155, lane 155K2 (open-loop rows 143G-OL-05 / 146I-OL-03; directive item 8).
 *
 * THE RULE: a `.in("user_type", [...])` role list names the roster BY DERIVATION — TENANT_ADMIN_USER_TYPES and the tiers that
 * subtract from it (lib/auth/resolve-user-role.ts), LEAD_DESK_USER_TYPES (lib/auth/lead-visibility.ts) — never by retyping it. A
 * hand-typed list drifts: when broker_owner, broker_admin and compliance_officer became seats, every hand-typed copy silently kept
 * the old set (CLAUDE.md §4: "never copy the list, spread the Set").
 *
 * WHAT IT CHECKS (stripped source via scripts/strip-comments.ts — a tombstone naming an old list is not a call site):
 *   R1 CENSUS — every `.in("user_type", <array literal>)` in app/ + lib/, DERIVED, never pinned. A list whose members are ALL
 *      string literals is HAND-TYPED.
 *   R2 RATCHET — every hand-typed list left in the tree is CLASSIFIED below with the reason it is not an admin gate (a display
 *      filter, a picker, a sender pick, a non-roster recipient set). An unclassified hand-typed list is RED; a classification that
 *      no longer matches is RED (stale); a "left" list made only of admin-roster members is RED (that shape must fold).
 *   R3 FOLD LEDGER — every list folded in wave 155 records who it admitted BEFORE; the guard evaluates the folded expression
 *      against the REAL roster Sets over the STORABLE users.user_type vocabulary (scripts/check-vocabularies.ts, generated from
 *      the live CHECK) and requires (after − before) to equal the declared delta and (before − after) to be empty.
 *   R4 SCOPES — vendor, contact, TC, team lead, compliance officer, office: a POSITIVE and a NEGATIVE test each.
 * Each finder has a POSITIVE CONTROL. SIMULATED: no database, no network.
 * BLIND SPOTS (published): a role list held in a local const and passed by name (`.in("user_type", COACH_ROLES)`) is reported, not
 * judged; `.eq("user_type", "…")` single-role filters and `rawRoleVariantsFor([…])` expander literals are counted and published only.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import {
  TENANT_ADMIN_USER_TYPES, BROKERAGE_FINANCE_ADMIN_USER_TYPES, TENANT_COMMERCE_ADMIN_USER_TYPES,
} from "../lib/auth/resolve-user-role"
import { LEAD_DESK_USER_TYPES } from "../lib/auth/lead-visibility"
import { isLenderVendorCategory } from "../lib/kernel/lender-linkage"

const root = process.cwd()
let failures = 0
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`); if (!ok) failures++ }
const control = (name: string, ok: boolean) => check(`POSITIVE CONTROL: ${name}`, ok)

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e) && !/\.d\.ts$/.test(e)) out.push(p)
  }
  return out
}

/** The STORABLE seat vocabulary — the live CHECK, generated. "Who a list admits" is measured over these values only. */
const STORABLE: ReadonlySet<string> = new Set(CHECK_VOCABULARIES.users?.user_type ?? [])
const NAMED: Record<string, ReadonlySet<string>> = {
  TENANT_ADMIN_USER_TYPES, BROKERAGE_FINANCE_ADMIN_USER_TYPES, TENANT_COMMERCE_ADMIN_USER_TYPES, LEAD_DESK_USER_TYPES,
}

type Site = { file: string; line: number; expr: string; members: string[] | null; handTyped: boolean }
const LIST_RE = /\.in\(\s*["'`]user_type["'`]\s*,\s*(\[[^\]]*\])/g
const ID_RE = /\.in\(\s*["'`]user_type["'`]\s*,\s*([A-Za-z_][\w.]*)\s*(?:as\s|\))/g

/** Split an array literal's body on top-level commas. */
function elements(expr: string): string[] {
  const body = expr.trim().replace(/^\[/, "").replace(/\]$/, "")
  const out: string[] = []
  let depth = 0, cur = ""
  for (const ch of body) {
    if ("([{".includes(ch)) depth++
    if (")]}".includes(ch)) depth--
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = "" } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}
const STR = /^["'`]([a-z_]+)["'`]$/
/** Evaluate an array expression against the real roster Sets. null = not evaluable (an unknown name). */
function evaluate(expr: string): string[] | null {
  const out = new Set<string>()
  for (const el of elements(expr)) {
    const s = el.match(STR)
    if (s) { out.add(s[1]); continue }
    const name = el.match(/^\.\.\.(?:\(await import\(["'`][^"'`]+["'`]\)\)\.)?([A-Z_]+)$/)?.[1]
    if (name && NAMED[name]) { for (const t of NAMED[name]) out.add(t); continue }
    return null
  }
  return [...out].sort()
}
function sitesIn(file: string, src: string): Site[] {
  const code = stripComments(src)
  return [...code.matchAll(LIST_RE)].map((m) => {
    const expr = m[1].replace(/\s+/g, " ").trim()
    const els = elements(expr)
    return { file, line: code.slice(0, m.index).split("\n").length, expr, members: evaluate(expr), handTyped: els.length > 0 && els.every((e) => STR.test(e)) }
  })
}

// ── R2 · the hand-typed lists LEFT in the tree, each with why it is not an admin gate ──────────────────────────────────────
const LEFT: Array<{ file: string; list: string; kind: "display" | "picker" | "sender" | "non-roster recipients"; why: string }> = [
  { file: "app/dashboard/admin/components/provisioning-health-panel.tsx", list: "admin,agent,broker,tc", kind: "display", why: "the provisioning-health panel lists recent seats of these kinds for an admin to inspect; it grants nothing" },
  { file: "app/dashboard/team/page.tsx", list: "admin,agent,broker,isa,tc,team_lead", kind: "display", why: "the team page's member list (who is on the roster), not a gate" },
  { file: "app/dashboard/team/page.tsx", list: "agent,broker,team_lead", kind: "picker", why: "the CreateTeamDialog's lead picker — producing seats that may lead a team; not an admin gate" },
  { file: "lib/ai-isa/outreach-identity.ts", list: "broker,broker_owner", kind: "sender", why: "the brokerage's public face for outbound identity (oldest broker / owner); adding admin seats would change who outreach is FROM" },
  { file: "lib/workflow-orchestrator/chains/compliance-transaction-auto-create.ts", list: "compliance_officer,tc", kind: "non-roster recipients", why: "TCs and compliance officers are notified of an auto-created compliance transaction; tc is not on the admin roster, so no tier names this set" },
]

// ── R3 · the wave-155 fold ledger: who each list admitted BEFORE and what the folded expression adds ──────────────────────────
const FIN = "[...BROKERAGE_FINANCE_ADMIN_USER_TYPES]"
const FIN_CO = `[...BROKERAGE_FINANCE_ADMIN_USER_TYPES, "compliance_officer"]`
const FIN_TL = `[...BROKERAGE_FINANCE_ADMIN_USER_TYPES, "team_lead"]`
const FIN_DYN = `[...(await import("@/lib/auth/resolve-user-role")).BROKERAGE_FINANCE_ADMIN_USER_TYPES]`
const BA = ["admin", "broker"], BAO = ["admin", "broker", "broker_owner"], EXP = ["admin", "broker", "broker_admin", "broker_owner"]
/** `EXP` = rawRoleVariantsFor(["broker","admin"]) + "broker_owner" over the storable vocabulary (broker_admin and broker_owner map to canonical broker — lib/security/types.ts). */
const FOLDS: Array<{ file: string; expr: string; count?: number; before: string[]; delta: string[] }> = [
  { file: "app/actions/call-review-actions.ts", expr: FIN_TL, before: ["admin", "broker", "team_lead"], delta: ["broker_admin", "broker_owner"] },
  { file: "app/actions/cda-portal.ts", expr: FIN_CO, before: ["admin", "broker", "compliance_officer"], delta: ["broker_admin", "broker_owner"] },
  { file: "app/actions/cda-portal.ts", expr: FIN, before: BA, delta: ["broker_admin", "broker_owner"] },
  { file: "app/actions/portal-settings.ts", expr: FIN, before: BAO, delta: ["broker_admin"] },
  { file: "app/actions/superadmin/platform-sentinel.ts", expr: FIN, before: BA, delta: ["broker_admin", "broker_owner"] },
  { file: "app/api/cron/onboarding-health/route.ts", expr: FIN, before: BA, delta: ["broker_admin", "broker_owner"] },
  { file: "app/api/providers/inbound/route.ts", expr: FIN_CO, before: ["admin", "broker", "compliance_officer"], delta: ["broker_admin", "broker_owner"] },
  { file: "app/api/voice/twilio/intelligence/route.ts", expr: FIN_CO, before: ["admin", "broker", "compliance_officer"], delta: ["broker_admin", "broker_owner"] },
  { file: "app/recruiting/[brokerageSlug]/actions.ts", expr: FIN, before: BA, delta: ["broker_admin", "broker_owner"] },
  { file: "lib/ads/stuck-ad-action-reaper.ts", expr: FIN, before: BA, delta: ["broker_admin", "broker_owner"] },
  { file: "lib/agentic-os/connection-nudge.ts", expr: FIN, before: BA, delta: ["broker_admin", "broker_owner"] },
  { file: "lib/ai-isa/voice-dial-batch.ts", expr: FIN, before: BA, delta: ["broker_admin", "broker_owner"] },
  { file: "lib/compliance/raise-offer-flag.ts", expr: FIN, before: EXP, delta: [] },
  { file: "lib/integrations/widget/resolve-notification-target.ts", expr: FIN, before: BAO, delta: ["broker_admin"] },
  { file: "lib/intelligence/partners-meeting.ts", expr: FIN, before: BA, delta: ["broker_admin", "broker_owner"] },
  { file: "lib/kernel/assistant-starter.ts", expr: FIN, before: BA, delta: ["broker_admin", "broker_owner"] },
  { file: "lib/kernel/board-packet.ts", expr: FIN, before: BA, delta: ["broker_admin", "broker_owner"] },
  { file: "lib/kernel/flow-integrity.ts", expr: FIN, before: BA, delta: ["broker_admin", "broker_owner"] },
  { file: "lib/kernel/idle-hands.ts", expr: FIN, before: BA, delta: ["broker_admin", "broker_owner"] },
  { file: "lib/kernel/manager-signals.ts", expr: FIN, count: 5, before: BA, delta: ["broker_admin", "broker_owner"] },
  { file: "lib/kernel/os-self-audit.ts", expr: FIN, before: BA, delta: ["broker_admin", "broker_owner"] },
  { file: "lib/kernel/signature-chase.ts", expr: FIN, before: BA, delta: ["broker_admin", "broker_owner"] },
  { file: "lib/kernel/site-traffic-insights.ts", expr: FIN, before: EXP, delta: [] },
  { file: "lib/lead-governance/stale-lead-processor.ts", expr: FIN, before: BAO, delta: ["broker_admin"] },
  { file: "lib/marketing/marketing-qr.ts", expr: FIN, before: BAO, delta: ["broker_admin"] },
  { file: "lib/marketing/stuck-campaign-reaper.ts", expr: FIN, before: BAO, delta: ["broker_admin"] },
  { file: "lib/onboarding/certification-engine.ts", expr: FIN, before: BA, delta: ["broker_admin", "broker_owner"] },
  { file: "lib/onboarding/checkin-cadence.ts", expr: FIN, before: EXP, delta: [] },
  { file: "lib/onboarding/license-verifier.ts", expr: FIN_CO, before: ["admin", "broker", "compliance_officer"], delta: ["broker_admin", "broker_owner"] },
  { file: "lib/recruiting/license-readiness-sweep.ts", expr: FIN, before: BA, delta: ["broker_admin", "broker_owner"] },
  { file: "lib/social/token-refresh.ts", expr: FIN, before: BA, delta: ["broker_admin", "broker_owner"] },
  { file: "lib/video/reel-brand.ts", expr: FIN, before: BA, delta: ["broker_admin", "broker_owner"] },
]

/** An office SEAT type would be spelled with `office` as a whole segment (compliance_officer is not one). */
const OFFICE = /(^|_)office(_|$)/
const minus = (a: Iterable<string>, b: Iterable<string>) => { const B = new Set(b); return [...a].filter((x) => !B.has(x)).sort() }
const storable = (xs: Iterable<string>) => [...xs].filter((x) => STORABLE.has(x)).sort()
const norm = (e: string) => e.replace(/\s+/g, " ").replace(/'/g, '"').trim()
/** The verdict for one fold: null = holds, else why not. */
function foldVerdict(f: { expr: string; before: string[]; delta: string[] }): string | null {
  const after = evaluate(f.expr)
  if (!after) return `the expression ${f.expr} is not evaluable against the named roster Sets`
  const added = minus(storable(after), storable(f.before)), dropped = minus(storable(f.before), storable(after))
  if (dropped.length) return `NARROWS — drops ${dropped.join(", ")}`
  if (added.join(",") !== [...f.delta].sort().join(",")) return `undeclared delta — adds ${added.join(", ") || "nothing"}, ledger says ${f.delta.join(", ") || "nothing"}`
  return null
}
const leftVerdict = (s: Site): string | null => {
  const key = (s.members ?? []).join(",")
  const entry = LEFT.find((l) => l.file === s.file && l.list === key)
  if (!entry) return "UNCLASSIFIED hand-typed role list — spread the roster tier it means (resolve-user-role.ts / lead-visibility.ts), or classify it with the reason it is not an admin gate"
  // A SENDER pick chooses whose name outreach goes out under — widening it changes the From line, so it is the one admin-only shape left by name.
  if (entry.kind !== "sender" && (s.members ?? []).every((m) => TENANT_ADMIN_USER_TYPES.has(m))) return "made only of admin-roster members — that shape is an admin list and must fold onto a named tier"
  return null
}

function main() {
  const files = [...walk(join(root, "app")), ...walk(join(root, "lib"))].map((p) => relative(root, p))
  const sites: Site[] = []
  const byName: string[] = []
  for (const f of files) {
    const src = readFileSync(join(root, f), "utf8")
    sites.push(...sitesIn(f, src))
    for (const m of stripComments(src).matchAll(ID_RE)) byName.push(`${f} (${m[1]})`)
  }
  const hand = sites.filter((s) => s.handTyped)
  const derived = sites.filter((s) => !s.handTyped)

  console.log("\n[R1 · census of .in(\"user_type\", [...]) role lists in app/ + lib/ (stripped source, derived)]")
  console.log(`    (published) ${sites.length} array-literal role list(s): ${hand.length} hand-typed, ${derived.length} derived from a named roster; ${byName.length} passed by name (blind spot — not judged)`)
  console.log(`    (published) storable users.user_type vocabulary (live CHECK, generated): ${[...STORABLE].sort().join(", ")}`)

  console.log("\n[R2 · ratchet — every hand-typed list left is classified, and none is an admin list]")
  const refused = hand.map((s) => ({ s, why: leftVerdict(s) })).filter((x) => x.why)
  const staleLeft = LEFT.filter((l) => !hand.some((s) => s.file === l.file && (s.members ?? []).join(",") === l.list))
  for (const l of LEFT) console.log(`    left · ${l.file} [${l.list}] · ${l.kind} — ${l.why}`)
  check(`every hand-typed role list is classified and none is made only of admin-roster members (${hand.length} left, derived)`, refused.length === 0, refused.map((x) => `${x.s.file}:${x.s.line} ${x.s.expr} — ${x.why}`).join(" | "))
  check("every classification still matches a list (a stale entry is a hole)", staleLeft.length === 0, staleLeft.map((l) => `${l.file} [${l.list}]`).join(", "))

  console.log("\n[R3 · fold ledger — each folded list admits exactly its previous members plus the declared delta, over the storable vocabulary]")
  const ledgerProblems: string[] = []
  for (const f of FOLDS) {
    const here = sites.filter((s) => s.file === f.file && norm(s.expr) === norm(f.expr)).length
    // At LEAST the folded count: a file may already have spread the same tier before wave 155 (manager-signals.ts did, once).
    if (here < (f.count ?? 1)) ledgerProblems.push(`${f.file}: expected ${f.count ?? 1} site(s) of ${f.expr}, found ${here}`)
    const v = foldVerdict(f)
    if (v) ledgerProblems.push(`${f.file} ${f.expr}: ${v}`)
    console.log(`    ${f.file} · before ${storable(f.before).join(",")} · after ${f.expr} · delta ${f.delta.length ? "+" + f.delta.join(" +") : "0"}${f.count ? ` · ×${f.count}` : ""}`)
  }
  check(`every folded list is present as recorded, never narrows, and adds exactly its declared delta (${FOLDS.reduce((n, f) => n + (f.count ?? 1), 0)} site(s) in ${new Set(FOLDS.map((f) => f.file)).size} file(s))`, ledgerProblems.length === 0, ledgerProblems.join(" | "))
  const widened = [...new Set(FOLDS.flatMap((f) => f.delta))].sort()
  check(`the only seats any fold adds are broker_admin and broker_owner — both canonical "broker" (lib/security/types.ts) and on every roster tier (CLAUDE.md §4)`, widened.every((w) => w === "broker_admin" || w === "broker_owner"), widened.join(", "))

  console.log("\n[R4 · scopes — a positive and a negative test each]")
  const folded = [...new Set(FOLDS.map((f) => f.expr))].map((e) => ({ e, set: new Set(evaluate(e) ?? []) }))
  const noneAdmit = (t: string) => folded.every((x) => !x.set.has(t))
  check("VENDOR — negative: no folded list admits 'vendor'; positive: 'vendor' is a storable seat (the negative is not vacuous) and a lender resolves as a VENDOR CATEGORY", noneAdmit("vendor") && STORABLE.has("vendor") && isLenderVendorCategory("lender"))
  check("LENDER — negative: 'lender' is not a storable user_type and no list names it; positive: 'refinance_lender' is a lender vendor category too", !STORABLE.has("lender") && !sites.some((s) => (s.members ?? []).includes("lender")) && isLenderVendorCategory("refinance_lender"))
  check("CONTACT — negative: no folded list admits 'contact'; positive: 'contact' is a storable seat", noneAdmit("contact") && STORABLE.has("contact"))
  check("TC — negative: no admin fold admits 'tc'; positive: the TC + compliance recipient list is kept and still admits 'tc'", noneAdmit("tc") && hand.some((s) => s.file.endsWith("compliance-transaction-auto-create.ts") && (s.members ?? []).includes("tc")))
  check("TEAM LEAD — negative: the finance folds exclude 'team_lead' (m472); positive: the coaching audience fold and the lead desk admit it",
    !new Set(evaluate(FIN)).has("team_lead") && !new Set(evaluate(FIN_CO)).has("team_lead") && new Set(evaluate(FIN_TL)).has("team_lead") && LEAD_DESK_USER_TYPES.has("team_lead"))
  check("COMPLIANCE OFFICER — negative: the finance tier excludes it (it reads the books, never keeps them); positive: the review-recipient folds admit it",
    !BROKERAGE_FINANCE_ADMIN_USER_TYPES.has("compliance_officer") && new Set(evaluate(FIN_CO)).has("compliance_officer") && TENANT_ADMIN_USER_TYPES.has("compliance_officer"))
  check("OFFICE — negative: no storable user_type names an office and no role list admits one (office reach is office membership, never a seat type); positive: the roster's admin tier still admits the brokerage's own admin who governs offices",
    ![...STORABLE].some((t) => OFFICE.test(t)) && !sites.some((s) => (s.members ?? []).some((m) => OFFICE.test(m))) && OFFICE.test("office_manager") && !OFFICE.test("compliance_officer") && TENANT_ADMIN_USER_TYPES.has("admin"))
  check("ISA / SYSTEM — negative: no admin fold admits the AI seat 'isa' or 'system'", noneAdmit("isa") && noneAdmit("system"))

  console.log("\n[controls]")
  const planted = sitesIn("lib/planted.ts", `await svc.from("users").select("id").in("user_type", ["broker", "admin"]).limit(5)`)
  control("a planted hand-typed admin list is found, refused as UNCLASSIFIED, and — if someone classified it as 'left' — refused as an admin list",
    planted.length === 1 && planted[0].handTyped && /UNCLASSIFIED/.test(leftVerdict(planted[0]) ?? "")
    && (() => { LEFT.push({ file: "lib/planted.ts", list: "admin,broker", kind: "display", why: "planted" }); const v = leftVerdict(planted[0]); LEFT.pop(); return /must fold/.test(v ?? "") })())
  control("a tombstone (a comment naming an old list) is not a call site; a multi-line list is seen; a derived spread is not hand-typed",
    sitesIn("t.ts", `// was .in("user_type", ["broker", "admin"])\n/* .in("user_type", ["admin"]) */`).length === 0
    && sitesIn("m.ts", `.in("user_type", [\n  "tc",\n  "compliance_officer",\n])`).filter((s) => s.handTyped).length === 1
    && sitesIn("d.ts", `.in("user_type", [...BROKERAGE_FINANCE_ADMIN_USER_TYPES])`).every((s) => !s.handTyped)
    && sitesIn("d.ts", `.in("user_type", [...(await import("@/lib/auth/resolve-user-role")).BROKERAGE_FINANCE_ADMIN_USER_TYPES])`).every((s) => !s.handTyped && s.members !== null))
  control("the fold ledger catches an undeclared widening, a narrowing, and an unevaluable expression",
    /undeclared delta/.test(foldVerdict({ expr: FIN, before: BA, delta: [] }) ?? "")
    && /NARROWS/.test(foldVerdict({ expr: FIN, before: ["admin", "broker", "team_lead"], delta: [] }) ?? "")
    && /not evaluable/.test(foldVerdict({ expr: "[...SOME_LOCAL_ROLES]", before: BA, delta: [] }) ?? "")
    && foldVerdict({ expr: FIN, before: BA, delta: ["broker_owner", "broker_admin"] }) === null)
  control("the evaluator reads the REAL roster: finance = roster − team_lead − compliance_officer; commerce = roster − compliance_officer",
    JSON.stringify(evaluate(FIN)) === JSON.stringify(minus(TENANT_ADMIN_USER_TYPES, ["team_lead", "compliance_officer"]))
    && JSON.stringify(evaluate("[...TENANT_COMMERCE_ADMIN_USER_TYPES]")) === JSON.stringify(minus(TENANT_ADMIN_USER_TYPES, ["compliance_officer"])))

  console.log(`\n${failures === 0 ? "GREEN" : "RED"} — role-roster-fold: ${failures} failure(s) (SIMULATED)`)
  process.exit(failures === 0 ? 0 : 1)
}
main()
