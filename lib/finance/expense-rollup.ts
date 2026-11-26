// lib/finance/expense-rollup.ts
// ─────────────────────────────────────────────────────────────────────────────
// MULTI-LOCATION EXPENSES — EACH OFFICE KEEPS ITS OWN, ALL ROLL UP TO THE MAIN TENANT ONCE (wave 153, lane 153A).
//
// Owner ruling (2026-11-14, verbatim): "expesnses for multiple location brokerage tenants. each location takes care of
// expenses but all can roll up to the main tenant."
//
// NOT A SECOND WRITER OR A SECOND SCOPE MODEL. The ONE expense writer stays app/actions/financials.ts logScopedExpense;
// it asks authorizeBooksWrite (below) whether the session actor may put a row on THAT office's books and stamps
// business_expenses.location_id (m900). The office scope is the EXISTING tenant hierarchy —
// lib/kernel/resolve-user-office.ts resolveViewerHierarchy (wave 150 C34: tenant leadership grant = all offices;
// office leadership grant / locations.managing_broker_user_id / an admin pinned to an office = that office; on a
// SINGLE-office tenant the CLAUDE.md §4 roster) — crossed with the EXISTING money rosters
// (BROKERAGE_FINANCE_ADMIN_USER_TYPES keeps the books; compliance_officer READS them, m467). No new role, seat or
// accounting entity per office.
//
// THE ROLLUP INVARIANT (asserted on every build, not hoped for): each source row is counted ONCE.
//   tenant total = Σ office totals (owned + allocated-in) + main-office unallocated + main-office retained share
// A shared cost is one row on the main office's books plus allocation FACTS (business_expense_allocations, m900) whose
// basis points total exactly 10,000 and whose amounts total the source to the cent; the row is never copied. A refund /
// credit / void is a NEGATIVE row on the same books (logScopedExpense reversalOfExpenseId) and nets automatically — a
// reversal of an allocated cost is split by the SAME shares as its original. Recognition date = expense_date.
//
// Agent AND team books never roll up — owner rule in logScopedExpense ("no cross-book rollup") and the owner correction
// the P&L fold already enforces (lib/finance/brokerage-earnings-writer.ts: agent_id NULL AND team_id NULL — "team
// financials do NOT roll up to brokerage"). This reads the company's books only. A team row is stamped with its team's
// office (a fact about where the team works) but stays on the team's own book.

