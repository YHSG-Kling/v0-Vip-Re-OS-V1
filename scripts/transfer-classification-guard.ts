/**
 * scripts/transfer-classification-guard.ts — wave 145, lane 145A.
 *
 * TWO RELEASE RULES, ONE LANE (the brief names this one file as the lane's new proof):
 *
 *   A. FK-CHILD TRANSFER CLASSIFICATION (owner ruling 24: "do NOT move all 286 … classify each FK child relationship …
 *      code-level checks and tests now, live transfers only on explicit authorization").
 *      A1 the census is DERIVED from the generated FK cache (scripts/schema-fk-map.ts) — every FK into a moved family — and
 *         EVERY child FK resolves to exactly one class in lib/kernel/brokerage-transfer.ts FK_CHILD_TRANSFER_CLASSIFICATION;
 *      A2 the classification names nothing outside the census and nothing twice; families are follows_parent by construction;
 *      A3 "not_transferable" / "explicit_transfer" (and every other non-follows class) are NEVER moved by the rail — proven on the
 *         REAL rail in memory: refused at verification when named for moving (even through the proof seam), left in place and
 *         counted for a human when not;
 *      A4 the authorized / safety-critical lists are follows_parent; children that also point at a STAYING tenant parent are
 *         published (they cannot be authorized blind);
 *      A5 docs/architecture/FK-CHILD-TRANSFER-CLASSIFICATION.md carries the generated per-table block (drift = fail; --write).
 *
 *   B. THE brokerage-forms BUCKET (owner ruling 23, release-blocking P1).
 *      B1 m854 (public functions) — an ACTIVE STAFF SEAT gates every read and write; the seat list equals the code's
 *         FORM_LIBRARY_SEAT_USER_TYPES and sits inside the live users_user_type_check; registered packets read through their
 *         own row; browser writes only into agents/{own id}/;
 *      B2 m855 (owner-held storage.objects policies) — drops the bucket-wide rules, creates exactly four owner-scoped ones,
 *         refuses to run without m854; docs/operations/OWNER-SQL.md §F carries it verbatim;
 *      B3 the DOOR CENSUS — every storage operation on the bucket in app/ + lib/ (stripped source) is a DECLARED door with its
 *         gate before the operation in the same function; no long-lived URL is minted or persisted; the doors that still build
 *         their actor from a raw users read are a ratchet (outside-lane, published);
 *      B4 behaviour on the in-memory client — the session → actor door (resolvePacketActor) refuses a contact, a vendor, a suspended / removed
 *         account, a deactivated agent and a deleted team; the ONE minting door issues "use" vs "manage" links correctly.
 *
 * Every absence assertion has a POSITIVE CONTROL. Scans read STRIPPED source (scripts/strip-comments.ts). Migrations are found
 * by NAME and accept either status line (the lane stamp or "-- ── APPLIED LIVE") — the rule, not the waypoint.
 *
 * BLIND SPOTS (published, also printed): the census is the generated FK cache (as of its last regeneration — m853's two FKs
 * point at teams / platform_form_packets, neither a family); children of the MEMBERSHIP movers (users, agents, teams) are not
 * this census; RLS, storage policies and SQL functions are asserted from the migration TEXT (no database here) — the owner's
 * verification queries in OWNER-SQL §F are the live check; the door census sees `storage.from(<bucket ref>)` only through the
 * literal or the four known constants (a bucket name computed at runtime is invisible); a gate is matched by token, in order,
 * inside the enclosing function — not by data flow.
 *
 * Run: tsx --conditions=react-server scripts/transfer-classification-guard.ts [--write]
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { blankComments, stripComments } from "./strip-comments"
import { SCHEMA_FK_MAP } from "./schema-fk-map"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { memSupabase, type Row } from "./in-memory-supabase"
import { TABLE_MANAGER } from "../lib/kernel/manager-registry"
import {
  CHILD_TRANSFER_CLASSES, CHILD_TRANSFER_CLASS_MEANING, FK_CHILD_CLASS_NAMINGS, FK_CHILD_TRANSFER_CLASSIFICATION, TRANSFER_AUTHORIZED_FOLLOWING_CHILDREN,
  TRANSFER_DATA_FAMILIES, TRANSFER_HUMAN_ROUTES, TRANSFER_SAFETY_CRITICAL_CHILDREN, runBrokerageTransferMigration,
  type BrokerageTransferDeps, type ChildTransferClass,
} from "../lib/kernel/brokerage-transfer"
import { FORM_LIBRARY_SEAT_USER_TYPES, FORM_PACKET_PREVIEW_TTL_SECONDS, PACKET_OVERSIGHT_USER_TYPES, issueTenantPacketUrl, resolvePacketActor, type PacketActor } from "../lib/forms/tenant-form-packets"
import { checkFormPathsInScope } from "../lib/forms/form-path-scope"
import { TENANT_ADMIN_USER_TYPES } from "../lib/auth/resolve-user-role"

const ROOT = process.cwd()
const WRITE = process.argv.includes("--write")
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const control = (name: string, ok: boolean) => check(`POSITIVE CONTROL: ${name}`, ok)
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const has = (p: string) => existsSync(join(ROOT, p))
const sqlCode = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
const norm = (s: string) => s.replace(/\s+/g, " ").trim()
const migByName = (re: RegExp) => readdirSync(join(ROOT, "supabase/migrations")).find((f) => re.test(f)) ?? null
const statusLineOk = (first: string, lane: string) => first === `-- WRITTEN, NOT APPLIED (wave 145, lane ${lane}) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN and storage.objects policies are owner SQL-editor` || /^-- ── APPLIED LIVE /.test(first)

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// A. FK-CHILD TRANSFER CLASSIFICATION
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n[A · FK-child transfer classification (ruling 24)]")
const FK = SCHEMA_FK_MAP as Record<string, Record<string, string>>
const SNAP = SCHEMA_SNAPSHOT as unknown as Record<string, string[]>
const families = new Set(TRANSFER_DATA_FAMILIES.map((f) => f.table))
/** The class of a child table's FKs onto a moved parent: a moved FAMILY is follows_parent by construction; null = unclassified. */
const childTransferClass = (t: string): ChildTransferClass | null => (families.has(t) ? "follows_parent" : FK_CHILD_TRANSFER_CLASSIFICATION[t]?.cls ?? null)
type Edge = { child: string; col: string; parent: string; tenant: boolean }
const censusOf = (fk: Record<string, Record<string, string>>, fams: ReadonlySet<string>) => {
  const all: Edge[] = []
  for (const [child, cols] of Object.entries(fk)) for (const [col, parent] of Object.entries(cols)) if (fams.has(parent)) all.push({ child, col, parent, tenant: (SNAP[child] ?? []).includes("brokerage_id") })
  return { all, familyEdges: all.filter((e) => fams.has(e.child)), childEdges: all.filter((e) => !fams.has(e.child)) }
}
const census = censusOf(FK, families)
const childTables = [...new Set(census.childEdges.map((e) => e.child))].sort()
const tenantChildTables = [...new Set(census.childEdges.filter((e) => e.tenant).map((e) => e.child))]
console.log(`    (published) census from scripts/schema-fk-map.ts: ${census.all.length} FKs into the ${families.size} moved families — ${census.familyEdges.length} between families, ${census.childEdges.length} from ${childTables.length} child tables (${tenantChildTables.length} carrying brokerage_id with ${census.childEdges.filter((e) => e.tenant).length} FKs — the "286"; ${childTables.length - tenantChildTables.length} with no tenant column, ${census.childEdges.filter((e) => !e.tenant).length} FKs). Live re-measure 2026-10-27 (pg_constraint, single-column FKs): 491 / 59 / 306 tables / 432 FKs — equal.`)

