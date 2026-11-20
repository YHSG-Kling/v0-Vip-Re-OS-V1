/**
 * scripts/status-override-guard.ts — test:status-override (wave 148, lane 148I; pure, no DB, no network).
 *
 * OWNER RULINGS 13 + 14 + 21 (2026-11-01): "manual status picking is always a choice but human needs to provide proof or
 * reason of the change"; "if a status is offered the UI has to show it"; "a closing date can also be worded as 'on or
 * before'". CONTRACT C23 + the closing-date model.
 *
 *   A · the registry = the live CHECKs (derived from scripts/check-vocabularies.ts), every value labelled + governed
 *   B · decideStatusOverride — reason, proof, gated values, hard gates, actor (each refusal with a POSITIVE CONTROL)
 *   C · the transaction gate's blockers: every literal in the gate's source classified hard / soft (unknown = hard)
 *   D · overrideStatus — refused writes nothing; the write runs inside the ledger with the evidence; a refused ledger writes
 *       nothing; a replay does not re-apply
 *   E · every manual door asks the ONE decision before it writes (stripped source); updateTransaction refuses status/close_date
 *   F · VOCABULARY ⊆ UI — per entity, the authorized UI renders every value (the census table is printed)
 *   G · the closing-date model — contractual (on / on or before) vs anticipated vs actual; early closing ≠ executed amendment;
 *       state note; the writers; m927 (either stamp)
 *
 * Every absence assertion has a POSITIVE CONTROL (CLAUDE.md §2). Blind spots printed at the end.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { memSupabase } from "./in-memory-supabase"
import {
  STATUS_ENTITIES, OVERRIDE_REASON_MIN_CHARS, decideStatusOverride, statusOptionsFor, statusLabel,
  partitionStageBlockers, overrideStatus, listingStageOverrideRefusal, GATED_TRANSACTION_STAGES,
  type StatusEntity, type StatusValuePolicy,
} from "../lib/kernel/status-override"

/** The registry entry shape, read structurally (the module keeps its own interface private). */
type StatusEntityPolicy = { label: string; table: string; column: string; values: readonly string[]; labels: Readonly<Record<string, string>>; policy: Readonly<Record<string, StatusValuePolicy>>; manualDoor: string | null }
const STATUS_ENTITY_KEYS = Object.keys(STATUS_ENTITIES) as StatusEntity[]
import {
  resolveClosingDates, applyClosingDateChange, CLOSING_DATE_TERMS,
} from "../lib/transactions/closing-dates"
// wave 149, lane 149G: ATTORNEY_CLOSING_REPORTED (closing-dates.ts) merged onto the sourced state survivor — tombstone there.
import { STATE_CLOSING_POLICIES } from "../lib/state-forms/closing-participants"

// The pure deciders are module-private; the guard drives them through the PRODUCT paths that reach them:
/** one blocker through the stage override's own partition */
const classifyTransactionStageBlocker = (b: string): "hard" | "soft" => (partitionStageBlockers([b]).hard.length ? "hard" : "soft")
/** the state note through resolveClosingDates (what the panel and the unattended facts read) */
const closingStateNote = (state: string | null) => resolveClosingDates({ property_state: state }).stateNote