import type { SupabaseClient } from "@supabase/supabase-js"
import { randomUUID } from "node:crypto"
import { BROKERAGE_FINANCE_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { reversalMarker } from "@/lib/documents/receipt-rules"

type Svc = SupabaseClient<any, any, any>

const BPS_TOTAL = 10_000
const toCents = (n: number | string | null | undefined): number => Math.round((Number(n) || 0) * 100)
const fromCents = (c: number): number => Math.round(c) / 100

// ─── 1. EXACT ALLOCATION (pure) ───────────────────────────────────────────────

interface AllocationShare {
  /** NULL = the share the main office keeps centrally. */
  locationId: string | null
  /** Basis points: 10,000 = 100%. */
  shareBps: number
}

/**
 * PURE: split one amount by basis-point shares EXACTLY — the parts always sum to the source to the cent (largest
 * remainder on the magnitude; ties go to the earlier share). Refuses shares that do not total 100%, a duplicate target,
 * a non-integer or out-of-range share, or a zero/invalid amount. A negative amount (a reversal) splits with its sign.
 */
function allocateByShares(
  amount: number | string,
  shares: AllocationShare[],
): { ok: true; lines: Array<{ locationId: string | null; shareBps: number; amount: number }> } | { ok: false; code: "no_shares" | "share_invalid" | "duplicate_target" | "shares_not_100_percent" | "amount_invalid" } {
  if (!Array.isArray(shares) || shares.length === 0) return { ok: false, code: "no_shares" }
  const seen = new Set<string>()
  let total = 0
  for (const s of shares) {
    if (!Number.isInteger(s.shareBps) || s.shareBps <= 0 || s.shareBps > BPS_TOTAL) return { ok: false, code: "share_invalid" }
    const key = s.locationId ?? "__main_office__"
    if (seen.has(key)) return { ok: false, code: "duplicate_target" }
    seen.add(key)
    total += s.shareBps
  }
  if (total !== BPS_TOTAL) return { ok: false, code: "shares_not_100_percent" }
  const cents = toCents(amount)
  if (!Number.isFinite(Number(amount)) || cents === 0) return { ok: false, code: "amount_invalid" }
  const sign = cents < 0 ? -1 : 1
  const mag = Math.abs(cents)
  const base = shares.map((s) => Math.floor((mag * s.shareBps) / BPS_TOTAL))
  const rem = shares.map((s, i) => (mag * s.shareBps) / BPS_TOTAL - base[i])
  let left = mag - base.reduce((a, b) => a + b, 0)
  const order = shares.map((_, i) => i).sort((a, b) => (rem[b] - rem[a]) || (a - b))
  for (const i of order) { if (left <= 0) break; base[i] += 1; left -= 1 }
  return { ok: true, lines: shares.map((s, i) => ({ locationId: s.locationId, shareBps: s.shareBps, amount: fromCents(sign * base[i]) })) }
}

// ─── 2. WHO KEEPS / READS WHICH BOOKS (pure decision + one session-side reader) ─

interface BooksAuthorityFacts {
  userType: string | null
  /** plan_tier 'multi_location' or ≥ 2 active offices — the same test resolveViewerHierarchy / egress-scope use. */
  multiLocation: boolean
  activeOfficeIds: string[]
  hierarchy: { aggregate: boolean; kind: "tenant" | "offices" | "teams" | "own"; locationIds: string[] }
  /** locations.managing_broker_user_id = viewer (the office-head FACT, m661). */
  managedOfficeIds: string[]
}

interface BooksAuthority {
  multiLocation: boolean
  /** Sees the consolidated tenant rollup (every office + the main office + the tenant total). */
  consolidated: boolean
  /** Offices whose books this viewer may read (consolidated ⇒ all). */
  readOffices: string[]
  /** Offices whose books this viewer may write. */
  writeOffices: string[]
  /** May write the main office's (centrally-owned) books and allocate shared costs. */
  writeCentral: boolean
  basis: string[]
}

/**
 * PURE: the books authority. Keeping the books = the finance roster (m472 holds team_lead out; m467 lets the
 * compliance officer READ, never keep). On a SINGLE-office tenant the roster alone decides, exactly as before this
 * wave. On a MULTI-LOCATION tenant user_type never widens across offices (C34): the consolidated view and the main
 * office's books need the tenant hierarchy's aggregate scope; an office admin keeps only the offices the hierarchy gives
 * them; a managing broker may READ their own office's books. Everyone else: none.
 */
function decideBooksAuthority(f: BooksAuthorityFacts): BooksAuthority {
  const type = String(f.userType ?? "").toLowerCase()
  const keeps = BROKERAGE_FINANCE_ADMIN_USER_TYPES.has(type)
  // m467: public.can_read_brokerage_books() admits the compliance officer — reads the books, never keeps them.
  const reads = keeps || type === "compliance_officer"
  const all = [...f.activeOfficeIds]
  if (!f.multiLocation) {
    return {
      multiLocation: false, consolidated: reads, readOffices: reads ? all : [], writeOffices: keeps ? all : [], writeCentral: keeps,
      basis: [keeps ? "keeps the books (finance roster)" : reads ? "reads the books (compliance officer, m467)" : "does not keep or read the tenant's books"],
    }
  }
  if (f.hierarchy.aggregate) {
    return {
      multiLocation: true, consolidated: reads, readOffices: reads ? all : [], writeOffices: keeps ? all : [], writeCentral: keeps,
      basis: [reads ? `all offices — tenant leadership${keeps ? ", keeps the books" : ", reads the books"}` : "tenant leadership, but not on a books roster"],
    }
  }
  const admitted = f.hierarchy.kind === "offices" ? f.hierarchy.locationIds.filter((id) => all.includes(id)) : []
  const managed = f.managedOfficeIds.filter((id) => all.includes(id))
  const readOffices = [...new Set([...(reads ? admitted : []), ...managed])]
  const writeOffices = keeps ? admitted : []
  return {
    multiLocation: true, consolidated: false, readOffices, writeOffices, writeCentral: false,
    basis: readOffices.length ? [`office books: ${readOffices.length} office(s)${writeOffices.length ? `, keeps ${writeOffices.length}` : ", read only"}`] : ["no office books in this viewer's scope"],
  }
}

interface BooksViewer { userId: string; brokerageId: string; userType: string | null }

/**
 * THE session-side reader of the books authority. `viewer` carries ids the caller resolved from the SESSION (never a
 * body). Every read's error is READ; any refusal REFUSES (fail closed) — "nobody checked" never renders as "may write".
 */
export async function resolveBooksAuthority(svc: Svc, viewer: BooksViewer): Promise<({ ok: true } & BooksAuthority) | { ok: false; error: string }> {
  const [{ resolveViewerHierarchy }, offRes, tenantRes] = await Promise.all([
    import("@/lib/kernel/resolve-user-office"),
    svc.from("locations").select("id, status, managing_broker_user_id").eq("brokerage_id", viewer.brokerageId),
    svc.from("brokerages").select("plan_tier").eq("id", viewer.brokerageId).maybeSingle(),
  ])
  if (offRes.error) return { ok: false, error: `offices read refused (${offRes.error.message})` }
  if (tenantRes.error || !tenantRes.data) return { ok: false, error: `workspace read refused (${tenantRes.error?.message ?? "no workspace row"})` }
  const offices = ((offRes.data ?? []) as Array<{ id: string; status: string | null; managing_broker_user_id: string | null }>).filter((o) => (o.status ?? "active") === "active")
  const multiLocation = (tenantRes.data as { plan_tier: string | null }).plan_tier === "multi_location" || offices.length >= 2
  const h = await resolveViewerHierarchy(svc, { userId: viewer.userId, brokerageId: viewer.brokerageId })
  if (!h.ok) return { ok: false, error: h.error }
  return {
    ok: true,
    ...decideBooksAuthority({
      userType: viewer.userType, multiLocation, activeOfficeIds: offices.map((o) => o.id),
      hierarchy: { aggregate: h.scope.aggregate, kind: h.scope.kind, locationIds: h.scope.locationIds },
      managedOfficeIds: offices.filter((o) => o.managing_broker_user_id === viewer.userId).map((o) => o.id),
    }),
  }
}

/**
 * The office picker every company-books entry surface shows (the brokerage page's scoped entry, the receipt review):
 * the offices this viewer may WRITE, with names; `required` on a multi-location tenant (the person must choose — never
 * preselected); `mainOfficeAllowed` only for the consolidated books keeper. A refused read degrades to "required, no
 * choices", so the surface asks instead of letting an office-less entry through (fail closed).
 */
export async function officeChoicesFor(svc: Svc, viewer: BooksViewer): Promise<{ required: boolean; mainOfficeAllowed: boolean; choices: Array<{ id: string; name: string }> }> {
  const [auth, offRes] = await Promise.all([
    resolveBooksAuthority(svc, viewer),
    svc.from("locations").select("id, name").eq("brokerage_id", viewer.brokerageId),
  ])
  if (!auth.ok || offRes.error) return { required: true, mainOfficeAllowed: false, choices: [] }
  const names = new Map(((offRes.data ?? []) as Array<{ id: string; name: string | null }>).map((o) => [o.id, o.name ?? "Office"]))
  return { required: auth.multiLocation, mainOfficeAllowed: auth.writeCentral, choices: auth.writeOffices.map((id) => ({ id, name: names.get(id) ?? "Office" })) }
}

type BooksWriteCode =
  | "agent_books_have_no_office" | "cross_location_write" | "location_not_in_tenant" | "forbidden_central_books"
  | "forbidden_brokerage_scope" | "team_office_mismatch" | "books_authority_unavailable"

/**
 * PURE: may this authority put a row of `scope` on `locationId`'s books? Returns the office to STAMP (a team row takes
 * its team's office). Agent books carry no office. On a multi-location tenant a tenant-books row with no office is the
 * MAIN office's — that needs writeCentral.
 */
function decideBooksWrite(
  auth: Pick<BooksAuthority, "multiLocation" | "writeOffices" | "writeCentral">,
  req: { scope: "agent" | "team" | "brokerage"; locationId: string | null; activeOfficeIds: string[]; teamOfficeId?: string | null },
): { ok: true; locationId: string | null } | { ok: false; code: BooksWriteCode } {
  if (req.scope === "agent") return req.locationId ? { ok: false, code: "agent_books_have_no_office" } : { ok: true, locationId: null }
  if (req.scope === "team") {
    const office = req.teamOfficeId ?? null
    if (req.locationId && req.locationId !== office) return { ok: false, code: "team_office_mismatch" }
    return { ok: true, locationId: office }
  }
  if (req.locationId) {
    if (!req.activeOfficeIds.includes(req.locationId)) return { ok: false, code: "location_not_in_tenant" }
    if (!auth.writeOffices.includes(req.locationId)) return { ok: false, code: "cross_location_write" }
    return { ok: true, locationId: req.locationId }
  }
  if (auth.writeCentral) return { ok: true, locationId: null }
  return { ok: false, code: auth.multiLocation ? "forbidden_central_books" : "forbidden_brokerage_scope" }
}

/**
 * The writer's gate (app/actions/financials.ts logScopedExpense calls it before its insert). Reads the authority and,
 * for a team row, the team's office — both tenant-pinned, errors READ, a refusal refuses.
 */
export async function authorizeBooksWrite(
  svc: Svc,
  viewer: BooksViewer,
  req: { scope: "agent" | "team" | "brokerage"; locationId: string | null; teamId?: string | null },
): Promise<{ ok: true; locationId: string | null } | { ok: false; code: BooksWriteCode; detail?: string }> {
  if (req.scope === "agent") return decideBooksWrite({ multiLocation: false, writeOffices: [], writeCentral: false }, { scope: "agent", locationId: req.locationId, activeOfficeIds: [] })
  if (req.scope === "team") {
    const { data, error } = await svc.from("teams").select("id, location_id").eq("id", String(req.teamId ?? "")).eq("brokerage_id", viewer.brokerageId).maybeSingle()
    if (error) return { ok: false, code: "books_authority_unavailable", detail: error.message }
    return decideBooksWrite({ multiLocation: false, writeOffices: [], writeCentral: false }, { scope: "team", locationId: req.locationId, activeOfficeIds: [], teamOfficeId: (data as { location_id?: string | null } | null)?.location_id ?? null })
  }
  const auth = await resolveBooksAuthority(svc, viewer)
  if (!auth.ok) return { ok: false, code: "books_authority_unavailable", detail: auth.error }
  const { data: offs, error } = await svc.from("locations").select("id, status").eq("brokerage_id", viewer.brokerageId)
  if (error) return { ok: false, code: "books_authority_unavailable", detail: error.message }
  const activeOfficeIds = ((offs ?? []) as Array<{ id: string; status: string | null }>).filter((o) => (o.status ?? "active") === "active").map((o) => o.id)
  return decideBooksWrite(auth, { scope: "brokerage", locationId: req.locationId, activeOfficeIds })
}

/** Plain-English refusals for the codes above (the tenant-facing half; the code stays in the server log). */
export const BOOKS_WRITE_COPY: Record<BooksWriteCode, string> = {
  agent_books_have_no_office: "An agent's own expenses stay on their own books and are not assigned to an office.",
  cross_location_write: "You can record expenses only for the office you manage.",
  location_not_in_tenant: "That office is not one of this account's active offices.",
  forbidden_central_books: "Only someone who keeps the whole company's books can record a main-office expense.",
  forbidden_brokerage_scope: "Only an account admin who keeps the company's books can record a company expense.",
  team_office_mismatch: "A team's expenses belong to the team's own office.",
  books_authority_unavailable: "We could not confirm which books you keep right now, so nothing was recorded.",
}

// ─── 3. THE ROLLUP (pure) ─────────────────────────────────────────────────────

interface BooksExpenseRow {
  id: string
  amount: number | string
  expense_date: string
  category: string | null
  description: string | null
  agent_id: string | null
  team_id: string | null
  location_id?: string | null
}

interface AllocationRow {
  expense_id: string
  location_id: string | null
  share_bps: number
  allocation_set_id: string
  rule_label?: string | null
  superseded_at?: string | null
  /** The share's dollar amount FROZEN when the split was recorded (allocateSharedExpenseCore). The rollup splits the
   *  expense's CURRENT amount by share_bps; a set whose frozen amounts no longer sum to that amount was made before the
   *  expense was edited, and is reported as a stale split (the figures stay right — the books keeper re-splits). */
  allocated_amount?: number | string | null
}

interface OfficeExpenseLine {
  locationId: string
  name: string
  /** Company-books rows this office owns, net of their reversals (team books stay on the team's own book). */
  owned: number
  /** Its shares of centrally-owned costs. */
  allocatedIn: number
  total: number
  rowCount: number
}

interface ExpenseRollup {
  period: { from: string; to: string }
  offices: OfficeExpenseLine[]
  /** Main-office costs with no allocation (null when this viewer may not see the main office). */
  centralUnallocated: number | null
  /** The main office's own retained share of allocated costs (null when not visible). */
  centralRetained: number | null
  /** Every visible source row, each once (null when the viewer is office-scoped — an office is not the tenant). */
  tenantTotal: number | null
  /** The invariant: offices + central = tenant total, to the cent, every source row once. */
  balanced: boolean
  rowsCounted: number
  reversals: { count: number; amount: number }
  /** Active splits whose frozen share amounts no longer add up to the expense's current amount (consolidated only). */
  staleSplits: number
  consolidated: boolean
}

const REVERSAL_RE = /\(reverses expense ([0-9a-f-]{36})\)/i

/** PURE: the original expense a reversal row names (its description carries reversalMarker), else null. */
function reversalOriginOf(description: string | null | undefined): string | null {
  const m = REVERSAL_RE.exec(String(description ?? ""))
  return m ? m[1] : null
}

/**
 * PURE: build the office / main-office / tenant rollup from tenant-books rows and ACTIVE allocation facts. Agent rows
 * are ignored (never tenant books). `visibleOffices: "all"` = consolidated; a list = an office-scoped viewer, who gets
 * only those offices (rows they own plus their allocated-in shares) and no tenant or main-office totals.
 */
function buildExpenseRollup(input: {
  period: { from: string; to: string }
  rows: BooksExpenseRow[]
  allocations: AllocationRow[]
  offices: Array<{ id: string; name: string }>
  visibleOffices: "all" | string[]
}): ExpenseRollup {
  const consolidated = input.visibleOffices === "all"
  const visible = new Set(consolidated ? input.offices.map((o) => o.id) : (input.visibleOffices as string[]))
  const owned = new Map<string, number>()
  const allocIn = new Map<string, number>()
  const counts = new Map<string, number>()
  const activeSets = new Map<string, AllocationShare[]>()
  const frozenCents = new Map<string, number | null>()
  for (const a of input.allocations) {
    if (a.superseded_at) continue
    const list = activeSets.get(a.expense_id) ?? []
    list.push({ locationId: a.location_id ?? null, shareBps: Number(a.share_bps) })
    activeSets.set(a.expense_id, list)
    // A share with no frozen amount makes the set's frozen total unknown (never a guessed match).
    const prior = frozenCents.has(a.expense_id) ? frozenCents.get(a.expense_id)! : 0
    frozenCents.set(a.expense_id, prior == null || a.allocated_amount == null ? null : prior + toCents(a.allocated_amount))
  }
  let staleSplits = 0
  let tenant = 0, central = 0, retained = 0, rowsCounted = 0, revCount = 0, revSum = 0
  const add = (m: Map<string, number>, k: string, c: number) => m.set(k, (m.get(k) ?? 0) + c)
  for (const r of input.rows) {
    if (r.agent_id || r.team_id) continue
    if (r.expense_date < input.period.from || r.expense_date > input.period.to) continue
    const cents = toCents(r.amount)
    const office = r.location_id ?? null
    const origin = reversalOriginOf(r.description)
    if (origin) { revCount++; revSum += cents }
    rowsCounted++
    tenant += cents
    if (office) { add(owned, office, cents); add(counts, office, 1); continue }
    const shares = activeSets.get(origin ?? r.id)
    if (shares && !origin) {
      const frozen = frozenCents.get(r.id)
      if (frozen != null && frozen !== cents) staleSplits++
    }
    const split = shares ? allocateByShares(fromCents(cents), shares) : null
    if (!split || !split.ok) { central += cents; continue }
    for (const l of split.lines) {
      if (l.locationId) add(allocIn, l.locationId, toCents(l.amount))
      else retained += toCents(l.amount)
    }
  }
  const officeLines: OfficeExpenseLine[] = input.offices.map((o) => {
    const ow = owned.get(o.id) ?? 0, ai = allocIn.get(o.id) ?? 0
    return { locationId: o.id, name: o.name, owned: fromCents(ow), allocatedIn: fromCents(ai), total: fromCents(ow + ai), rowCount: counts.get(o.id) ?? 0 }
  })
  // Rows owned by an office the list does not name (archived since) still belong to the tenant — they are kept as their
  // own line so the parts sum to the whole.
  for (const id of new Set([...owned.keys(), ...allocIn.keys()])) {
    if (officeLines.some((l) => l.locationId === id)) continue
    const ow = owned.get(id) ?? 0, ai = allocIn.get(id) ?? 0
    officeLines.push({ locationId: id, name: "Office no longer active", owned: fromCents(ow), allocatedIn: fromCents(ai), total: fromCents(ow + ai), rowCount: counts.get(id) ?? 0 })
  }
  const partsCents = officeLines.reduce((s, l) => s + toCents(l.total), 0) + central + retained
  const balanced = partsCents === tenant
  return {
    period: input.period,
    offices: officeLines.filter((l) => consolidated || visible.has(l.locationId)),
    centralUnallocated: consolidated ? fromCents(central) : null,
    centralRetained: consolidated ? fromCents(retained) : null,
    tenantTotal: consolidated ? fromCents(tenant) : null,
    balanced,
    rowsCounted: consolidated ? rowsCounted : officeLines.filter((l) => visible.has(l.locationId)).reduce((s, l) => s + l.rowCount, 0),
    reversals: consolidated ? { count: revCount, amount: fromCents(revSum) } : { count: 0, amount: 0 },
    staleSplits: consolidated ? staleSplits : 0,
    consolidated,
  }
}

/**
 * THE READER: the viewer's rollup for a recognition-date window. Consolidated for the tenant's books keepers/readers
 * with all-office scope; office-scoped for an office admin / managing broker; refused for everyone else. Every read's
 * error is READ and refuses (never a confident zero).
 */
export async function loadExpenseRollup(svc: Svc, viewer: BooksViewer, period: { from: string; to: string }): Promise<{ ok: true; rollup: ExpenseRollup; authority: BooksAuthority } | { ok: false; error: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period.from) || !/^\d{4}-\d{2}-\d{2}$/.test(period.to)) return { ok: false, error: "period_invalid" }
  const auth = await resolveBooksAuthority(svc, viewer)
  if (!auth.ok) return { ok: false, error: auth.error }
  if (!auth.consolidated && auth.readOffices.length === 0) return { ok: false, error: "no_books_in_scope" }
  const [offRes, rowRes] = await Promise.all([
    svc.from("locations").select("id, name, status").eq("brokerage_id", viewer.brokerageId),
    svc.from("business_expenses").select("id, amount, expense_date, category, description, agent_id, team_id, location_id")
      .eq("brokerage_id", viewer.brokerageId).is("agent_id", null).is("team_id", null).gte("expense_date", period.from).lte("expense_date", period.to),
  ])
  if (offRes.error) return { ok: false, error: `offices read refused (${offRes.error.message})` }
  if (rowRes.error) return { ok: false, error: `expenses read refused (${rowRes.error.message})` }
  const rows = (rowRes.data ?? []) as BooksExpenseRow[]
  const sourceIds = [...new Set(rows.map((r) => reversalOriginOf(r.description) ?? r.id))]
  let allocations: AllocationRow[] = []
  if (sourceIds.length) {
    const { data, error } = await svc.from("business_expense_allocations").select("expense_id, location_id, share_bps, allocation_set_id, rule_label, superseded_at, allocated_amount")
      .eq("brokerage_id", viewer.brokerageId).is("superseded_at", null).in("expense_id", sourceIds)
    if (error) return { ok: false, error: `allocations read refused (${error.message})` }
    allocations = (data ?? []) as AllocationRow[]
  }
  const offices = ((offRes.data ?? []) as Array<{ id: string; name: string | null; status: string | null }>)
    .filter((o) => (o.status ?? "active") === "active").map((o) => ({ id: o.id, name: o.name ?? "Office" }))
  const rollup = buildExpenseRollup({
    period, rows, allocations, offices,
    visibleOffices: auth.consolidated ? "all" : auth.readOffices,
  })
  const { ok: _ok, ...authority } = auth
  return { ok: true, rollup, authority }
}