{
  const unclassifiedEdges = census.childEdges.filter((e) => childTransferClass(e.child) === null)
  check(`A1 EVERY child FK onto a moved family has a class (${census.childEdges.length - unclassifiedEdges.length}/${census.childEdges.length} FKs, ${childTables.length} tables)`, unclassifiedEdges.length === 0, unclassifiedEdges.slice(0, 12).map((e) => `${e.child}.${e.col}→${e.parent}`).join(", "))
  check("A1 the 286 brokerage_id-carrying children are all classified (the owner's census, re-derived — never listed by hand)", tenantChildTables.length > 0 && tenantChildTables.every((t) => !!FK_CHILD_TRANSFER_CLASSIFICATION[t]), `${tenantChildTables.length} found`)
  // positive control: a new child appearing in the cache is caught
  const fakeFk = { ...FK, zz_new_child_table: { contact_id: "contacts" } }
  const fakeCensus = censusOf(fakeFk, families)
  control("a NEW FK child in the cache (zz_new_child_table.contact_id → contacts) reads as unclassified", fakeCensus.childEdges.some((e) => e.child === "zz_new_child_table" && childTransferClass(e.child) === null))
  const classified = Object.keys(FK_CHILD_TRANSFER_CLASSIFICATION)
  const stale = classified.filter((t) => !childTables.includes(t))
  check("A2 the classification names no table outside the census (a stale or misspelt name would read as 'classified' while matching nothing)", stale.length === 0, stale.join(","))
  check(`A2 every table is named EXACTLY once across the rule groups (${FK_CHILD_CLASS_NAMINGS} namings = ${classified.length} tables)`, FK_CHILD_CLASS_NAMINGS === classified.length)
  check("A2 no moved FAMILY is classified as a child (a family is follows_parent by construction)", classified.every((t) => !families.has(t)))
  check(`A2 the ${census.familyEdges.length} family↔family FKs resolve to follows_parent (both ends move in the data step)`, census.familyEdges.every((e) => childTransferClass(e.child) === "follows_parent"))
  check("A2 every class used is one of the six ruling-24 classes, and each has its written meaning", Object.values(FK_CHILD_TRANSFER_CLASSIFICATION).every((c) => (CHILD_TRANSFER_CLASSES as readonly string[]).includes(c.cls) && c.rule.length > 30) && CHILD_TRANSFER_CLASSES.every((c) => CHILD_TRANSFER_CLASS_MEANING[c].length > 40) && CHILD_TRANSFER_CLASSES.length === 6)
  // per-class / per-manager publication
  const byClass = new Map<ChildTransferClass, string[]>()
  for (const t of childTables) { const c = childTransferClass(t)!; byClass.set(c, [...(byClass.get(c) ?? []), t]) }
  console.log(`    (published) tables per class: ${CHILD_TRANSFER_CLASSES.map((c) => `${c} ${(byClass.get(c) ?? []).length}`).join(" · ")}`)
  console.log(`    (published) FKs per class: ${CHILD_TRANSFER_CLASSES.map((c) => `${c} ${census.childEdges.filter((e) => childTransferClass(e.child) === c).length}`).join(" · ")}`)
  const mgr = new Map<string, Map<string, number>>()
  for (const t of childTables) { const m = (TABLE_MANAGER as Record<string, string>)[t] ?? "∅ (no TABLE_MANAGER — no tenant column)"; const c = childTransferClass(t)!; const row = mgr.get(m) ?? new Map(); row.set(c, (row.get(c) ?? 0) + 1); mgr.set(m, row) }
  for (const [m, row] of [...mgr].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) console.log(`      ${m}: ${[...row].map(([c, n]) => `${c} ${n}`).join(", ")}`)
  check("A2 every brokerage_id-carrying child has a TABLE_MANAGER owner (the accountable manager for its class decision)", tenantChildTables.every((t) => t in TABLE_MANAGER), tenantChildTables.filter((t) => !(t in TABLE_MANAGER)).join(","))
  const notExplicit = (byClass.get("explicit_transfer") ?? [])
  check("A2 the explicit_transfer class carries the owner's named categories: an executed brokerage agreement, confidential deal documents, consent / privacy, the client's own financial data",
    ["listing_agreements", "buyer_broker_agreements", "transaction_documents", "contact_consent_events", "data_subject_requests", "buyer_financial_profiles", "lender_applications"].every((t) => notExplicit.includes(t)))
  check("A2 money never follows: every commission_* / agent_commissions / deposits / vendor_invoices child is not_transferable",
    childTables.filter((t) => /commission|^deposits$|vendor_invoices|company_books|cost_breakdown/.test(t)).every((t) => childTransferClass(t) === "not_transferable"))
}