let pass = 0, fail = 0
const failures: string[] = []
function check(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const ROOT = process.cwd()
const raw = (p: string) => { try { return readFileSync(join(ROOT, p), "utf8") } catch { return "" } }
const code = (p: string) => stripComments(raw(p))
/** Code tokens only — comments AND string contents blanked (a tombstone or a fixture string is never a call site). */
const tokens = (p: string) => blankStrings(stripComments(raw(p)))
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|")
const actor = { userId: "u-1", userType: "broker" }
const REASON = "Seller called — the deal fell through on financing"

/** A specimen fn body: from `export async function NAME` (or `function NAME`) to the next top-level function. */
function fnBody(src: string, name: string): string {
  const m = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[(<]`).exec(src)
  if (!m) return ""
  const rest = src.slice(m.index + 1)
  const next = rest.search(/\n(?:export\s+)?(?:async\s+)?function\s+\w+\s*[(<]/)
  return src.slice(m.index, next < 0 ? undefined : m.index + 1 + next)
}

async function main() {
  // ── A ────────────────────────────────────────────────────────────────────────────────────────
  section("A · the registry equals the live CHECKs; every value labelled and governed")
  for (const key of STATUS_ENTITY_KEYS) {
    const e = STATUS_ENTITIES[key] as StatusEntityPolicy
    const live = CHECK_VOCABULARIES[e.table]?.[e.column] ?? null
    check(`${key}: ${e.table}.${e.column} values = the live CHECK (${e.values.length})`, !!live && sameSet(e.values, live), live ? `registry ${e.values.join(",")} vs CHECK ${live.join(",")}` : "no CHECK in the cache")
    const labels = e.labels as Record<string, string>, policy = e.policy as Record<string, StatusValuePolicy>
    check(`${key}: every value has a label and a policy (manual or gated with its door)`, e.values.every((v) => !!labels[v]?.trim() && !!policy[v] && (policy[v].door === "manual" || !!policy[v].gate?.door)))
    check(`${key}: no label or policy for a value the CHECK does not admit`, Object.keys(labels).every((k) => e.values.includes(k)) && Object.keys(policy).every((k) => e.values.includes(k)))
    check(`${key}: the manual door is named exactly when some value is manual`, (e.manualDoor !== null) === e.values.some((v) => policy[v].door === "manual"))
  }
  {
    const forged = { values: ["open", "closed", "snoozed"] }
    check("POSITIVE CONTROL: a registry value the CHECK does not admit is caught", !sameSet(forged.values, CHECK_VOCABULARIES.support_tickets.status))
  }
  check("the listing's gated values are exactly C12's gated statuses (Listing Signed, Coming Soon, Active)", sameSet(STATUS_ENTITIES.listing.values.filter((v) => (STATUS_ENTITIES.listing.policy as Record<string, StatusValuePolicy>)[v].door === "gated"), ["listing_signed", "coming_soon", "active"]))
  check("money and signature vocabularies have NO manual value (commission payments, offer signatures)", (["commission_payment", "offer_esign"] as StatusEntity[]).every((k) => (STATUS_ENTITIES[k] as StatusEntityPolicy).values.every((v) => ((STATUS_ENTITIES[k] as StatusEntityPolicy).policy as Record<string, StatusValuePolicy>)[v].door === "gated")))
  {
    const fin = code("lib/kernel/financial.ts")
    const m = /COMMISSION_STATUS_TRANSITIONS[^=]*=\s*\{([\s\S]*?)\n\}/.exec(fin)
    const keys = m ? [...m[1].matchAll(/^\s*(\w+)\s*:/gm)].map((x) => x[1]) : []
    check("the commission vocabulary is the kernel ladder's own keys (lib/kernel/financial.ts COMMISSION_STATUS_TRANSITIONS)", sameSet(keys, STATUS_ENTITIES.commission_payment.values), keys.join(","))
  }

  // ── B ────────────────────────────────────────────────────────────────────────────────────────
  section("B · decideStatusOverride")
  const d = (x: Partial<Parameters<typeof decideStatusOverride>[0]>) => decideStatusOverride({ entity: "listing", from: "active", to: "withdrawn", reason: REASON, actor, ...x } as Parameters<typeof decideStatusOverride>[0])
  check("a manual pick WITH a reason is allowed (listing active → withdrawn)", d({}).ok === true)
  check("refused WITHOUT a reason", (d({ reason: null }) as { code?: string }).code === "reason_required")
  check(`refused with a reason shorter than ${OVERRIDE_REASON_MIN_CHARS} characters`, (d({ reason: "because" }) as { code?: string }).code === "reason_required")
  check("POSITIVE CONTROL: exactly the floor passes", d({ reason: "x".repeat(OVERRIDE_REASON_MIN_CHARS) }).ok === true)
  for (const [entity, to] of [["listing", "active"], ["listing", "coming_soon"], ["listing", "listing_signed"], ["transaction", "funded"], ["transaction", "under_contract"], ["offer_esign", "fully_executed"], ["commission_payment", "paid"], ["open_house_event", "completed"]] as Array<[StatusEntity, string]>) {
    const r = decideStatusOverride({ entity, from: null, to, reason: REASON, actor })
    check(`a gated value is never an override: ${entity} → ${to} (refused, the door named)`, !r.ok && r.code === "gated_value" && /Reached through: /.test(r.message), !r.ok ? r.message : "allowed")
  }
  check("Sold WITHOUT proof is refused", (d({ to: "sold" }) as { code?: string }).code === "evidence_required")
  check("Sold with proof of a kind it does not accept is refused", (d({ to: "sold", evidence: { kind: "provider_record", ref: "env-123" } }) as { code?: string }).code === "evidence_required")
  check("POSITIVE CONTROL: Sold WITH the settlement statement reference is allowed", d({ to: "sold", evidence: { kind: "document", ref: "ALTA-2026-0042" } }).ok === true)
  check("a deal CLOSED by hand needs proof", (decideStatusOverride({ entity: "transaction", from: "clear_to_close", to: "closed", stage: { from: "CLOSING_PREP", to: "CLOSED" }, reason: REASON, actor }) as { code?: string }).code === "evidence_required")
  check("…and with the title file number it is allowed", decideStatusOverride({ entity: "transaction", from: "clear_to_close", to: "closed", stage: { from: "CLOSING_PREP", to: "CLOSED" }, reason: REASON, evidence: { kind: "external_reference", ref: "title #88123" }, actor }).ok === true)
  check("a HARD blocker refuses whatever the reason / proof", (decideStatusOverride({ entity: "transaction", from: "clear_to_close", to: "closed", stage: { from: "CLOSING_PREP", to: "CLOSED" }, reason: REASON, evidence: { kind: "external_reference", ref: "title #88123" }, actor, hardBlockers: ["TRID: the Closing Disclosure must be delivered…"] }) as { code?: string }).code === "hard_gate")
  check("a stage move that keeps the status is not a pick of that status's gated door (INSPECTION → APPRAISAL, both under contract)", decideStatusOverride({ entity: "transaction", from: "under_contract", to: "under_contract", stage: { from: "INSPECTION", to: "APPRAISAL" }, reason: REASON, actor }).ok === true)
  check("POSITIVE CONTROL: the same status WITHOUT a stage move is no change", (decideStatusOverride({ entity: "transaction", from: "pending", to: "pending", reason: REASON, actor }) as { code?: string }).code === "no_change")
  check("no session actor → refused", (d({ actor: { userId: null } }) as { code?: string }).code === "no_actor")
  check("a value outside the vocabulary → refused, the valid ones named", (d({ to: "under_contract" }) as { code?: string; message?: string }).code === "not_a_value")
  check("an unregistered entity → refused", (decideStatusOverride({ entity: "spaceship" as StatusEntity, from: null, to: "x", reason: REASON, actor }) as { code?: string }).code === "unknown_entity")
  check("UNDER_CONTRACT is never a stage-override target (the creation gate)", typeof GATED_TRANSACTION_STAGES.UNDER_CONTRACT === "string")
  check("a listing STAGE override may not reach a gated stage (MLS_ACTIVE / LISTING_AGREEMENT_SIGNED / COMING_SOON_PREP / COMING_SOON_ACTIVE)", ["MLS_ACTIVE", "LISTING_AGREEMENT_SIGNED", "COMING_SOON_PREP", "COMING_SOON_ACTIVE"].every((s) => !!listingStageOverrideRefusal(s)))
  check("POSITIVE CONTROL: an ungated stage is allowed (UNDER_CONTRACT on a listing → pending; LISTING_EXPIRED)", listingStageOverrideRefusal("UNDER_CONTRACT") === null && listingStageOverrideRefusal("LISTING_EXPIRED") === null)

  // ── C ────────────────────────────────────────────────────────────────────────────────────────
  section("C · the transaction gate's blockers — every literal classified (unknown = hard)")
  const literalsIn = (src: string): string[] => {
    const out: string[] = []
    for (const m of src.matchAll(/blockers(?:\.push\(|:\s*\[)\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*")/g)) out.push(m[1].slice(1, -1))
    return out
  }
  const gateSrc = code("lib/transactions/stage-progression.ts")
  const complianceSrc = fnBody(code("app/actions/transaction-compliance.ts"), "canProceedToClosingPrep")
  const lits = [...literalsIn(fnBody(gateSrc, "canAdvanceStage")), ...literalsIn(complianceSrc)]
  const fill = (t: string, milestone: string) => t.replace(/\$\{criticalName\}/g, milestone).replace(/\$\{[^}]*\}/g, "x")
  const soft = new Set<string>(), hard = new Set<string>()
  for (const t of lits) {
    for (const ms of ["inspection_deadline", "cda_delivered"]) (classifyTransactionStageBlocker(fill(t, ms)) === "soft" ? soft : hard).add(fill(t, ms))
  }
  check(`the gate's literals were found (${lits.length} — canAdvanceStage + canProceedToClosingPrep)`, lits.length >= 12, String(lits.length))
  check("SOFT is exactly: contract date not keyed, a contingency-deadline milestone, the ladder's order", [...soft].every((s) => /^contract_date must be set|^Critical milestone "inspection_deadline"|^Cannot transition from/.test(s)) && soft.size === 4, [...soft].join(" | "))
  check("HARD includes compliance, deal-breaker flags, TRID, the CDA milestone and a gate that could not run", ["compliance_passed_at must be set", "Deal-breaker compliance flag: x (x)", "Compliance failed: x", "Compliance pending: x", "Compliance needs review: x", 'Critical milestone "cda_delivered" must be completed', "Critical milestones could not be read (x)", "Failed to verify compliance status"].every((b) => classifyTransactionStageBlocker(b) === "hard"))
  check("TRID literals are hard", [...hard].some((b) => b.startsWith("TRID:")) && classifyTransactionStageBlocker("TRID: x") === "hard")
  check("the ROLE gate's refusal is hard (tenant authority is never overridden)", classifyTransactionStageBlocker("You cannot move this transaction") === "hard")
  check("POSITIVE CONTROL: an invented blocker the classifier has never seen is HARD (fail closed)", classifyTransactionStageBlocker("Inspection waived by agent") === "hard")
  {
    const p = partitionStageBlockers(["contract_date must be set before advancing to post-contract stages", "Compliance pending: Final walkthrough"])
    check("partitionStageBlockers splits a mixed list", p.soft.length === 1 && p.hard.length === 1)
  }

  // ── D ────────────────────────────────────────────────────────────────────────────────────────
  section("D · overrideStatus — decide, then the write inside the ledger")
  type Claim = { kind: "refused"; error: string } | { kind: "replay"; entry: Record<string, unknown> }
  const ledgerStub = (mode: "ok" | "refused" = "ok") => {
    const rows: Array<Record<string, any>> = [], keys = new Set<string>()
    const fn = async (ctx: any, run: () => Promise<any>, hooks: { settle: (r: any) => any; replay: (c: Claim) => any }) => {
      if (mode === "refused") return hooks.replay({ kind: "refused", error: "42501 forced" })
      if (keys.has(ctx.idempotencyKey)) return hooks.replay({ kind: "replay", entry: {} })
      keys.add(ctx.idempotencyKey)
      const r = await run(); rows.push({ ...ctx, settled: hooks.settle(r) }); return r
    }
    return { fn: fn as never, rows }
  }
  const ACTION_NAME = (() => { const m = /const ACTION_NAME_PATTERN = (\/.+\/)\n/.exec(code("lib/kernel/action-ledger.ts")); return m ? new RegExp(m[1].slice(1, -1)) : /$^/ })()
  {
    let applied = 0
    const L = ledgerStub()
    const run = { brokerageId: "b-1", subject: { type: "open_house_event", id: "e-1" }, systemSource: "proof", action: "open_house.event.cancel", rowVersion: "v1", apply: async () => { applied++; return { ok: true as const } } }
    const refused = await overrideStatus({ entity: "open_house_event", from: "scheduled", to: "cancelled", reason: "short", actor }, run, { ledger: L.fn })
    check("a refused decision writes NOTHING (no apply, no ledger row)", !refused.ok && applied === 0 && L.rows.length === 0)
    const okr = await overrideStatus({ entity: "open_house_event", from: "scheduled", to: "cancelled", reason: "The seller is ill — rescheduling next weekend", actor }, run, { ledger: L.fn })
    const row = L.rows[0]
    check("an allowed change applies ONCE inside the ledger", okr.ok && applied === 1 && L.rows.length === 1)
    check("the ledger row carries who, why and from → to (C23 evidence)", row?.detail?.status_override?.reason?.startsWith("The seller") && row?.detail?.status_override?.from === "scheduled" && row?.detail?.status_override?.to === "cancelled" && row?.actor?.userId === "u-1" && row?.reasonCode === "HUMAN_REQUESTED")
    check("the action name is domain.entity.action (ACTION_NAME_PATTERN read from the ledger's source)", ACTION_NAME.test(String(row?.action)) && !ACTION_NAME.test("status.override"))
    const again = await overrideStatus({ entity: "open_house_event", from: "scheduled", to: "cancelled", reason: "The seller is ill — rescheduling next weekend", actor }, run, { ledger: L.fn })
    check("the same click twice REPLAYS — the write is not re-applied", !again.ok && again.code === "replayed" && applied === 1)
    const R = ledgerStub("refused")
    const blocked = await overrideStatus({ entity: "open_house_event", from: "scheduled", to: "cancelled", reason: "The seller is ill — rescheduling next weekend", actor }, { ...run, rowVersion: "v2" }, { ledger: R.fn })
    check("a REFUSED ledger claim writes nothing (fail closed)", !blocked.ok && blocked.code === "ledger_refused" && applied === 1)
  }

  // ── E ────────────────────────────────────────────────────────────────────────────────────────
  section("E · every manual door asks the ONE decision before it writes (stripped source)")
  // A door must ASK the decision before it writes AND HONOUR it: the variable decideStatusOverride is assigned to is read as
  // `!<name>.ok` inside an `if (...) return` that sits between the decision and the write. (overrideStatus refuses before
  // its run callback by construction — §D proves that — so a door routed through it needs only the order.)
  const decidesBeforeWrite = (body: string, write: RegExp): boolean => {
    const at = body.search(/decideStatusOverride\(|overrideStatus\(/)
    const w = body.search(write)
    if (at < 0 || w <= at) return false
    if (body.slice(at, at + 16).startsWith("overrideStatus(")) return true
    // `const d = decideStatusOverride(` or `const d = cond ? decideStatusOverride(` (the ternary may break onto a `?` line).
    // The repo writes no semicolons, so the match is held to one line plus a `?` continuation — never the first `const`.
    const assigned = /const\s+(\w+)\s*=\s*(?:[^\n]*?(?:\n\s*)?\?\s*)?decideStatusOverride\(/.exec(body)
    if (!assigned) return false
    const honour = new RegExp(`if\\s*\\([^)]*!\\s*${assigned[1]}\\.ok\\s*\\)\\s*return\\b`)
    const h = body.slice(at, w).search(honour)
    return h >= 0
  }
  check("POSITIVE CONTROL: a door that writes before deciding is caught", !decidesBeforeWrite(`async function x() { await s.from("listings").update({ status }); decideStatusOverride({}) }`, /\.update\(/))
  check("POSITIVE CONTROL: a door that computes the decision but never honours its refusal is caught (mutation M6's shape)",
    !decidesBeforeWrite(`async function x() { const d = decideStatusOverride({}); await s.from("t").update(update) }`, /\.update\(update\)/) &&
    decidesBeforeWrite(`async function x() { const d = cond ? decideStatusOverride({}) : null; if (d && !d.ok) return { ok: false }; await s.from("t").update(update) }`, /\.update\(update\)/))
  const listingsKernel = tokens("app/actions/listings-kernel.ts")
  check("updateListingStatus decides — and returns on a refusal — before it writes listings.status", decidesBeforeWrite(fnBody(listingsKernel, "updateListingStatus"), /\.update\(/))
  check("…and carries the decision's evidence on its OWN ledger row (statusOverrideDetail)", /statusOverrideDetail\(decision/.test(fnBody(listingsKernel, "updateListingStatus")))
  const support = tokens("app/actions/support.ts")
  const ticketBody = fnBody(support, "updateTicketStatus")
  check("updateTicketStatus decides — and returns on a refusal — before it writes (the scope still resolves before the service client)", decidesBeforeWrite(ticketBody, /\.update\(update\)/) && ticketBody.indexOf("resolveQueueScope(") < ticketBody.indexOf("createServiceClient("))
  check("the platform console's setTicketStatusAction decides — and returns on a refusal — before it writes", decidesBeforeWrite(fnBody(tokens("app/actions/superadmin/support-console.ts"), "setTicketStatusAction"), /\.update\(patch\)/))
  check("cancelOpenHouse routes its write through overrideStatus (reason, ledger)", /overrideStatus\(/.test(fnBody(tokens("app/actions/open-house.ts"), "cancelOpenHouse")))
  const stage = fnBody(tokens("app/actions/transaction-stage-machine.ts"), "advanceTransactionStage")
  const ov = stage.slice(0, stage.indexOf("Standard path") > 0 ? stage.indexOf("Standard path") : stage.length)
  check("the transaction stage override runs the transaction's OWN gate and partitions its blockers BEFORE the write", ov.search(/\.checkAdvancement\(/) >= 0 && ov.search(/partitionStageBlockers\(/) > ov.search(/\.checkAdvancement\(/) && ov.search(/overrideStatus\(/) > ov.search(/partitionStageBlockers\(/) && ov.search(/hardBlockers:\s*hard/) > 0)
  check("…refuses a gated stage target first (GATED_TRANSACTION_STAGES)", ov.search(/GATED_TRANSACTION_STAGES\[/) >= 0 && ov.search(/GATED_TRANSACTION_STAGES\[/) < ov.search(/overrideStatus\(/))
  const listingLc = fnBody(tokens("app/actions/listing-lifecycle.ts"), "advanceListingStage")
  check("the listing STAGE override refuses a gated stage before it writes, and decides through overrideStatus", listingLc.search(/listingStageOverrideRefusal\(/) >= 0 && listingLc.search(/listingStageOverrideRefusal\(/) < listingLc.search(/overrideStatus\(/))
  const updTx = fnBody(tokens("app/actions/transactions.ts"), "updateTransaction")
  check("the public updateTransaction door refuses `status` and `close_date` before delegating", /updates\.status\s*!==\s*undefined\)\s*return/.test(updTx) && /updates\.close_date\s*!==\s*undefined\)\s*return/.test(updTx) && updTx.search(/updates\.status/) < updTx.search(/TransactionService\.updateTransaction\(/))
  check("requireOverrideActor reads the ONE reason floor (no second literal)", /reason\.trim\(\)\.length\s*<\s*OVERRIDE_REASON_MIN_CHARS/.test(code("lib/kernel/portal-auth.ts")) && !/reason\.trim\(\)\.length\s*<\s*10\b/.test(code("lib/kernel/portal-auth.ts")))

  // ── F ────────────────────────────────────────────────────────────────────────────────────────
  section("F · VOCABULARY ⊆ UI — every value the CHECK admits renders in the authorized UI")
  type Surface = { entity: StatusEntity | "connector_healing"; file: string; method: string; renders: (src: string, values: readonly string[]) => string[] }
  /** Values rendered by mapping over a named canonical constant (all of them) — else none. */
  const viaMap = (constName: string) => (src: string, values: readonly string[]) => (new RegExp(`\\b${constName}\\.map\\(`).test(src) && !new RegExp(`\\b${constName}\\.filter\\(`).test(src) ? [...values] : [])
  const viaBadge = (entity: string) => (src: string, values: readonly string[]) => (new RegExp(`<StatusBadge\\s+entity="${entity}"`).test(src) || new RegExp(`statusLabel\\(\\s*"${entity}"`).test(src) ? [...values] : [])
  /** Rendered through the registry's statusOptionsFor(entity) — every value by construction (section F's behavioural check). */
  const viaOptions = (entity: string) => (src: string, values: readonly string[]) => (new RegExp(`statusOptionsFor\\(\\s*"${entity}"[^)]*\\)\\.map\\(`).test(src) ? [...values] : [])
  /** Literal fallback: each value compared as a quoted literal in the file (strings kept). */
  const viaLiterals = (src: string, values: readonly string[]) => values.filter((v) => new RegExp(`status\\s*===\\s*['"]${v}['"]`).test(src))
  const SURFACES: Surface[] = [
    { entity: "listing", file: "app/components/dashboard/listings/listing-status-select.tsx", method: "picker: LISTING_STATUSES.map (gated values disabled, never filtered)", renders: viaMap("LISTING_STATUSES") },
    { entity: "support_ticket", file: "app/dashboard/admin/support-tickets/support-queue-client.tsx", method: "picker: TICKET_STATUSES.map + statusLabel", renders: viaMap("TICKET_STATUSES") },
    { entity: "support_ticket", file: "app/dashboard/superadmin/support/[id]/reply-box.tsx", method: "buttons: statusOptionsFor(\"support_ticket\") (every value; gated shown disabled)", renders: viaOptions("support_ticket") },
    { entity: "open_house_event", file: "app/dashboard/open-houses/open-houses-client.tsx", method: "badges: OPEN_HOUSE_EVENT_STATUSES.map (typed style per value)", renders: viaMap("OPEN_HOUSE_EVENT_STATUSES") },
    { entity: "transaction", file: "app/components/coordinator/transaction-list.tsx", method: "StatusBadge entity=transaction (registry labels)", renders: viaBadge("transaction") },
    { entity: "offer_esign", file: "app/components/shared/SignatureStatusBadge.tsx", method: "statusLabel(\"offer_esign\") — the stored state's own words", renders: viaBadge("offer_esign") },
    { entity: "commission_payment", file: "app/dashboard/financials/commissions/page.tsx", method: "badge + summary tiles: each value compared literally", renders: viaLiterals },
  ]
  const census: string[] = []
  for (const s of SURFACES) {
    const values = (STATUS_ENTITIES[s.entity as StatusEntity] as StatusEntityPolicy).values
    // Comments stripped, strings KEPT: the JSX attribute (entity="transaction") and the compared literals are the evidence.
    const src = code(s.file)
    const shown = s.renders(src, values)
    const missing = values.filter((v) => !shown.includes(v))
    census.push(`| ${s.entity} | ${values.length} | ${s.file} | ${s.method} | ${shown.length}/${values.length}${missing.length ? ` (missing: ${missing.join(", ")})` : ""} |`)
    check(`${s.entity} — ${s.file}: renders every value (${shown.length}/${values.length})`, missing.length === 0, missing.join(", "))
  }
  {
    const vals = ["pending", "applied", "rejected", "reverted"]
    const src = code("app/dashboard/superadmin/connector-healing/page.tsx")
    const ok2 = /HEALING_PROPOSAL_STATUSES\.map\(/.test(src) && /Record<HealingProposalStatus,/.test(src)
    census.push(`| connector_healing_proposals.status | 4 (m928) | app/dashboard/superadmin/connector-healing/page.tsx | HEALING_PROPOSAL_STATUSES.map (typed badge per value) | ${ok2 ? 4 : 0}/4 |`)
    check("connector healing history renders every proposal status incl. C25's `reverted` (typed over HEALING_PROPOSAL_STATUSES)", ok2 && vals.length === 4)
  }
  check("POSITIVE CONTROL: a picker that hard-codes a subset is caught", viaMap("TICKET_STATUSES")(`{["open","closed"].map((s) => <SelectItem value={s} />)}`, ["open", "in_progress", "resolved", "closed"]).length === 0)
  check("POSITIVE CONTROL: a picker that filters the vocabulary before rendering is caught", viaMap("LISTING_STATUSES")("LISTING_STATUSES.filter((s) => s !== 'active').map((s) => s)", ["a"]).length === 0)
  check("POSITIVE CONTROL: the literal finder misses a value the page never compares", viaLiterals(`c.status === 'paid' || c.status === 'pending'`, ["pending", "approved", "paid", "disputed"]).length === 2)
  check("the event list no longer keys a status the CHECK does not admit (`invitations_sent`)", !/["']invitations_sent["']/.test(code("app/dashboard/open-houses/open-houses-client.tsx")))
  check("the commission summary no longer counts a status the CHECK does not admit (`held`)", !/status\s*===\s*['"]held['"]/.test(code("app/dashboard/financials/commissions/page.tsx")))
  for (const key of STATUS_ENTITY_KEYS) {
    const opts = statusOptionsFor(key)
    const e = STATUS_ENTITIES[key] as StatusEntityPolicy
    check(`statusOptionsFor(${key}) offers EVERY value; a gated one is shown disabled with why`, opts.length === e.values.length && opts.every((o) => (e.policy as Record<string, StatusValuePolicy>)[o.value].door === "manual" ? o.selectable : !o.selectable && !!o.why))
  }
  check("statusLabel never hides an unknown value (shows it as itself)", statusLabel("listing", "mystery_state") === "mystery state")
  console.log("\n  ## Vocabulary ⊆ UI census\n  | entity | values (live CHECK) | authorized UI | how it renders | rendered |\n  |---|---|---|---|---|")
  for (const row of census) console.log(`  ${row}`)

  // ── G ────────────────────────────────────────────────────────────────────────────────────────
  section("G · the closing-date model")
  const base = { status: "under_contract", close_date: "2026-12-15", estimated_close_date: "2026-12-15", contract_closing_date: "2026-12-15", contract_closing_source: "executed_contract", property_state: "GA", financing_type: "conventional" }
  const r1 = resolveClosingDates({ ...base, contract_closing_terms: "on_or_before" })
  check("three facts: contractual (with wording + source), anticipated, actual (none yet)", r1.contractual?.date === "2026-12-15" && r1.contractual.terms === "on_or_before" && r1.contractual.source === "executed_contract" && r1.anticipated?.date === "2026-12-15" && r1.actual === null)
  check("the wording reads 'On or before 2026-12-15'", r1.wording === "On or before 2026-12-15")
  const r2 = resolveClosingDates({ status: "under_contract", close_date: "2026-12-15" })
  check("a pre-m927 deal: the contractual date is read from the legacy close_date, said so; wording unknown, said so", r2.contractual?.source === "legacy_close_date" && r2.contractual.terms === null && r2.notes.length === 2)
  const r3 = resolveClosingDates({ status: "closed", close_date: "2026-12-10", contract_closing_date: "2026-12-15", actual_close_date: "2026-12-10" })
  check("a closed deal: actual day from actual_close_date; the contract's deadline survives the close", r3.actual?.date === "2026-12-10" && r3.actual.source === "actual_close_date" && r3.contractual?.date === "2026-12-15" && r3.anticipated === null)
  // The assessment through the PRODUCT door that computes it (applyClosingDateChange, kind anticipated) — in memory.
  const assess = async (facts: Record<string, unknown>, date: string) => {
    const TX = "73737373-0000-4000-8000-000000000001", BK = "11111111-1111-4111-8111-111111111111"
    const db = memSupabase({ transactions: [{ id: TX, brokerage_id: BK, contract_closing_amendment_ref: null, actual_close_date: null, updated_at: "v1", ...facts }] })
    const r = await applyClosingDateChange(db as never, { brokerageId: BK, transactionId: TX, actorUserId: "u-1", kind: "anticipated", date, reason: "Proposed by the buyer's lender" }, { ledger: ledgerStub().fn })
    if (!r.ok || !r.assessment) throw new Error(`assessment not produced: ${JSON.stringify(r)}`)
    return r.assessment
  }
  const eOnOrBefore = await assess({ ...base, contract_closing_terms: "on_or_before" }, "2026-12-08")
  const eOn = await assess({ ...base, contract_closing_terms: "on" }, "2026-12-08")
  const eUnread = await assess({ ...base, contract_closing_terms: null }, "2026-12-08")
  check("'on or before' + an earlier day → within the contract, NO amendment (coordination still listed)", eOnOrBefore.withinContract === true && !eOnOrBefore.requiresExecutedAmendment && eOnOrBefore.coordinate.length >= 2)
  check("'on' (a fixed day) + an earlier day → needs an EXECUTED amendment", eOn.withinContract === false && eOn.requiresExecutedAmendment === true)
  // RE-ASSERTED (wave 149, lane 149G — owner ruling 17: "early closing needs no executed amendment unless state law requires
  // it"): an unread wording is UNKNOWN — read it off the contract — never a default "needs an amendment" (the wave-148 rule).
  check("wording not read + an earlier day → 'unknown' — neither a default amendment nor 'fine' (owner ruling 17)", eUnread.withinContract === "unknown" && eUnread.requiresExecutedAmendment === "unknown" && eUnread.amendmentBasis === "wording_unread")
  const late = await assess({ ...base, contract_closing_terms: "on_or_before" }, "2026-12-20")
  const lateOn = await assess({ ...base, contract_closing_terms: "on" }, "2026-12-20")
  check("a LATER day needs an executed extension under either wording", late.direction === "later" && late.requiresExecutedAmendment === true && lateOn.requiresExecutedAmendment === true)
  check("a proposed day is NEVER an executed amendment (the explanation says so)", /not an executed amendment/.test(eOnOrBefore.explanation))
  check("a financed deal names the lender + the TRID 3-business-day Closing Disclosure", eOnOrBefore.coordinate.some((c) => /lender/.test(c) && /3 business days/.test(c)))
  const cash = await assess({ ...base, financing_type: "cash", contract_closing_terms: "on_or_before" }, "2026-12-08")
  check("POSITIVE CONTROL: a cash deal does not list the lender", !cash.coordinate.some((c) => /lender/.test(c)))
  // RE-ASSERTED (wave 149, lane 149G — one state survivor): the note derives from lib/state-forms/closing-participants.ts —
  // a SOURCED policy names its source; a published convention is labelled "not law"; no state → ask.
  check("state note: GA → the closing attorney (sourced policy, with its source); CA → title / escrow (a convention); unknown → ask", closingStateNote("GA").conductedBy === "attorney_required" && closingStateNote("GA").basis === "sourced_policy" && !!closingStateNote("GA").source && closingStateNote("CA").conductedBy === "title_or_escrow_typically" && closingStateNote("CA").basis === "published_convention" && closingStateNote(null).conductedBy === "unknown")
  check("every sourced state's note carries its source; a convention's note says 'not law' (a reminder of whom to ask, never a legal determination)", Object.keys(STATE_CLOSING_POLICIES).every((s) => closingStateNote(s).basis === "sourced_policy" && !!closingStateNote(s).source?.url) && /not law/.test(closingStateNote("CA").note) && !/ATTORNEY_CLOSING_REPORTED\s*[:=]/.test(code("lib/transactions/closing-dates.ts")))
  {
    const T = "71717171-0000-4000-8000-000000000001", B = "11111111-1111-4111-8111-111111111111"
    const seed = () => memSupabase({ transactions: [{ id: T, brokerage_id: B, ...base, contract_closing_terms: "on", contract_closing_amendment_ref: null, actual_close_date: null, updated_at: "v1" }] })
    const L = ledgerStub()
    const svc1 = seed()
    const noProof = await applyClosingDateChange(svc1 as never, { brokerageId: B, transactionId: T, actorUserId: "u-1", kind: "executed_amendment", date: "2026-12-08", reason: "All parties agreed to close early" }, { ledger: L.fn })
    check("an executed amendment WITHOUT its document reference is refused (a proposal is the anticipated date)", !noProof.ok && /EXECUTED amendment/.test((noProof as { error: string }).error) && svc1.tables.transactions[0].contract_closing_date === "2026-12-15")
    const prop = await applyClosingDateChange(svc1 as never, { brokerageId: B, transactionId: T, actorUserId: "u-1", kind: "anticipated", date: "2026-12-08", reason: "Buyer asked to close a week early" }, { ledger: L.fn })
    const t1 = svc1.tables.transactions[0]
    check("a PROPOSED earlier day moves the anticipated date ONLY — the contract's deadline is untouched", prop.ok && t1.estimated_close_date === "2026-12-08" && t1.contract_closing_date === "2026-12-15" && t1.close_date === "2026-12-15")
    check("…and the assessment says the fixed 'on' day needs an executed amendment", prop.ok && prop.assessment?.requiresExecutedAmendment === true)
    check("…ledgered as transaction.closing_date.record with the before-state", L.rows.some((r) => r.action === "transaction.closing_date.record" && r.detail?.before?.contract === "2026-12-15"))
    const svc2 = seed()
    const amended = await applyClosingDateChange(svc2 as never, { brokerageId: B, transactionId: T, actorUserId: "u-1", kind: "executed_amendment", date: "2026-12-08", terms: "on_or_before", reason: "Amendment 2 signed by all parties", evidenceRef: "doc:amendment-2" }, { ledger: ledgerStub().fn })
    const t2 = svc2.tables.transactions[0]
    check("an EXECUTED amendment (with its reference) changes the contractual deadline, its source and wording", amended.ok && t2.contract_closing_date === "2026-12-08" && t2.contract_closing_source === "executed_amendment" && t2.contract_closing_amendment_ref === "doc:amendment-2" && t2.contract_closing_terms === "on_or_before")
    const short = await applyClosingDateChange(seed() as never, { brokerageId: B, transactionId: T, actorUserId: "u-1", kind: "anticipated", date: "2026-12-08", reason: "early" }, { ledger: ledgerStub().fn })
    check("a closing-date change without a reason is refused", !short.ok)
    const wrongTenant = await applyClosingDateChange(seed() as never, { brokerageId: "22222222-2222-4222-8222-222222222222", transactionId: T, actorUserId: "u-1", kind: "anticipated", date: "2026-12-08", reason: "Buyer asked to close a week early" }, { ledger: ledgerStub().fn })
    check("another tenant's deal is not found (tenant-pinned read)", !wrongTenant.ok && /not found/i.test((wrongTenant as { error: string }).error))
  }
  check("the vocabulary is on / on_or_before", CLOSING_DATE_TERMS.join(",") === "on,on_or_before")
  {
    const m927 = raw("supabase/migrations/m927-transaction-closing-date-terms.sql")
    const line1 = m927.split("\n")[0] ?? ""
    check("m927 carries the integrator's line-1 APPLIED LIVE stamp (the closing-date model needs the five columns live — the rule, not a waypoint)", /^-- ── APPLIED LIVE /.test(line1))
    check("m927 adds the five columns and both CHECKs (+ the amendment-reference rule)", ["contract_closing_date", "contract_closing_terms", "contract_closing_source", "contract_closing_amendment_ref", "actual_close_date"].every((c) => m927.includes(`ADD COLUMN IF NOT EXISTS ${c}`)) && /'on'::text, 'on_or_before'::text/.test(m927) && /'executed_contract'::text, 'executed_amendment'::text/.test(m927) && /contract_closing_amendment_ref_required/.test(m927))
    const live = CHECK_VOCABULARIES.transactions?.contract_closing_terms
    check("once applied, the cache's CHECK equals the code vocabulary (absent until regenerated — said)", !live || sameSet(live, CLOSING_DATE_TERMS), live ? live.join(",") : "not in the cache yet (regenerate check-vocabularies after the m927 stamp)")
  }
  check("the writers: the offer bridge seeds the deadline; the gated close, the close command and the override stamp the actual day", /seedContractClosing\(/.test(tokens("lib/transactions/offer-bridge.ts")) && /recordActualClosing\(/.test(tokens("lib/transactions/stage-progression.ts")) && /recordActualClosing\(/.test(fnBody(tokens("lib/kernel/transactions.ts"), "closeTransactionCommand")) && /recordActualClosing\(/.test(tokens("app/actions/transaction-stage-machine.ts")))
  check("the deal page renders the closing-date panel, and its door is session-gated (requireTransactionActor)", /<ClosingDatesPanel\b/.test(code("app/dashboard/transactions/[id]/transaction-detail-client.tsx")) && /requireTransactionActor\(params\.transactionId\)/.test(fnBody(code("app/actions/transactions.ts"), "recordClosingDateChange")))
  {
    // A RUNTIME import (static or dynamic) of the ledger / a supabase client — a type-only `typeof import(…)` is erased.
    // a `typeof import()` and an `import type … from` are erased at compile time — neither is a runtime reach (the client-server guard
    // reads the former as an edge, so the module writes the latter).
    const SERVER_IMPORT = /(?:(?<!typeof\s)import\(\s*|(?<!import\s+type\s[^\n]*)from\s+)["']@\/lib\/(?:kernel\/action-ledger|supabase\/)/
    check("POSITIVE CONTROL: the finder sees a dynamic and a static server import, and ignores a type-only one", SERVER_IMPORT.test(`await import("@/lib/kernel/action-ledger")`) && SERVER_IMPORT.test(`import { x } from "@/lib/supabase/service"`) && !SERVER_IMPORT.test(`type L = typeof import("@/lib/kernel/action-ledger").withActionLedger`))
    check("status-override + closing-dates reach for NO server module at runtime (client pickers import them)", !SERVER_IMPORT.test(code("lib/kernel/status-override.ts")) && !SERVER_IMPORT.test(code("lib/transactions/closing-dates.ts")) && existsSync(join(ROOT, "lib/kernel/status-override.ts")))
  }

  console.log("\n BLIND SPOTS: the UI census reads stripped source (a constant mapped in a file is taken as rendered; runtime branches that hide an option are not executed); the commission page is judged by literal comparisons; the ledger is a stub modelling replay / refusal (the real ledger's own proof is test:action-ledger); the doors' session gates are proven by their own proofs (test:tenant-scope, test:support-isolation); the state attorney list is secondary-source, not statute; m927 / m928 are unapplied (their CHECKs read from the migration files).")
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(`\n ❌ STATUS_OVERRIDE_FAIL — ${failures.join(" | ")}`); process.exit(1) }
  console.log("\n ✅ STATUS_OVERRIDE_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