interface SplitHistoryEntry {
  allocationSetId: string
  expenseId: string
  ruleLabel: string | null
  /** The share amounts as they were frozen when the split was recorded (sum of allocated_amount). */
  total: number
  shareCount: number
  createdAt: string
  createdBy: string | null
  supersededAt: string | null
  supersededBy: string | null
}

/**
 * THE SPLIT HISTORY (the audit read of business_expense_allocations): who split which main-office cost, when, on what rule,
 * and who replaced it. Consolidated books keepers only (an office admin sees office totals, not the company's re-split
 * decisions). Superseded sets are history, never deleted — this is where that history is read. Every error is READ.
 */
export async function loadExpenseSplitHistory(svc: Svc, viewer: BooksViewer, opts: { limit?: number } = {}): Promise<{ ok: true; entries: SplitHistoryEntry[] } | { ok: false; error: string }> {
  const auth = await resolveBooksAuthority(svc, viewer)
  if (!auth.ok) return { ok: false, error: auth.error }
  if (!auth.consolidated) return { ok: false, error: "forbidden_central_books" }
  const { data, error } = await svc.from("business_expense_allocations")
    .select("allocation_set_id, expense_id, rule_label, allocated_amount, created_at, created_by_user_id, superseded_at, superseded_by_user_id")
    .eq("brokerage_id", viewer.brokerageId).order("created_at", { ascending: false }).limit(Math.min(Math.max(opts.limit ?? 200, 1), 500))
  if (error) return { ok: false, error: `split history read refused (${error.message})` }
  type Row = { allocation_set_id: string; expense_id: string; rule_label: string | null; allocated_amount: number | string | null; created_at: string; created_by_user_id: string | null; superseded_at: string | null; superseded_by_user_id: string | null }
  const sets = new Map<string, { row: Row; cents: number; n: number }>()
  for (const r of (data ?? []) as Row[]) {
    const cur = sets.get(r.allocation_set_id)
    if (cur) { cur.cents += toCents(r.allocated_amount); cur.n++ }
    else sets.set(r.allocation_set_id, { row: r, cents: toCents(r.allocated_amount), n: 1 })
  }
  const userIds = [...new Set([...sets.values()].flatMap((v) => [v.row.created_by_user_id, v.row.superseded_by_user_id]).filter((x): x is string => !!x))]
  const names = new Map<string, string>()
  if (userIds.length) {
    const { data: people, error: pErr } = await svc.from("users").select("id, first_name, last_name").eq("brokerage_id", viewer.brokerageId).in("id", userIds)
    if (pErr) return { ok: false, error: `split history people read refused (${pErr.message})` }
    for (const p of (people ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) {
      const n = [p.first_name, p.last_name].filter(Boolean).join(" ").trim()
      if (n) names.set(p.id, n)
    }
  }
  const who = (id: string | null) => (id ? names.get(id) ?? "A former user" : null)
  return {
    ok: true,
    entries: [...sets.values()].map(({ row, cents, n }) => ({
      allocationSetId: row.allocation_set_id, expenseId: row.expense_id, ruleLabel: row.rule_label, total: fromCents(cents), shareCount: n,
      createdAt: row.created_at, createdBy: who(row.created_by_user_id), supersededAt: row.superseded_at, supersededBy: who(row.superseded_by_user_id),
    })),
  }
}

// ─── 4. ALLOCATING A SHARED COST (the allocation writer's core) ────────────────

type AllocationCode =
  | "forbidden_central_books" | "books_authority_unavailable" | "expense_not_found" | "not_a_central_expense"
  | "reversal_not_allocatable" | "location_not_in_tenant" | "rule_required" | "no_shares" | "share_invalid"
  | "duplicate_target" | "shares_not_100_percent" | "amount_invalid" | "supersede_refused" | "insert_refused"

/**
 * Record (or replace) the allocation of ONE centrally-owned tenant expense. Only a viewer with writeCentral (the
 * consolidated books keeper) may. The prior active set is SUPERSEDED (kept as history), then the new set is inserted;
 * if the insert is refused the expense is left UNALLOCATED (its whole cost on the main office) — never doubled — and
 * the refusal is returned. Evidence (withActionLedger) is the caller's: app/actions/financials.ts allocateSharedExpense.
 */
export async function allocateSharedExpenseCore(
  svc: Svc,
  viewer: BooksViewer,
  input: { expenseId: string; shares: AllocationShare[]; ruleLabel: string; now?: Date },
): Promise<{ ok: true; allocationSetId: string; lines: Array<{ locationId: string | null; shareBps: number; amount: number }>; superseded: number } | { ok: false; code: AllocationCode; detail?: string }> {
  const rule = String(input.ruleLabel ?? "").trim()
  if (!rule) return { ok: false, code: "rule_required" }
  const auth = await resolveBooksAuthority(svc, viewer)
  if (!auth.ok) return { ok: false, code: "books_authority_unavailable", detail: auth.error }
  if (!auth.writeCentral) return { ok: false, code: "forbidden_central_books" }
  const { data: exp, error: expErr } = await svc.from("business_expenses").select("id, amount, agent_id, team_id, location_id, description")
    .eq("id", input.expenseId).eq("brokerage_id", viewer.brokerageId).maybeSingle()
  if (expErr) return { ok: false, code: "books_authority_unavailable", detail: expErr.message }
  if (!exp) return { ok: false, code: "expense_not_found" }
  const e = exp as { id: string; amount: number | string; agent_id: string | null; team_id: string | null; location_id: string | null; description: string | null }
  if (reversalOriginOf(e.description)) return { ok: false, code: "reversal_not_allocatable" }
  if (e.agent_id || e.team_id || e.location_id || !(Number(e.amount) > 0)) return { ok: false, code: "not_a_central_expense" }
  const { data: offs, error: offErr } = await svc.from("locations").select("id, status").eq("brokerage_id", viewer.brokerageId)
  if (offErr) return { ok: false, code: "books_authority_unavailable", detail: offErr.message }
  const active = new Set(((offs ?? []) as Array<{ id: string; status: string | null }>).filter((o) => (o.status ?? "active") === "active").map((o) => o.id))
  if (input.shares.some((s) => s.locationId && !active.has(s.locationId))) return { ok: false, code: "location_not_in_tenant" }
  const split = allocateByShares(e.amount, input.shares)
  if (!split.ok) return { ok: false, code: split.code }
  const nowIso = (input.now ?? new Date()).toISOString()
  const { data: sup, error: supErr } = await svc.from("business_expense_allocations")
    .update({ superseded_at: nowIso, superseded_by_user_id: viewer.userId })
    .eq("brokerage_id", viewer.brokerageId).eq("expense_id", e.id).is("superseded_at", null).select("id")
  if (supErr) return { ok: false, code: "supersede_refused", detail: supErr.message }
  const allocationSetId = randomUUID()
  const { data: ins, error: insErr } = await svc.from("business_expense_allocations").insert(split.lines.map((l) => ({
    brokerage_id: viewer.brokerageId, expense_id: e.id, allocation_set_id: allocationSetId, location_id: l.locationId,
    share_bps: l.shareBps, allocated_amount: l.amount, rule_label: rule, created_by_user_id: viewer.userId,
  }))).select("id")
  if (insErr) return { ok: false, code: "insert_refused", detail: insErr.message }
  if (!Array.isArray(ins) || ins.length !== split.lines.length) return { ok: false, code: "insert_refused", detail: `wrote ${Array.isArray(ins) ? ins.length : 0} of ${split.lines.length} shares` }
  return { ok: true, allocationSetId, lines: split.lines, superseded: Array.isArray(sup) ? sup.length : 0 }
}

export const ALLOCATION_COPY: Record<AllocationCode, string> = {
  forbidden_central_books: "Only someone who keeps the whole company's books can split a main-office cost across offices.",
  books_authority_unavailable: "We could not confirm which books you keep right now, so nothing was changed.",
  expense_not_found: "That expense is not in this account's books.",
  not_a_central_expense: "Only a main-office expense can be split across offices; office and team expenses already belong to an office.",
  reversal_not_allocatable: "A refund follows the split of the expense it reverses, so it is not split on its own.",
  location_not_in_tenant: "One of those offices is not an active office of this account.",
  rule_required: "Say how the cost is being split (for example, \"rent by headcount\") so the split can be explained later.",
  no_shares: "Add at least one office share.",
  share_invalid: "Each share must be a whole number of basis points between 1 and 10,000.",
  duplicate_target: "Each office can appear only once in a split.",
  shares_not_100_percent: "The shares must add up to exactly 100%.",
  amount_invalid: "This expense has no amount to split.",
  supersede_refused: "The earlier split could not be retired, so nothing was changed.",
  insert_refused: "The new split could not be saved. The cost stays with the main office until it is saved.",
}

// ─── 5. WHAT MAY STILL BE DELETED (pure) — paid / closed rows are immutable ────

/**
 * PURE: may a recorded expense row still be DELETED by its owner? Once money has a trail it is closed, and a correction
 * is a reversal (refund / credit / void = a negative row on the same books), never a delete:
 *   · a reversal row (deleting a refund would silently resurrect the cost);
 *   · an original that has reversals against it (the refund would point at nothing);
 *   · a row posted from an approved receipt (its receipt document records the posted expense id — proof it was paid);
 *   · a row carrying an active allocation (offices are charged a share of it).
 */
export function expenseDeleteVerdict(input: { description: string | null; receiptUrl: string | null; reversalCount: number; activeAllocationCount: number }):
  { ok: true } | { ok: false; code: "reversal_row_immutable" | "reversed_expense_immutable" | "receipt_posted_immutable" | "allocated_expense_immutable"; message: string } {
  if (reversalOriginOf(input.description)) return { ok: false, code: "reversal_row_immutable", message: "A recorded refund or credit cannot be deleted. Record a new expense if it was entered by mistake." }
  if (input.reversalCount > 0) return { ok: false, code: "reversed_expense_immutable", message: "This expense has a refund or credit recorded against it, so it is closed and cannot be deleted." }
  if (String(input.receiptUrl ?? "").startsWith("/dashboard/financials/expenses/receipts/")) return { ok: false, code: "receipt_posted_immutable", message: "This expense was recorded from an approved receipt, so it is closed. Record the refund or credit to correct it." }
  if (input.activeAllocationCount > 0) return { ok: false, code: "allocated_expense_immutable", message: "This expense is split across offices, so it cannot be deleted. Record a credit to correct it." }
  return { ok: true }
}

/** The ilike pattern that finds every reversal of one expense (the marker logScopedExpense writes). */
export function reversalSearchPattern(expenseId: string): string { return `%${reversalMarker(expenseId)}%` }