// A3 — the REAL rail, in memory
console.log("\n[A3 · the rail never moves a protected class; what stays is counted for a human]")
{
  const NOW = new Date("2026-10-27T15:00:00Z")
  const runRail = async (authorized: readonly string[] | undefined) => {
    const T = randomUUID(), S = randomUUID(), D = randomUUID(), A = randomUUID(), O = randomUUID(), REQ = randomUUID()
    const seed: Record<string, Row[]> = {
      brokerages: [
        { id: T, name: "Harbor Realty", plan_tier: "brokerage", status: "active", deleted_at: null, archived_at: null, ai_isa_system_user_id: null },
        { id: S, name: "Dana Solo", plan_tier: "solo_agent", status: "active", deleted_at: null, archived_at: null, ai_isa_system_user_id: null },
        { id: D, name: "Decoy", plan_tier: "solo_agent", status: "active", deleted_at: null, archived_at: null, ai_isa_system_user_id: null },
      ],
      users: [
        { id: A, email: "max@harbor.test", brokerage_id: T, user_type: "broker_owner", platform_role: null, first_name: "Max", last_name: "Ng", team_id: null },
        { id: O, email: "dana@solo.test", brokerage_id: S, user_type: "admin", platform_role: null, first_name: "Dana", last_name: "Lee", team_id: null },
      ],
      agents: [{ id: "ag-o", user_id: O, brokerage_id: S, team_id: null }], teams: [], user_role_assignments: [],
      brokerage_transfer_requests: [{
        id: REQ, brokerage_id: T, source_brokerage_id: S, target_brokerage_id: T, subject_user_id: O, initiated_by_user_id: A, target_role: "agent", status: "consented", reason: null,
        consent: { user_id: O, at: NOW.toISOString(), decision: "consent", statement: "I consent to joining Harbor Realty", channel: "settings_ui", request_snapshot: { source_brokerage_id: S, target_brokerage_id: T, target_role: "agent", source_name: "Dana Solo", target_name: "Harbor Realty" } },
        verification: null, migration: null, billing_handoff: null, readiness: null, effective_at: null, completed_at: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
      }],
      agent_action_ledger: [], notifications: [], lifecycle_events: [], brokerage_form_library: [],
    }
    for (const fam of TRANSFER_DATA_FAMILIES) seed[fam.table] = [{ id: `${fam.table}-s`, brokerage_id: S }, { id: `${fam.table}-d`, brokerage_id: D }]
    // one row per class in the source, and a decoy tenant's row that must never be touched
    const CHILDREN = ["agent_commissions", "listing_agreements", "contact_consent_events", "contact_suppression_list", "transaction_milestones", "communications", "lead_scores", "contact_vendors"]
    for (const t of CHILDREN) seed[t] = [{ id: `${t}-s`, brokerage_id: S, contact_id: "contacts-s", transaction_id: "transactions-s" }, { id: `${t}-d`, brokerage_id: D }]
    const svc = memSupabase(seed, { uuidIds: true })
    const humans: Array<Record<string, unknown>> = []
    const deps: BrokerageTransferDeps = {
      now: () => NOW,
      assignUserToBrokerage: async (p) => { await svc.from("users").update({ brokerage_id: p.brokerageId }).eq("id", p.userId); await svc.from("agents").update({ brokerage_id: p.brokerageId }).eq("user_id", p.userId); return { success: true } },
      assignRole: async (p) => { await svc.from("users").update({ user_type: p.newRole }).eq("id", p.userId); return { success: true } },
      domainRecords: async () => ({ success: true, agentId: "ag", coordinatorId: null, domainRecordsCreated: [] } as never),
      seatGate: async () => ({ allowed: true, reason: "within_limit", message: null } as never),
      tierAllowsRole: () => true,
      mayUseAndAfford: async () => ({ allowed: true, reason: "ok" }),
      billingHandoff: async () => ({ ok: true, mode: "fixture", effectiveAt: NOW.toISOString() } as never),
      readiness: async () => ({ ready: true, blockers: [], checkedAt: NOW.toISOString() }),
      reportOutcome: async () => ({}),
      emit: async () => ({}),
      notifyAdmins: async (_c, brokerageId, n) => { humans.push({ to: "admins", brokerageId, ...n }); return 1 },
      notifyStaff: async (_c, n) => { humans.push({ to: "staff", ...n }); return 1 },
      ...(authorized ? { authorizedFollowingChildren: authorized } : {}),
    }
    const r = await runBrokerageTransferMigration(svc, { requestId: REQ, actor: { userId: A, brokerageId: T, kind: "target_admin" } }, deps)
    const where = (t: string, id: string) => svc.tables[t]?.find((x) => x.id === id)?.brokerage_id
    const req = svc.tables.brokerage_transfer_requests.find((x) => x.id === REQ)!
    return { r, svc, S, T, D, where, humans, req }
  }

  // run 1 — production authorization (EMPTY): nothing of the 286 moves; explicit + safety-critical are counted and routed
  const one = await runRail(undefined)
  check("A3 production list is EMPTY (ruling 24: live transfers only on explicit authorization)", TRANSFER_AUTHORIZED_FOLLOWING_CHILDREN.length === 0)
  check("A3 the rail completes and moves every FAMILY (contacts, transactions …) to the target", one.r.ok && one.where("contacts", "contacts-s") === one.T && one.where("transactions", "transactions-s") === one.T, one.r.ok ? "" : (one.r as { error: string }).error)
  check("A3 …and NO child moves: money (agent_commissions), an executed agreement (listing_agreements), consent, an opt-out, a deal milestone, a sent message, a score, a vendor link — all still in the source",
    ["agent_commissions", "listing_agreements", "contact_consent_events", "contact_suppression_list", "transaction_milestones", "communications", "lead_scores", "contact_vendors"].every((t) => one.where(t, `${t}-s`) === one.S))
  check("A3 …the decoy tenant's rows are untouched (no cross-tenant write)", ["contacts", "agent_commissions", "listing_agreements"].every((t) => one.where(t, `${t}-d`) === one.D))
  const closure = (one.req.migration as { closure?: { explicit_transfer: Record<string, number>; safety_critical: Record<string, number>; unread: string[] } } | null)?.closure
  check("A3 the CLOSURE REPORT counts what stayed for a human: the explicit_transfer rows (listing_agreements 1, contact_consent_events 1) and the SAFETY-CRITICAL opt-out (contact_suppression_list 1); nothing unread",
    closure?.explicit_transfer.listing_agreements === 1 && closure?.explicit_transfer.contact_consent_events === 1 && closure?.safety_critical.contact_suppression_list === 1 && closure?.unread.length === 0, JSON.stringify(closure))
  const routed = one.humans.filter((h) => h.type === "brokerage_transfer_explicit_transfer_pending")
  check("A3 …routed to a human through the REGISTERED Data Steward (TRANSFER_HUMAN_ROUTES.explicit_transfer_pending), naming the opt-out as a SAFETY item and the owner-approval plan",
    TRANSFER_HUMAN_ROUTES.explicit_transfer_pending === "data_steward" && routed.length >= 1 && routed.every((h) => /Data Steward/.test(String(h.title))) && routed.some((h) => /SAFETY/.test(String(h.body)) && /FK-CHILD-TRANSFER-CLASSIFICATION/.test(String(h.body))))
  const checks = (one.req.verification as { checks?: Array<{ key: string; ok: boolean }> } | null)?.checks ?? []
  check("A3 verification records the child_classification check (passed)", checks.some((c) => c.key === "child_classification" && c.ok))

  // run 2 — an owner-authorized follows_parent child moves like a family; nothing else does
  const two = await runRail(["transaction_milestones", "contact_suppression_list"])
  check("A3 an AUTHORIZED follows_parent child (transaction_milestones, contact_suppression_list) moves, is counted, and drops out of the safety report",
    two.r.ok && two.where("transaction_milestones", "transaction_milestones-s") === two.T && two.where("contact_suppression_list", "contact_suppression_list-s") === two.T
    && (two.req.migration as any)?.counts?.transaction_milestones === 1 && Object.keys((two.req.migration as any)?.closure?.safety_critical ?? {}).length === 0)
  check("A3 …while money, the agreement, consent and the sent message still stay", ["agent_commissions", "listing_agreements", "contact_consent_events", "communications"].every((t) => two.where(t, `${t}-s`) === two.S) && two.where("transaction_milestones", "transaction_milestones-d") === two.D)

  // runs 3–5 — naming a protected class for moving is REFUSED at verification, even through the proof seam, and nothing moves
  for (const [label, list] of [["not_transferable (agent_commissions)", ["agent_commissions"]], ["explicit_transfer (listing_agreements)", ["listing_agreements"]], ["historical_immutable (communications)", ["communications"]], ["an UNCLASSIFIED table", ["zz_not_a_child"]]] as const) {
    const x = await runRail(list)
    const vchecks = (x.req.verification as { checks?: Array<{ key: string; ok: boolean; detail: string }> } | null)?.checks ?? []
    check(`A3 naming ${label} for moving is REFUSED at verification (fail closed) and NOTHING moves — not even the families`,
      !x.r.ok && (x.r as { stalledAt: string | null }).stalledAt === "verification" && vchecks.some((c) => c.key === "child_classification" && !c.ok) && x.where("contacts", "contacts-s") === x.S && x.where(list[0], `${list[0]}-s`) !== x.T)
  }
  control("the classes the refusals rest on: agent_commissions not_transferable, listing_agreements explicit_transfer, transaction_milestones follows_parent", childTransferClass("agent_commissions") === "not_transferable" && childTransferClass("listing_agreements") === "explicit_transfer" && childTransferClass("transaction_milestones") === "follows_parent")
}

// A4 — authorized / safety-critical lists; mixed parents
console.log("\n[A4 · authorization lists, safety-critical children, children with a STAYING parent]")
{
  check("A4 every authorized child and every safety-critical child is follows_parent", [...TRANSFER_AUTHORIZED_FOLLOWING_CHILDREN, ...TRANSFER_SAFETY_CRITICAL_CHILDREN].every((t) => childTransferClass(t) === "follows_parent"))
  const optOutSrc = ["lib/lead-intent/lead-opt-out.ts", "lib/direct-mail/address-suppression.ts"].map((f) => has(f) ? stripComments(raw(f)) : "").join("\n")
  check("A4 the SAFETY reason still holds: the opt-out readers pin contact_suppression_list to the brokerage (an opt-out left in the source is invisible to the target)",
    /\.from\("contact_suppression_list"\)[\s\S]{0,200}\.eq\("brokerage_id"/.test(optOutSrc))
  control("the opt-out reader finder sees a brokerage-pinned read", /\.from\("contact_suppression_list"\)[\s\S]{0,200}\.eq\("brokerage_id"/.test(`svc.from("contact_suppression_list").select("id").eq("brokerage_id", b)`))
  // a follows_parent child that ALSO points at a tenant table that does NOT move cannot be authorized blind (it would point the target at the source)
  // Movers: the families, the membership tables, and whatever the owner has authorized (a self-reference is never a crossing).
  const MOVERS = new Set([...families, ...TRANSFER_AUTHORIZED_FOLLOWING_CHILDREN, "teams", "users", "agents", "brokerages"])
  const stayingParentsOf = (t: string, movers: ReadonlySet<string>) => Object.entries(FK[t] ?? {}).filter(([, p]) => p !== t && !movers.has(p) && (SNAP[p] ?? []).includes("brokerage_id"))
  const sibling = new Map<string, string[]>(), staying = new Map<string, string[]>()
  for (const t of childTables.filter((x) => childTransferClass(x) === "follows_parent")) {
    const s = stayingParentsOf(t, MOVERS)
    const sib = s.filter(([, p]) => childTransferClass(p) === "follows_parent").map(([c, p]) => `${c}→${p}`)
    const stay = s.filter(([, p]) => childTransferClass(p) !== "follows_parent").map(([c, p]) => `${c}→${p}${childTransferClass(p) ? ` (${childTransferClass(p)})` : ""}`)
    if (sib.length) sibling.set(t, sib)
    if (stay.length) staying.set(t, stay)
  }
  console.log(`    (published) follows_parent children that point at a SIBLING follows_parent child — authorize them together (${sibling.size}): ${[...sibling].map(([t, s]) => `${t} [${s.join(", ")}]`).join(" · ") || "none"}`)
  console.log(`    (published) follows_parent children that point at a parent that STAYS — resolve before authorizing (${staying.size}): ${[...staying].map(([t, s]) => `${t} [${s.join(", ")}]`).join(" · ") || "none"}`)
  check("A4 no AUTHORIZED child points at a tenant parent that stays (that FK would cross tenants after the move)", TRANSFER_AUTHORIZED_FOLLOWING_CHILDREN.every((t) => stayingParentsOf(t, MOVERS).length === 0))
  control("the staying-parent finder flags transaction_assignments (coordinator_id → transaction_coordinators, which does not move)", stayingParentsOf("transaction_assignments", MOVERS).some(([, p]) => p === "transaction_coordinators"))
}

// A5 — the document's generated block
console.log("\n[A5 · docs/architecture/FK-CHILD-TRANSFER-CLASSIFICATION.md]")
const DOC = "docs/architecture/FK-CHILD-TRANSFER-CLASSIFICATION.md"
const BEGIN = "<!-- BEGIN GENERATED: fk-child-classification (scripts/transfer-classification-guard.ts --write) -->"
const END = "<!-- END GENERATED: fk-child-classification -->"
function renderBlock(): string {
  const lines: string[] = []
  const edgesOf = (t: string) => census.childEdges.filter((e) => e.child === t)
  lines.push(`Census: ${census.childEdges.length} FKs from ${childTables.length} child tables into the ${families.size} moved families (${tenantChildTables.length} tables carry brokerage_id; ${childTables.length - tenantChildTables.length} have no tenant column and follow their parent's tenancy implicitly). ${census.familyEdges.length} further FKs run between families (follows_parent by construction).`)
  lines.push("")
  lines.push("| Class | Tables | FKs |")
  lines.push("|---|---|---|")
  for (const c of CHILD_TRANSFER_CLASSES) lines.push(`| \`${c}\` | ${childTables.filter((t) => childTransferClass(t) === c).length} | ${census.childEdges.filter((e) => childTransferClass(e.child) === c).length} |`)
  const groups = new Map<string, { cls: ChildTransferClass; tables: string[] }>()
  for (const [t, v] of Object.entries(FK_CHILD_TRANSFER_CLASSIFICATION)) { const g = groups.get(v.rule) ?? { cls: v.cls, tables: [] }; g.tables.push(t); groups.set(v.rule, g) }
  for (const c of CHILD_TRANSFER_CLASSES) {
    lines.push("")
    lines.push(`### \`${c}\``)
    lines.push("")
    lines.push(`*${CHILD_TRANSFER_CLASS_MEANING[c]}.*`)
    for (const [rule, g] of groups) {
      if (g.cls !== c) continue
      lines.push("")
      lines.push(`**${rule}**`)
      lines.push("")
      for (const t of g.tables) {
        const e = edgesOf(t)
        lines.push(`- \`${t}\` — ${e.map((x) => `${x.col} → ${x.parent}`).join(", ")}${e.some((x) => !x.tenant) ? " · no tenant column" : ""} · ${(TABLE_MANAGER as Record<string, string>)[t] ?? "no TABLE_MANAGER"}`)
      }
    }
  }
  return lines.join("\n")
}
{
  const block = `${BEGIN}\n${renderBlock()}\n${END}`
  if (WRITE && has(DOC)) {
    const cur = raw(DOC)
    const a = cur.indexOf(BEGIN), b = cur.indexOf(END)
    if (a >= 0 && b > a) { writeFileSync(join(ROOT, DOC), cur.slice(0, a) + block + cur.slice(b + END.length)); console.log("    wrote the generated block") }
  }
  const doc = has(DOC) ? raw(DOC) : ""
  const a = doc.indexOf(BEGIN), b = doc.indexOf(END)
  const committed = a >= 0 && b > a ? doc.slice(a, b + END.length) : ""
  check("A5 the document exists and its generated per-table block equals what the code renders (drift = run --write)", committed === block, committed ? "drift" : "block missing")
  check("A5 the document carries the owner-approval plan for explicit_transfer and the safety-critical opt-out item", /## Owner-approval plan/.test(doc) && /contact_suppression_list/.test(doc.slice(doc.indexOf("## Owner-approval plan"))) && (childTables.filter((t) => childTransferClass(t) === "explicit_transfer")).every((t) => doc.slice(doc.indexOf("## Owner-approval plan")).includes(`\`${t}\``)))
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// B. THE brokerage-forms BUCKET
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
console.log("\n[B1 · m854 — the path rules: an ACTIVE STAFF SEAT, the packet's own row, own-folder browser writes]")
const m854 = migByName(/^m\d+-brokerage-forms-seat-scoped-path-rules\.sql$/)
const m855 = migByName(/^m\d+-brokerage-forms-storage-policies-owner\.sql$/)
const s854 = m854 ? raw(`supabase/migrations/${m854}`) : ""
const s855 = m855 ? raw(`supabase/migrations/${m855}`) : ""
const c854 = sqlCode(s854), c855 = sqlCode(s855)
const fnBody = (sql: string, name: string) => { const i = sql.indexOf(`FUNCTION public.${name}(`); if (i < 0) return ""; const a = sql.indexOf("$$", i), b = sql.indexOf("$$", a + 2); return a > 0 && b > a ? sql.slice(a + 2, b) : "" }
{
  check(`B1 m854 exists and states its status on line 1 (lane stamp or APPLIED LIVE) — ${m854 ?? "MISSING"}`, !!m854 && statusLineOk(s854.split("\n")[0], "145A"))
  const seat = fnBody(c854, "brokerage_forms_seat_active")
  const seatList = (/u\.user_type IN \(([^)]*)\)/.exec(seat)?.[1] ?? "").split(",").map((x) => x.trim().replace(/'/g, "")).filter(Boolean)
  const sameSet = (a: Iterable<string>, b: Iterable<string>) => { const x = [...a].sort().join(","), y = [...b].sort().join(","); return x === y }
  check("B1 the SQL seat list EQUALS the code's FORM_LIBRARY_SEAT_USER_TYPES (= the tenant admin roster + agent + tc, derived by spreading the Set)", seatList.length > 0 && sameSet(seatList, FORM_LIBRARY_SEAT_USER_TYPES) && sameSet(FORM_LIBRARY_SEAT_USER_TYPES, [...TENANT_ADMIN_USER_TYPES, "agent", "tc"]), `${seatList.join(",")}`)
  const live = (CHECK_VOCABULARIES as unknown as Record<string, Record<string, string[]>>).users?.user_type ?? []
  check("B1 every seat is a storable users.user_type (inside the live CHECK — never a role literal that matches nobody)", live.length > 0 && seatList.every((t) => live.includes(t)))
  check("B1 contacts, vendors, system, support and the AI ISA are NOT seats (in SQL and in code)", ["contact", "vendor", "system", "support", "isa"].every((t) => !seatList.includes(t) && !FORM_LIBRARY_SEAT_USER_TYPES.has(t)))
  control("a seat list naming 'contact' would be caught", !sameSet(["contact", ...seatList], FORM_LIBRARY_SEAT_USER_TYPES))
  check("B1 the seat is REVOKED on membership end: removed (deleted_at), not active (status), an agent deactivated in this brokerage",
    /u\.deleted_at IS NULL/.test(seat) && /coalesce\(u\.status, 'active'\) = 'active'/.test(seat) && /bool_or\(a\.is_active IS DISTINCT FROM false\)/.test(seat) && /a\.brokerage_id = u\.brokerage_id/.test(seat))
  const readable = fnBody(c854, "brokerage_forms_path_readable")
  const seatGated = (body: string) => /public\.brokerage_forms_seat_active\(\)\s*AND/.test(body)
  check("B1 READ: every tenant root sits behind the active-seat gate (only the platform superadmin arm is outside it)", seatGated(readable) && readable.indexOf("is_platform_admin()") < readable.indexOf("brokerage_forms_seat_active()"))
  control("the seat-gate finder flags m853's readable rule (any users row of the brokerage)", !seatGated(fnBody(sqlCode(has("supabase/migrations/m853-form-packets-are-brokerage-and-team-owned.sql") ? raw("supabase/migrations/m853-form-packets-are-brokerage-and-team-owned.sql") : ""), "brokerage_forms_path_readable")))
  check("B1 READ: own agents/ folder · brokerage loose files (not packets/) · registered packets only through their row · a LIVE team's loose files (member or oversight) · filled/{self | own-brokerage offer}; platform/ never for a seat",
    /'agents' AND split_part\(p_name, '\/', 2\) = auth\.uid\(\)::text/.test(readable) && /'brokerage' AND split_part\(p_name, '\/', 2\) = public\.current_user_brokerage_id\(\)::text\s+AND split_part\(p_name, '\/', 3\) <> 'packets'/.test(readable)
    && /IN \('brokerage', 'teams'\) AND split_part\(p_name, '\/', 3\) = 'packets'\s+AND public\.brokerage_forms_registered_packet_readable\(p_name\)/.test(readable)
    && /t\.id = public\.resolve_team_id\(auth\.uid\(\), NULL::uuid\) AND t\.deleted_at IS NULL/.test(readable) && /o\.brokerage_id = public\.current_user_brokerage_id\(\)/.test(readable) && !/'platform'/.test(readable) && /position\('\.\.' in p_name\) = 0/.test(readable))
  const packet = fnBody(c854, "brokerage_forms_registered_packet_readable")
  check("B1 a REGISTERED packet reads only through its own row: exact storage_path, row id in the path, own brokerage; manage = oversight / the team's lead; use = active + in licence + brokerage-wide or own live team",
    /l\.storage_path = p_name/.test(packet) && /split_part\(p_name, '\/', 4\) = l\.id::text/.test(packet) && /l\.brokerage_id = public\.current_user_brokerage_id\(\)/.test(packet)
    && /l\.team_id = public\.current_user_led_team_id\(\)/.test(packet) && /l\.is_active/.test(packet) && /l\.license_expires_at IS NULL OR l\.license_expires_at >= current_date/.test(packet) && /t\.deleted_at IS NULL/.test(packet))
  check("B1 …the code twin agrees: oversight = tenant admin roster minus team_lead; a licence expiring TODAY still admits (code: expired when < today)", !PACKET_OVERSIGHT_USER_TYPES.has("team_lead") && /coalesce\(public\.current_user_type\(\), ''\) <> 'team_lead'/.test(packet))
  const writable = fnBody(c854, "brokerage_forms_path_writable")
  const writesOtherRoots = (body: string) => /'(brokerage|teams|filled|platform)'/.test(body) || /is_platform_admin/.test(body)
  check("B1 WRITE: a browser session writes ONLY its own agents/{uid}/ folder, as an active seat — no brokerage / teams / filled / platform arm", seatGated(writable) && /split_part\(p_name, '\/', 1\) = 'agents'/.test(writable) && /split_part\(p_name, '\/', 2\) = auth\.uid\(\)::text/.test(writable) && !writesOtherRoots(writable))
  control("the other-root finder flags m853's writable rule (brokerage / teams arms)", writesOtherRoots(fnBody(sqlCode(has("supabase/migrations/m853-form-packets-are-brokerage-and-team-owned.sql") ? raw("supabase/migrations/m853-form-packets-are-brokerage-and-team-owned.sql") : ""), "brokerage_forms_path_writable")))
  check("B1 every m854 function is SECURITY DEFINER with a pinned search_path", ["brokerage_forms_seat_active", "brokerage_forms_registered_packet_readable", "brokerage_forms_path_readable", "brokerage_forms_path_writable"].every((n) => new RegExp(`FUNCTION public\\.${n}\\([^)]*\\)\\s+RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'`).test(c854)))
  check("B1 the library's row read follows the seat (ALTER POLICY brokerage_form_library_tenant_select … brokerage_forms_seat_active()), and no persisted packet link survives (pdf_url cleared where a master is stored)",
    /ALTER POLICY brokerage_form_library_tenant_select ON public\.brokerage_form_library[\s\S]{0,200}public\.brokerage_forms_seat_active\(\)/.test(c854) && /UPDATE public\.brokerage_form_library SET pdf_url = NULL WHERE storage_path IS NOT NULL/.test(c854))
  check("B1 m854 touches no storage.objects policy (that is m855, the owner's)", !/ON storage\.objects/.test(c854))
}

console.log("\n[B2 · m855 — the owner-held storage.objects policies, and OWNER-SQL §F]")
{
  check(`B2 m855 exists and states its status on line 1 — ${m855 ?? "MISSING"}`, !!m855 && statusLineOk(s855.split("\n")[0], "145A"))
  check("B2 refuses to run without m854 (DO block on to_regprocedure of all four functions), as ONE transaction", /BEGIN;/.test(c855) && /COMMIT;/.test(c855) && ["brokerage_forms_seat_active()", "brokerage_forms_registered_packet_readable(text)", "brokerage_forms_path_readable(text)", "brokerage_forms_path_writable(text)"].every((f) => c855.includes(`to_regprocedure('public.${f}') IS NULL`)) && /RAISE EXCEPTION/.test(c855))
  const dropped = ["auth read brokerage-forms", "auth upload brokerage-forms", "auth update brokerage-forms", "auth delete brokerage-forms", "brokerage-forms owner read", "brokerage-forms owner upload", "brokerage-forms owner update", "brokerage-forms owner delete"]
  check("B2 drops the four BUCKET-WIDE policies (and the m853 names, so it re-runs)", dropped.every((n) => c855.includes(`DROP POLICY IF EXISTS "${n}"`)))
  const creates = [...c855.matchAll(/CREATE POLICY "([^"]+)" ON storage\.objects\s+FOR (\w+) TO authenticated\s+([\s\S]*?);/g)].map((m) => ({ name: m[1], op: m[2], body: m[3] }))
  const want: Record<string, { op: string; re: RegExp }> = {
    "brokerage-forms owner read": { op: "SELECT", re: /^USING \(bucket_id = 'brokerage-forms' AND public\.brokerage_forms_path_readable\(name\)\)$/ },
    "brokerage-forms owner upload": { op: "INSERT", re: /^WITH CHECK \(bucket_id = 'brokerage-forms' AND public\.brokerage_forms_path_writable\(name\)\)$/ },
    "brokerage-forms owner update": { op: "UPDATE", re: /^USING \(bucket_id = 'brokerage-forms' AND public\.brokerage_forms_path_writable\(name\)\)\s+WITH CHECK \(bucket_id = 'brokerage-forms' AND public\.brokerage_forms_path_writable\(name\)\)$/ },
    "brokerage-forms owner delete": { op: "DELETE", re: /^USING \(bucket_id = 'brokerage-forms' AND public\.brokerage_forms_path_writable\(name\)\)$/ },
  }
  check("B2 creates EXACTLY four owner-scoped policies — SELECT through the readable rule, INSERT / UPDATE (USING + CHECK) / DELETE through the writable rule", creates.length === 4 && creates.every((c) => want[c.name] && want[c.name].op === c.op && want[c.name].re.test(c.body.trim())), creates.map((c) => `${c.name}:${c.op}`).join(","))
  const bucketWide = (sql: string) => /CREATE POLICY[\s\S]{0,120}ON storage\.objects[\s\S]{0,80}(USING|WITH CHECK) \(bucket_id = 'brokerage-forms'\)/.test(sql)
  check("B2 no policy it creates is bucket-wide", !bucketWide(c855))
  control("the bucket-wide finder flags the live shape", bucketWide(`CREATE POLICY "auth read brokerage-forms" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'brokerage-forms');`))
  const owner = has("docs/operations/OWNER-SQL.md") ? raw("docs/operations/OWNER-SQL.md") : ""
  const secF = owner.slice(owner.indexOf("## F."), owner.indexOf("## After you run anything"))
  const stmts = c855.split(/;\s*\n/).map((x) => x.trim()).filter((x) => x.length > 0)
  const missing = stmts.filter((x) => !norm(secF).includes(norm(x)))
  check(`B2 OWNER-SQL §F carries every m855 statement verbatim (${stmts.length - missing.length}/${stmts.length})`, stmts.length >= 12 && missing.length === 0, missing.map((x) => x.slice(0, 60)).join(" | "))
  control("a tampered statement is not found verbatim", !norm(secF).includes(norm(`CREATE POLICY "brokerage-forms owner read" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'brokerage-forms');`)))
  check("B2 §F gives the preconditions, the owner route when the SQL editor is refused 42501 (Storage → Policies), and the verification queries with expected values (policy list, no bucket-wide rule, a contact refused, an agent's own-folder writes)",
    /to_regprocedure/.test(secF) && /pg_has_role\(current_user, 'supabase_storage_admin', 'member'\)/.test(secF) && /Storage → Policies/.test(secF) && /set_config\('request\.jwt\.claims'/.test(secF) && /contact_reads_brokerage_forms/.test(secF) && /agent_writes_brokerage/.test(secF) && /m853 block\)|must NOT be run as it was written/.test(secF))
}

console.log("\n[B3 · the DOOR CENSUS — every storage operation on the bucket, its gate, its TTL]")
const BUCKET_REF = String.raw`(?:"brokerage-forms"|'brokerage-forms'|FORM_PACKET_BUCKET|PLATFORM_PACKET_BUCKET|FORMS_BUCKET|FILLED_BUCKET)`
const OP_RE = new RegExp(String.raw`storage\s*\.from\(\s*${BUCKET_REF}\s*\)\s*\.(\w+)\(`, "g")
const walk = (dir: string, out: string[] = []): string[] => {
  for (const n of readdirSync(join(ROOT, dir))) {
    if (["node_modules", ".next", ".git"].includes(n)) continue
    const p = `${dir}/${n}`
    if (statSync(join(ROOT, p)).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(n)) out.push(p)
  }
  return out
}
type Op = { file: string; fn: string; op: string; index: number; src: string }
const enclosing = (src: string, i: number): { name: string; start: number } => {
  // a function declaration, or a const bound to an ARROW (params then `=>`) — `const x = (a.b(c))` is not a function
  const re = /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:useCallback\(\s*)?(?:async\s*)?\([^()]*\)\s*(?::[^=]{1,80})?=>/g
  let best = { name: "<module>", start: 0 }
  for (const m of src.matchAll(re)) { if ((m.index ?? 0) > i) break; best = { name: m[1] ?? m[2], start: m.index ?? 0 } }
  return best
}
const findOps = (file: string, src: string): Op[] => [...src.matchAll(OP_RE)].map((m) => ({ file, fn: enclosing(src, m.index ?? 0).name, op: m[1], index: m.index ?? 0, src }))
// The DECLARED doors: file + enclosing function + the operations it may run + the gate token that must precede them in the function.
const DOORS: Array<{ file: string; fn: string; ops: Record<string, number>; gate: RegExp; why: string }> = [
  { file: "app/components/form-wizard/FormWizard.tsx", fn: "loadStep2", ops: { list: 1, createSignedUrl: 1 }, gate: /prefix: `agents\/\$\{agentUserId\}\/`/, why: "browser session — own agents/{id}/ folder only (m855 readable)" },
  { file: "app/components/form-wizard/FormWizard.tsx", fn: "handleUpload", ops: { upload: 1, createSignedUrl: 1 }, gate: /storagePath = `agents\/\$\{agentUserId\}\/uploads\//, why: "browser session — own agents/{id}/uploads/ (m855 writable)" },
  { file: "lib/esign/dispatch-packet.ts", fn: "signedUrlsFor", ops: { createSignedUrl: 1 }, gate: /storagePath/, why: "session-free core; every caller passing storagePath checks scope first (asserted below)" },
  { file: "lib/esign/dispatch-packet.ts", fn: "bytesFor", ops: { download: 1 }, gate: /storagePath/, why: "same" },
  { file: "lib/esign/dispatch-packet.ts", fn: "incompletePacketReason", ops: { download: 1 }, gate: /storagePath/, why: "same" },
  { file: "lib/forms/tenant-form-packets.ts", fn: "listFormPacketsForActor", ops: { list: 1 }, gate: /packetVisibleTo\(/, why: "the actor's own brokerage / team prefixes after the visibility rule" },
  { file: "lib/forms/tenant-form-packets.ts", fn: "issueTenantPacketUrl", ops: { createSignedUrl: 1 }, gate: /packetVisibleTo\(|mayManagePacketScope\(/, why: "THE minting door — use = visibility, manage = scope authority" },
  { file: "lib/forms/tenant-form-packets.ts", fn: "registerTenantFormPacket", ops: { upload: 1, remove: 1 }, gate: /mayManagePacketScope\(/, why: "the registry writer, after the sharing authority" },
  { file: "lib/forms/tenant-form-packets.ts", fn: "registerCopiedPacket", ops: { copy: 1, remove: 1 }, gate: /mayManagePacketScope\(/, why: "catalogue copy, after the sharing authority" },
  { file: "lib/forms/platform-form-packets.ts", fn: "registerPlatformPacket", ops: { upload: 1, remove: 1 }, gate: /parsePlatformPacketPath|platform/, why: "superadmin catalogue writer — the caller gates requireSuperadmin (asserted below)" },
  { file: "app/api/admin/transaction-forms/route.ts", fn: "GET", ops: { createSignedUrl: 1 }, gate: /authAdmin\(\)[\s\S]*parsePlatformPacketPath\(/, why: "catalogue preview for a tenant admin, a well-formed platform path only" },
  { file: "app/api/form-wizard/form-packets/route.ts", fn: "GET", ops: { createSignedUrl: 1 }, gate: /resolvePacketActor\([\s\S]*listFormPacketsForActor\(/, why: "the seat-resolved actor's visible packets only" },
  { file: "app/actions/buyer-offer/prefill-storage-form.ts", fn: "prefillStorageFormAction", ops: { download: 1, upload: 1, createSignedUrl: 1 }, gate: /checkFormPathsInScope\(/, why: "fill action — source path scope-checked (destination: outside-lane item)" },
  { file: "app/actions/buyer-offer/esign-anchor-plan.ts", fn: "buildEsignAnchorPlanAction", ops: { download: 1 }, gate: /checkFormPathsInScope\(/, why: "anchor plan read, scope-checked" },
]
{
  const files = [...walk("app"), ...walk("lib")].filter((f) => { const s = raw(f); return /brokerage-forms|FORM_PACKET_BUCKET|PLATFORM_PACKET_BUCKET|FORMS_BUCKET|FILLED_BUCKET/.test(s) })
  const ops = files.flatMap((f) => findOps(f, blankComments(raw(f))))
  console.log(`    (published) ${ops.length} storage operations on the bucket in ${new Set(ops.map((o) => o.file)).size} files (of ${files.length} that name it): ${[...new Set(ops.map((o) => `${o.file.replace(/^.*\//, "")}:${o.fn}.${o.op}`))].join(" · ")}`)
  const undeclared = ops.filter((o) => !DOORS.some((d) => d.file === o.file && d.fn === o.fn && o.op in d.ops))
  check("B3 EVERY storage operation on the bucket is a DECLARED door (a new reader / writer / signer must be declared with its gate)", undeclared.length === 0, undeclared.map((o) => `${o.file}:${o.fn}.${o.op}`).join(", "))
  const countMismatch = DOORS.filter((d) => Object.entries(d.ops).some(([op, n]) => ops.filter((o) => o.file === d.file && o.fn === d.fn && o.op === op).length !== n))
  check("B3 each declared door runs exactly its declared operations (a door that vanished or doubled is a finding)", countMismatch.length === 0, countMismatch.map((d) => `${d.file}:${d.fn}`).join(", "))
  const ungated = ops.filter((o) => { const d = DOORS.find((x) => x.file === o.file && x.fn === o.fn); if (!d) return false; const start = enclosing(o.src, o.index).start; return !d.gate.test(o.src.slice(start, o.index)) })
  check("B3 every door's GATE precedes its operation inside the same function", ungated.length === 0, ungated.map((o) => `${o.file}:${o.fn}.${o.op}`).join(", "))
  const synthetic = `async function leak(p) {\n  const x = await svc\n    .storage\n    .from(FORM_PACKET_BUCKET)\n    .download(p)\n}`
  control("the census finds a multi-line operation through a bucket constant, and reads it as undeclared", findOps("lib/x.ts", synthetic).length === 1 && findOps("lib/x.ts", synthetic)[0].fn === "leak" && !DOORS.some((d) => d.fn === "leak"))
  // callers of the session-free dispatch core that pass storagePath must scope-check first; the catalogue writer's caller is superadmin-gated
  const dispatchCallers = walk("app").concat(walk("lib")).filter((f) => f !== "lib/esign/dispatch-packet.ts" && /dispatchEsignPacket\(/.test(stripComments(raw(f))))
  const unsafeCallers = dispatchCallers.filter((f) => { const s = stripComments(raw(f)); return /storagePath/.test(s) && !(s.indexOf("checkFormPathsInScope(") >= 0 && s.indexOf("checkFormPathsInScope(") < s.indexOf("dispatchEsignPacket(")) })
  check(`B3 every caller of the dispatch core that passes brokerage-forms paths checks their scope BEFORE dispatching (${dispatchCallers.length} callers)`, dispatchCallers.length >= 2 && unsafeCallers.length === 0, unsafeCallers.join(","))
  const sa = stripComments(raw("app/actions/superadmin/platform-form-packets.ts"))
  check("B3 the catalogue writer is reached only after requireSuperadmin()", /requireSuperadmin\(\)/.test(sa) && sa.indexOf("requireSuperadmin()") < sa.indexOf("registerPlatformPacket("))
  // TTL — no long-lived URL minted or persisted for the bucket
  const TTL_CONST: Record<string, number> = { FORM_PACKET_PREVIEW_TTL_SECONDS: 900, PLATFORM_PACKET_PREVIEW_TTL_SECONDS: 900, FORM_URL_TTL_SECONDS: 60 * 60 * 24 * 365 * 10 }
  const ttlOf = (expr: string): number | null => { const e = expr.trim(); if (e in TTL_CONST) return TTL_CONST[e]; if (/^[\d\s*]+$/.test(e)) return e.split("*").reduce((a, x) => a * Number(x.trim()), 1); return null }
  const signs = ops.filter((o) => o.op === "createSignedUrl").map((o) => { const after = o.src.slice(o.index); const m = /createSignedUrl\(\s*[^,]+,\s*([^)]+)\)/.exec(after); return { o, ttl: m ? ttlOf(m[1]) : null, expr: m?.[1] ?? "?" } })
  check("B3 the TTL constants the census evaluates are the code's own (positive: FORM_PACKET_PREVIEW_TTL_SECONDS = 900)", FORM_PACKET_PREVIEW_TTL_SECONDS === 900 && /import \{ DOC_URL_TTL_SECONDS as FORM_URL_TTL_SECONDS \}/.test(raw("app/components/form-wizard/FormWizard.tsx")) === (TTL_CONST.FORM_URL_TTL_SECONDS > 0))
  const longLived = signs.filter((s) => s.ttl === null || s.ttl > 3600)
  // RATCHET: the FormWizard's own-folder links use DOC_URL_TTL_SECONDS (10 years) — outside this lane's domain; may only shrink.
  const KNOWN_LONG_TTL = new Set(["app/components/form-wizard/FormWizard.tsx:loadStep2", "app/components/form-wizard/FormWizard.tsx:handleUpload"])
  const newLong = longLived.filter((s) => !KNOWN_LONG_TTL.has(`${s.o.file}:${s.o.fn}`))
  console.log(`    (published) signed-URL TTLs: ${signs.map((s) => `${s.o.fn}=${s.ttl ?? s.expr}`).join(" · ")} — long-lived (> 1 h): ${longLived.map((s) => `${s.o.file}:${s.o.fn}`).join(", ") || "none"} (known outside-lane: ${KNOWN_LONG_TTL.size})`)
  check("B3 no NEW door mints a link that outlives one hour (the two FormWizard own-folder links are a published outside-lane ratchet)", newLong.length === 0, newLong.map((s) => `${s.o.file}:${s.o.fn}=${s.expr}`).join(", "))
  control("the TTL evaluator reads a 10-year expression as long-lived", (ttlOf("60 * 60 * 24 * 365 * 10") ?? 0) > 3600 && ttlOf("60 * 30") === 1800)
  const persisted = files.filter((f) => new RegExp(String.raw`issueBucketObjectUrl\([\s\S]{0,200}bucket:\s*${BUCKET_REF}`).test(blankComments(raw(f))))
  check("B3 no code persists a long-lived bucket URL through issueBucketObjectUrl (the 10-year pdf_url writer is gone)", persisted.length === 0, persisted.join(","))
  control("the persisted-URL finder sees the retired shape", new RegExp(String.raw`issueBucketObjectUrl\([\s\S]{0,200}bucket:\s*${BUCKET_REF}`).test(`await issueBucketObjectUrl(svc, { bucket: FORM_PACKET_BUCKET, objectPath: p })`))
  const route = stripComments(raw("app/api/admin/transaction-forms/route.ts"))
  check("B3 the library route mints every packet link per view through the ONE door (issueTenantPacketUrl), and never writes pdf_url", /issueTenantPacketUrl\(/.test(route) && !/update\(\{\s*pdf_url/.test(route))
  // THE SEAT DOOR: a door that builds its FormPathActor from a raw users read instead of resolvePacketActor. RATCHET (outside-lane).
  const KNOWN_RAW_ACTOR_DOORS = new Set(["app/actions/buyer-offer/prefill-storage-form.ts", "app/actions/buyer-offer/esign-anchor-plan.ts", "app/actions/buyer-offer/submit-for-signature.ts", "app/actions/listings-kernel.ts"])
  const scopeCallers = [...walk("app"), ...walk("lib")].filter((f) => f !== "lib/forms/form-path-scope.ts" && /checkFormPathsInScope\(/.test(stripComments(raw(f))))
  const rawActorDoors = scopeCallers.filter((f) => !/resolvePacketActor\(/.test(stripComments(raw(f))))
  const newRaw = rawActorDoors.filter((f) => !KNOWN_RAW_ACTOR_DOORS.has(f))
  console.log(`    (published) scope-check doors: ${scopeCallers.length}; still building the actor from a raw users read (outside-lane, ratchet): ${rawActorDoors.join(", ") || "none"}; fixed: ${[...KNOWN_RAW_ACTOR_DOORS].filter((f) => !rawActorDoors.includes(f)).join(", ") || "none"}`)
  check("B3 no NEW door builds its forms actor from a raw users read (resolve it with resolvePacketActor — a contact / vendor / suspended account is refused there)", newRaw.length === 0, newRaw.join(","))
  control("the raw-actor finder flags a door with no seat resolver", !/resolvePacketActor\(/.test(`const { data: me } = await authClient.from("users").select("brokerage_id, team_id"); await checkFormPathsInScope(svc, [p], { brokerageId: me.brokerage_id, teamId: null, userId })`))
}

console.log("\n[B4 · behaviour: the session → actor door and the ONE minting door (in memory)]")
{
  const B1 = randomUUID(), B2 = randomUUID(), T1 = randomUUID(), T2 = randomUUID(), TDEL = randomUUID()
  const U = { agent: randomUUID(), contact: randomUUID(), vendor: randomUUID(), suspended: randomUUID(), removed: randomUUID(), deact: randomUUID(), tc: randomUUID(), lead: randomUUID(), broker: randomUUID(), member: randomUUID(), delMember: randomUUID(), sa: randomUUID(), nullStatus: randomUUID() }
  const svc: any = memSupabase({
    users: [
      { id: U.agent, brokerage_id: B1, user_type: "agent", status: "active", deleted_at: null, platform_role: null, team_id: null },
      { id: U.contact, brokerage_id: B1, user_type: "contact", status: "active", deleted_at: null, platform_role: null, team_id: null },
      { id: U.vendor, brokerage_id: B1, user_type: "vendor", status: "active", deleted_at: null, platform_role: null, team_id: null },
      { id: U.suspended, brokerage_id: B1, user_type: "agent", status: "suspended", deleted_at: null, platform_role: null, team_id: null },
      { id: U.removed, brokerage_id: B1, user_type: "agent", status: "active", deleted_at: "2026-10-01T00:00:00Z", platform_role: null, team_id: null },
      { id: U.deact, brokerage_id: B1, user_type: "agent", status: "active", deleted_at: null, platform_role: null, team_id: null },
      { id: U.tc, brokerage_id: B1, user_type: "tc", status: "active", deleted_at: null, platform_role: null, team_id: null },
      { id: U.lead, brokerage_id: B1, user_type: "team_lead", status: "active", deleted_at: null, platform_role: null, team_id: null },
      { id: U.broker, brokerage_id: B1, user_type: "broker", status: "active", deleted_at: null, platform_role: null, team_id: null },
      { id: U.member, brokerage_id: B1, user_type: "agent", status: "active", deleted_at: null, platform_role: null, team_id: T1 },
      { id: U.delMember, brokerage_id: B1, user_type: "agent", status: "active", deleted_at: null, platform_role: null, team_id: TDEL },
      { id: U.sa, brokerage_id: B1, user_type: "system", status: "active", deleted_at: null, platform_role: "superadmin", team_id: null },
      { id: U.nullStatus, brokerage_id: B1, user_type: "tc", status: null, deleted_at: null, platform_role: null, team_id: null },
    ],
    agents: [{ id: "ag-deact", user_id: U.deact, brokerage_id: B1, is_active: false, team_id: null }, { id: "ag-agent", user_id: U.agent, brokerage_id: B1, is_active: true, team_id: null }],
    teams: [
      { id: T1, brokerage_id: B1, team_lead_id: U.lead, deleted_at: null, name: "North" },
      { id: T2, brokerage_id: B1, team_lead_id: null, deleted_at: null, name: "South" },
      { id: TDEL, brokerage_id: B1, team_lead_id: null, deleted_at: "2026-09-01T00:00:00Z", name: "Gone" },
    ],
    team_members: [], user_role_assignments: [], offers: [],
  })
  svc.storage = { from: (b: string) => ({ createSignedUrl: async (p: string, ttl: number) => ({ data: { signedUrl: `signed://${b}/${p}?ttl=${ttl}` }, error: null }) }) }
  const ra = async (u: string) => resolvePacketActor(svc, u)
  const refused = async (u: string, re: RegExp) => { const r = await ra(u); return !r.ok && re.test(r.error) }
  check("B4 a portal CONTACT and a VENDOR seat of the brokerage are refused (both carry brokerage_id)", (await refused(U.contact, /staff seats/)) && (await refused(U.vendor, /staff seats/)))
  check("B4 a SUSPENDED and a REMOVED account are refused; an agent DEACTIVATED in this brokerage is refused", (await refused(U.suspended, /suspended/)) && (await refused(U.removed, /removed/)) && (await refused(U.deact, /deactivated/)))
  check("B4 an agent (with or without an agents row), a TC, a team lead and a broker are admitted; a platform superadmin is admitted", (await ra(U.agent)).ok && (await ra(U.member)).ok && (await ra(U.tc)).ok && (await ra(U.lead)).ok && (await ra(U.broker)).ok && (await ra(U.sa)).ok)
  const del = await ra(U.delMember)
  check("B4 a member of a DELETED team is admitted to the brokerage but LOSES the team (membership ended)", del.ok && del.actor.teamId === null)
  control("a live team's member keeps it", (await ra(U.member)).ok && ((await ra(U.member)) as any).actor.teamId === T1)
  check("B4 like the SQL twin, a NULL status reads as active; an unknown account is refused", (await ra(U.nullStatus)).ok && !(await ra(randomUUID())).ok)
  const agentDoor = await ra(U.member)
  check("B4 the session → actor door hands a staff seat its canonical team (the FormPathActor a door builds from it)", agentDoor.ok && agentDoor.actor.teamId === T1 && agentDoor.actor.brokerageId === B1)
  const viaDoor = agentDoor.ok ? await checkFormPathsInScope(svc, [`brokerage/${B1}/a.pdf`, `teams/${T1}/a.pdf`, `teams/${T2}/a.pdf`, `brokerage/${B2}/a.pdf`], { brokerageId: agentDoor.actor.brokerageId, teamId: agentDoor.actor.teamId, userId: agentDoor.actor.userId }) : null
  check("B4 a staff seat via the door: own brokerage + own team admitted; another team and another tenant refused", !!viaDoor && viaDoor.refused.length === 2 && viaDoor.refused.includes(`teams/${T2}/a.pdf`) && viaDoor.refused.includes(`brokerage/${B2}/a.pdf`))
  // the ONE minting door
  const actorOf = (o: Partial<PacketActor>): PacketActor => ({ userId: randomUUID(), brokerageId: B1, userType: "agent", teamId: null, ledTeamId: null, oversight: false, ...o })
  const row = (o: Record<string, unknown>) => { const id = randomUUID(); const team = (o.team_id as string | null) ?? null; return { id, brokerage_id: B1, team_id: team, is_active: true, license_expires_at: null, storage_path: team ? `teams/${team}/packets/${id}/p.pdf` : `brokerage/${B1}/packets/${id}/p.pdf`, ...o } }
  const NOW = new Date("2026-10-27T12:00:00Z")
  const mint = (a: PacketActor, r: any, p: "use" | "manage") => issueTenantPacketUrl(svc, a, r, p, NOW)
  const member = actorOf({ teamId: T1 }), other = actorOf({ teamId: T2 }), broker = actorOf({ userType: "broker", oversight: true }), lead = actorOf({ userType: "team_lead", teamId: T1, ledTeamId: T1 }), foreign = actorOf({ brokerageId: B2 })
  const wide = row({}), team1 = row({ team_id: T1 }), retired = row({ is_active: false }), expired = row({ license_expires_at: "2026-10-26" })
  const m1 = await mint(member, wide, "use")
  check("B4 USE: a brokerage-wide packet mints for any member — SHORT-lived (the TTL is the 15-minute preview constant)", m1.ok && m1.ttlSeconds === FORM_PACKET_PREVIEW_TTL_SECONDS && FORM_PACKET_PREVIEW_TTL_SECONDS <= 3600 && /ttl=900/.test(m1.url))
  check("B4 USE: a team packet mints for its member, never for another team's agent or another tenant", (await mint(member, team1, "use")).ok && !(await mint(other, team1, "use")).ok && !(await mint(foreign, wide, "use")).ok)
  check("B4 USE: a retired or expired packet mints for nobody", !(await mint(member, retired, "use")).ok && !(await mint(member, expired, "use")).ok)
  check("B4 MANAGE: the oversight class reviews a retired packet; a team lead manages their own team's packet but not a brokerage-wide one; an agent manages nothing",
    (await mint(broker, retired, "manage")).ok && (await mint(lead, team1, "manage")).ok && !(await mint(lead, wide, "manage")).ok && !(await mint(member, wide, "manage")).ok)
  check("B4 a row whose stored path is not EXACTLY its own registered packet path (wrong row id, wrong owner) mints nothing", !(await mint(broker, { ...wide, storage_path: `brokerage/${B1}/packets/${randomUUID()}/p.pdf` }, "manage")).ok && !(await mint(broker, { ...team1, storage_path: `teams/${T2}/packets/${team1.id}/p.pdf` }, "manage")).ok)
  const refusingSigner: any = { ...svc, storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: "bucket refused" } }) }) } }
  const refusedSign = await issueTenantPacketUrl(refusingSigner, member, wide, "use", NOW)
  check("B4 a refused signer is a refusal with its reason — never a public fallback", !refusedSign.ok && /bucket refused/.test(refusedSign.reason))
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
if (failed) { console.log("\nFAILURES:"); for (const f of failures) console.log(`  - ${f}`); console.log("\n❌ TRANSFER_CLASSIFICATION_FAIL"); process.exit(1) }
console.log("✅ TRANSFER_CLASSIFICATION_PASS — every FK child onto a moved family has a class and no protected class is ever moved by the rail; the brokerage-forms bucket admits only active staff seats through declared, gated doors")
