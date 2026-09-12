// lib/commission/cap-resolver.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE ANSWER to "what cap applies to this agent, and is it in the ledger the
// commission engine actually reads?"
//
// ══ WHY THIS MODULE EXISTS ═══════════════════════════════════════════════════
//
// A cap is a CEILING ON WHAT AN ENTITY COLLECTS from an agent per anniversary
// year. `lib/commission/waterfall/07-apply-cap.ts` states it in its own header —
// "Cap tracks brokerage's cumulative earnings, NOT agent's" — and once the
// brokerage has taken `cap_amount`, its share drops to $0 and the agent keeps
// the rest.
//
// THREE places stored an agent's cap amount:
//
//   agent_cap_tracking.cap_amount        the LEDGER stage 07 reads. CANONICAL.
//   agent_commission_profiles.cap_amount the per-agent configured override
//   agents.cap_amount / cap_progress     a third copy
//
// `app/actions/ai-financial-management.ts:291` already declared the winner —
// "cap state is owned by agent_cap_tracking (the canonical ledger)" — but the
// consolidation was never finished, and the gap was not cosmetic. MEASURED on
// the live database before m461: four agents carried `agents.cap_amount` and
// THREE of them had no `agent_cap_tracking` row at all. Stage 07 finds no ledger
// row, returns `capStatus: 'n/a'`, and never caps them. A broker set a cap, the
// screen showed it, and the engine has never once enforced it.
//
// So a cap that is only CONFIGURED is not a cap. THE SEEDER IS WHAT MAKES A
// SETTING REAL: it materialises the resolved answer into `agent_cap_tracking`
// for the current anniversary window, which is the only place the engine looks.
// Everything else in this file exists to compute the number that seeder writes.
//
// ══ PRECEDENCE ═══════════════════════════════════════════════════════════════
//
//   1. agent_commission_profiles.cap_amount — the per-agent override, honouring
//      `is_active` and `effective_date` (a profile dated in the future has not
//      started yet and must not win).
//   2. brokerages.default_cap_amount — the brokerage-wide setting (m461), so a
//      brokerage states its cap ONCE instead of re-typing it into every agent.
//   3. none — no cap. `agent_cap_tracking` gets no row, stage 07 returns 'n/a',
//      and that is now the TRUE statement it was previously making falsely.
//
// A cap of exactly 0 is a REAL configured answer, not "unset": stage 07 reads
// remaining ≤ 0 as post-cap, so 0 means "the brokerage collects nothing from
// this agent". Only NULL means nobody has decided. Same rule
// `saveTeamSplits` already applies to a 0% team split.
//
// ══ THE WINDOW MUST CONTAIN TODAY ════════════════════════════════════════════
//
// Stage 07 finds its row with `anniversary_start <= today AND anniversary_end >=
// today`. A window anchored naively on the agent's join date would have CLOSED
// months ago for any agent older than a year — a ledger row that exists and
// still never matches, which is indistinguishable from the bug being fixed. So
// the anchor is ROLLED FORWARD by whole elapsed years, and the seeder refuses to
// write a window that does not contain today rather than writing a row that
// cannot be found.
//
// `agents.start_date` DOES NOT EXIST on this schema. Only `created_at` does.
// Anchoring on a phantom column would make this module an instance of the exact
// defect class it exists to clean up.
//
// ══ WINDOW ENDS ARE INCLUSIVE AND NON-OVERLAPPING ════════════════════════════
//
// `end = start + 1 year − 1 day`, not `start + 1 year`. Stage 07's filter is
// inclusive at BOTH ends and reaches for `.maybeSingle()`, which THROWS on two
// matching rows. With an exclusive-style end of `start + 1 year`, consecutive
// windows share their seam day and two rows would match on that one day a year.
// A calendar-year cap is 1 Jan → 31 Dec, not 1 Jan → 1 Jan. (m461's backfill
// wrote the seam form for the four pre-existing agents; those rows are safe
// because the seeder below only ever writes when NOTHING covers today.)

import type { SupabaseClient } from "@supabase/supabase-js"

// ── Anniversary basis ────────────────────────────────────────────────────────

/**
 * Which 12-month window a cap resets on. These are exactly the three values the
 * live CHECK constraint `brokerages_default_cap_anniversary_basis_check` admits;
 * a fourth spelling here would be refused by the database at write time.
 */
export const CAP_ANNIVERSARY_BASES = [
  "agent_start_date",
  "calendar_year",
  "brokerage_fiscal_year",
] as const

export type CapAnniversaryBasis = (typeof CAP_ANNIVERSARY_BASES)[number]

/** The column DEFAULT in m461, and the industry norm: each agent's own anniversary. */
export const DEFAULT_CAP_ANNIVERSARY_BASIS: CapAnniversaryBasis = "agent_start_date"

/**
 * PURE. Coerce whatever the column (or a form post) holds into a basis this
 * module can act on. An unrecognised value falls back to the column default
 * rather than throwing: the CHECK constraint already makes a bad value
 * unwritable, so seeing one here means the constraint was bypassed, and refusing
 * to seed a cap over a spelling mistake would cost money.
 */
export function normalizeCapAnniversaryBasis(v: unknown): CapAnniversaryBasis {
  return (CAP_ANNIVERSARY_BASES as readonly string[]).includes(v as string)
    ? (v as CapAnniversaryBasis)
    : DEFAULT_CAP_ANNIVERSARY_BASIS
}

/** Human wording for each basis — used by the settings surfaces so the choice is
 *  legible without opening a migration. */
export const CAP_ANNIVERSARY_BASIS_LABEL: Record<CapAnniversaryBasis, string> = {
  agent_start_date: "Each agent's own anniversary (the date they joined)",
  calendar_year: "The calendar year (resets 1 January)",
  brokerage_fiscal_year: "The brokerage's own year (resets on the brokerage's anniversary)",
}

// ── Pure date arithmetic ─────────────────────────────────────────────────────
//
// Deliberately integer arithmetic over Y/M/D rather than `new Date()` maths. A
// `Date` built from "2026-08-16" is UTC midnight, and every local-time getter on
// it is a day earlier west of Greenwich — which is how an anniversary window
// silently starts a day late and a boundary deal lands outside its own cap.

interface Ymd {
  y: number
  m: number // 1-12
  d: number // 1-31
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeap(y) ? 29 : 28
  return [4, 6, 9, 11].includes(m) ? 30 : 31
}

/**
 * PURE. `YYYY-MM-DD`, or the date half of an ISO timestamp — which is what
 * `agents.created_at` (timestamptz) arrives as from PostgREST. Returns null for
 * anything that is not a real calendar date; `2026-02-31` is refused rather than
 * rolled forward into March the way `Date.parse` would.
 */
function parseCapDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim())
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  if (mo < 1 || mo > 12) return null
  if (d < 1 || d > daysInMonth(y, mo)) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

function toYmd(iso: string): Ymd {
  return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), d: Number(iso.slice(8, 10)) }
}

function fromYmd(v: Ymd): string {
  return `${String(v.y).padStart(4, "0")}-${String(v.m).padStart(2, "0")}-${String(v.d).padStart(2, "0")}`
}

/**
 * Add whole years, CLAMPING the day to the target month's length. 29 February
 * plus one year is 28 February — the only honest answer, and the alternative
 * (1 March) would move an agent's anniversary permanently.
 */
function addYears(v: Ymd, n: number): Ymd {
  const y = v.y + n
  return { y, m: v.m, d: Math.min(v.d, daysInMonth(y, v.m)) }
}

function subtractOneDay(v: Ymd): Ymd {
  if (v.d > 1) return { y: v.y, m: v.m, d: v.d - 1 }
  const m = v.m === 1 ? 12 : v.m - 1
  const y = v.m === 1 ? v.y - 1 : v.y
  return { y, m, d: daysInMonth(y, m) }
}

/** ISO dates are lexicographically ordered, so string comparison IS date order. */
function lte(a: string, b: string): boolean {
  return a <= b
}

// ── The anniversary window ───────────────────────────────────────────────────

export interface AnniversaryWindow {
  /** `agent_cap_tracking.anniversary_start`, inclusive. */
  start: string
  /** `agent_cap_tracking.anniversary_end`, inclusive. */
  end: string
  /** The date the anchor was taken from, before it was rolled forward. */
  anchor: string
  /** Whole years the anchor was rolled forward to reach the live window. */
  yearsElapsed: number
}

export type WindowResult =
  | { ok: true; window: AnniversaryWindow }
  | { ok: false; error: string }

/**
 * PURE. The anniversary window that CONTAINS `today`, for one basis.
 *
 * THE ROLL-FORWARD IS THE POINT. An agent created in 2019 has had six
 * anniversaries; the live window is the seventh, not the first. Anchoring on the
 * join date without rolling forward produces `2019-04-01 → 2020-03-31`, which
 * stage 07's `anniversary_start <= today <= anniversary_end` filter will never
 * match — a row that exists and is invisible, which is worse than no row at all
 * because it looks like the problem has been fixed.
 */
export function resolveAnniversaryWindow(input: {
  basis: CapAnniversaryBasis
  today: string
  /** `agents.created_at`. There is no `agents.start_date` on this schema. */
  agentCreatedAt?: string | null
  /** `brokerages.created_at` — the brokerage's own year has no other anchor:
   *  there is no fiscal-year-start column on `brokerages`, and inventing one
   *  here would be a phantom. */
  brokerageCreatedAt?: string | null
}): WindowResult {
  const today = parseCapDate(input.today)
  if (!today) return { ok: false, error: `"${String(input.today)}" is not a calendar date.` }

  let anchorIso: string | null
  if (input.basis === "calendar_year") {
    anchorIso = `${today.slice(0, 4)}-01-01`
  } else if (input.basis === "brokerage_fiscal_year") {
    anchorIso = parseCapDate(input.brokerageCreatedAt)
    if (!anchorIso) {
      return {
        ok: false,
        error:
          "The brokerage's own year is the cap basis, but the brokerage record has no readable created_at to anchor it on.",
      }
    }
  } else {
    anchorIso = parseCapDate(input.agentCreatedAt)
    if (!anchorIso) {
      return {
        ok: false,
        error:
          "The agent's anniversary is the cap basis, but the agent record has no readable created_at to anchor it on.",
      }
    }
  }

  const anchor = toYmd(anchorIso)
  const todayYmd = toYmd(today)

  // Smallest whole number of years that lands the anchor on or before today.
  let years = todayYmd.y - anchor.y
  if (years < 0) years = 0
  let start = addYears(anchor, years)
  while (years > 0 && !lte(fromYmd(start), today)) {
    years -= 1
    start = addYears(anchor, years)
  }

  const startIso = fromYmd(start)
  if (!lte(startIso, today)) {
    // Only reachable when the anchor itself is in the FUTURE — a created_at
    // ahead of today, which is data nonsense. Refuse rather than write a window
    // stage 07 can never match.
    return {
      ok: false,
      error: `The cap window would start ${startIso}, which is after today (${today}) — the anchor date is in the future, so no window contains today.`,
    }
  }

  const endIso = fromYmd(subtractOneDay(addYears(start, 1)))
  return { ok: true, window: { start: startIso, end: endIso, anchor: anchorIso, yearsElapsed: years } }
}

/** PURE. Exactly stage 07's filter, so "does this window work?" is asked the way
 *  the engine asks it and not a paraphrase of it. */
export function windowContains(window: { start: string; end: string }, today: string): boolean {
  return lte(window.start, today) && lte(today, window.end)
}

// ── Money ────────────────────────────────────────────────────────────────────

export type CapAmountResult = { ok: true; value: number | null } | { ok: false; error: string }

/**
 * PURE. The ONE parser for a cap typed into a settings form, shared by the
 * brokerage default writer and the team cap writer so the two cannot drift.
 *
 * The columns are `numeric(12,2)`. MORE PRECISION IS REFUSED, NEVER ROUNDED —
 * rounding money on the user's behalf is how a cap ends up not being the one
 * that was agreed, and `saveTeamSplits` already refuses on the same grounds.
 *
 * Blank is NULL, which means UNCAPPED. `0` is a real answer meaning "collects
 * nothing", and the two are not the same fact.
 */
export function parseCapAmountInput(raw: unknown, label: string): CapAmountResult {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== "string") return { ok: false, error: `${label} must be typed as a number.` }

  let t = raw.trim().replace(/,/g, "")
  if (t.startsWith("$")) t = t.slice(1).trim()
  if (!t) return { ok: true, value: null }

  // Deliberately stricter than Number(): "1e3", "0x10" and "Infinity" all
  // survive Number() and none of them belong in a money column.
  if (!/^\d+(?:\.\d+)?$/.test(t)) {
    return { ok: false, error: `${label} must be a plain number — "${raw.trim()}" is not one.` }
  }
  const n = Number(t)
  if (!Number.isFinite(n)) {
    return { ok: false, error: `${label} must be a plain number — "${raw.trim()}" is not one.` }
  }
  const decimals = t.includes(".") ? t.split(".")[1].length : 0
  if (decimals > 2) {
    return {
      ok: false,
      error: `${label} can have at most 2 decimal places — "${raw.trim()}" has ${decimals}. Cents are the smallest unit this is stored in.`,
    }
  }
  // numeric(12,2) holds ten digits before the point. A larger number is not
  // saved-and-truncated; Postgres refuses the whole row, so it is refused here
  // with a sentence instead.
  if (n > 9_999_999_999.99) {
    return { ok: false, error: `${label} is larger than this field can store (max 9,999,999,999.99).` }
  }
  return { ok: true, value: n }
}

/** A `numeric` column arrives from PostgREST as a string, a number, or null. */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ── Precedence ───────────────────────────────────────────────────────────────

export type CapSource = "explicit" | "agent_profile" | "brokerage_default" | "none"

export interface PickedCap {
  /** Dollars. NULL means NO CAP — and no ledger row, which is stage 07's 'n/a'. */
  capAmount: number | null
  source: CapSource
}

export interface CommissionProfileCapRow {
  cap_amount: unknown
  is_active: unknown
  effective_date: unknown
}

/**
 * PURE. The precedence, with nothing else in it, so it can be asserted directly.
 *
 * `explicit` is not a fourth store: it is the amount a caller named IN THIS ACT
 * (a broker typing a cap on the agent-creation form), materialised straight into
 * the ledger instead of into `agents.cap_amount`, which nothing enforces.
 *
 * A profile row only counts when `is_active` is true AND its `effective_date`
 * has arrived — an agreement dated next quarter is not this quarter's cap. Among
 * the rows that qualify, the LATEST effective_date wins; a NULL effective_date
 * means "from the start" and therefore loses to any dated row that has arrived.
 */
export function pickCapAmount(input: {
  explicitCapAmount?: number | null
  profiles: CommissionProfileCapRow[]
  brokerageDefaultCap: unknown
  today: string
}): PickedCap {
  if (input.explicitCapAmount !== null && input.explicitCapAmount !== undefined) {
    return { capAmount: input.explicitCapAmount, source: "explicit" }
  }

  const eligible = input.profiles
    .filter((p) => p.is_active === true)
    .filter((p) => numOrNull(p.cap_amount) !== null)
    .filter((p) => {
      const eff = parseCapDate(p.effective_date)
      return eff === null || lte(eff, input.today)
    })
    .sort((a, b) => {
      const ea = parseCapDate(a.effective_date) ?? ""
      const eb = parseCapDate(b.effective_date) ?? ""
      return eb.localeCompare(ea)
    })

  if (eligible.length > 0) {
    return { capAmount: numOrNull(eligible[0].cap_amount), source: "agent_profile" }
  }

  const brokerageDefault = numOrNull(input.brokerageDefaultCap)
  if (brokerageDefault !== null) {
    return { capAmount: brokerageDefault, source: "brokerage_default" }
  }

  return { capAmount: null, source: "none" }
}

// ── The seeder ───────────────────────────────────────────────────────────────

export type CapSeedOutcome =
  /** A row already covers today. The ledger wins; nothing is overwritten. */
  | "already_covered"
  /** Nobody has configured a cap at any level. Correctly uncapped. */
  | "no_cap_configured"
  /** A row was written, and the engine will find it. */
  | "seeded"

export interface CapSeedResult {
  outcome: CapSeedOutcome
  capAmount: number | null
  source: CapSource
  basis: CapAnniversaryBasis
  window: { start: string; end: string } | null
  /** `agent_cap_tracking.id` — of the row written, or of the row already there. */
  trackingId: string | null
}

/**
 * MATERIALISE the resolved cap into `agent_cap_tracking` for the anniversary
 * window that contains today, when no row covers today.
 *
 * THIS IS THE FUNCTION THAT MAKES A CAP SETTING REAL. Everything above only
 * computes a number; stage 07 reads exactly one table and this is the only code
 * that puts the answer there.
 *
 * WHAT IT WILL NOT DO, on purpose:
 *   • It never UPDATES an existing window. `cap_paid_to_date` on a live row is
 *     money already collected, advanced by the commission engine on every
 *     disbursement. A "refresh" that rewrote `cap_amount` mid-year would move
 *     the ceiling under a half-run year, and rewriting `cap_paid_to_date` would
 *     erase collections. Changing a live cap is a deliberate administrative
 *     correction, not a side effect of somebody opening a settings page.
 *   • It never writes `agents.cap_amount`. That column is the copy nothing
 *     enforces and it is being dropped.
 *
 * `db` must be a client that may write `agent_cap_tracking`. The engine writes
 * it on the service client; the RLS policy admits brokerage admins only.
 */
export async function ensureAgentCapWindow(
  db: SupabaseClient,
  args: {
    agentId: string
    brokerageId: string
    /** YYYY-MM-DD. Defaults to today — injectable so the arithmetic is testable. */
    today?: string
    /** A cap named by the caller in this act; outranks the resolver. */
    explicitCapAmount?: number | null
  },
): Promise<{ ok: true; result: CapSeedResult } | { ok: false; error: string }> {
  const today = parseCapDate(args.today ?? new Date().toISOString().slice(0, 10))
  if (!today) return { ok: false, error: `"${String(args.today)}" is not a calendar date.` }

  // ── 1. Does a window already cover today? ─────────────────────────────────
  // Stage 07's own filter. `error` is destructured because supabase-js RESOLVES
  // a refused read: treating a refusal as "no row" would seed a SECOND
  // overlapping window, and stage 07's `.maybeSingle()` over an inclusive date
  // range THROWS when two rows match — turning an unenforced cap into a crashed
  // commission calculation.
  const { data: existing, error: existingErr } = await db
    .from("agent_cap_tracking")
    .select("id, cap_amount, anniversary_start, anniversary_end")
    .eq("brokerage_id", args.brokerageId)
    .eq("agent_id", args.agentId)
    .lte("anniversary_start", today)
    .gte("anniversary_end", today)
    .limit(1)

  if (existingErr) {
    return { ok: false, error: `Could not read the agent's cap ledger: ${existingErr.message}` }
  }

  // ── 2. What cap applies? ──────────────────────────────────────────────────
  // TENANT-SCOPED reads. `agents` is filtered by brokerage_id as well as id, so
  // an agent id from another tenant resolves to nothing rather than to a row.
  const [agentRes, brokerageRes, profileRes] = await Promise.all([
    db
      .from("agents")
      .select("id, created_at")
      .eq("brokerage_id", args.brokerageId)
      .eq("id", args.agentId)
      .maybeSingle(),
    db
      .from("brokerages")
      .select("id, created_at, default_cap_amount, default_cap_anniversary_basis")
      .eq("id", args.brokerageId)
      .maybeSingle(),
    db
      .from("agent_commission_profiles")
      .select("cap_amount, is_active, effective_date")
      .eq("brokerage_id", args.brokerageId)
      .eq("agent_id", args.agentId),
  ])

  if (agentRes.error) return { ok: false, error: `Could not read the agent record: ${agentRes.error.message}` }
  if (!agentRes.data) return { ok: false, error: "That agent does not exist in this brokerage." }
  if (brokerageRes.error) return { ok: false, error: `Could not read the brokerage settings: ${brokerageRes.error.message}` }
  if (!brokerageRes.data) return { ok: false, error: "That brokerage record could not be read." }
  if (profileRes.error) {
    return { ok: false, error: `Could not read the agent's commission profile: ${profileRes.error.message}` }
  }

  const brokerage = brokerageRes.data as unknown as {
    created_at: string | null
    default_cap_amount: unknown
    default_cap_anniversary_basis: unknown
  }
  const basis = normalizeCapAnniversaryBasis(brokerage.default_cap_anniversary_basis)

  const picked = pickCapAmount({
    explicitCapAmount: args.explicitCapAmount ?? null,
    profiles: (profileRes.data ?? []) as unknown as CommissionProfileCapRow[],
    brokerageDefaultCap: brokerage.default_cap_amount,
    today,
  })

  // The ledger row that exists is the authority — it carries collections. Report
  // it and stop, but report the RESOLVED source too so a caller can see when the
  // configured answer and the live ledger disagree.
  const existingRow = (existing ?? [])[0] as { id: string } | undefined
  if (existingRow) {
    return {
      ok: true,
      result: {
        outcome: "already_covered",
        capAmount: numOrNull((existing ?? [])[0]?.cap_amount),
        source: picked.source,
        basis,
        window: null,
        trackingId: existingRow.id,
      },
    }
  }

  if (picked.capAmount === null) {
    return {
      ok: true,
      result: { outcome: "no_cap_configured", capAmount: null, source: "none", basis, window: null, trackingId: null },
    }
  }
  if (picked.capAmount < 0) {
    return { ok: false, error: `A cap cannot be negative — ${picked.capAmount} was configured.` }
  }

  // ── 3. Which window? ──────────────────────────────────────────────────────
  const win = resolveAnniversaryWindow({
    basis,
    today,
    agentCreatedAt: (agentRes.data as unknown as { created_at: string | null }).created_at,
    brokerageCreatedAt: brokerage.created_at,
  })
  if (!win.ok) return { ok: false, error: win.error }

  // Belt and braces. The construction above cannot produce a window that misses
  // today, but a row stage 07 cannot find is the whole defect this module
  // exists to end, so it is checked rather than assumed.
  if (!windowContains(win.window, today)) {
    return {
      ok: false,
      error: `Refusing to write a cap window (${win.window.start} → ${win.window.end}) that does not contain today (${today}) — the commission engine would never find it.`,
    }
  }

  // ── 4. Write it, and PROVE it landed. ─────────────────────────────────────
  // `agent_cap_tracking` has no `updated_at` column on the live schema, so none
  // is written. `cap_paid_to_date` starts at 0: this is a NEW window, and the
  // engine advances it from here.
  const { data: written, error: writeErr } = await db
    .from("agent_cap_tracking")
    .insert({
      brokerage_id: args.brokerageId,
      agent_id: args.agentId,
      anniversary_start: win.window.start,
      anniversary_end: win.window.end,
      cap_amount: picked.capAmount,
      cap_paid_to_date: 0,
      is_capped: false,
    })
    .select("id")

  if (writeErr) return { ok: false, error: `Could not write the agent's cap ledger row: ${writeErr.message}` }
  if (!written || written.length === 0) {
    // supabase-js RESOLVES a refused write: an RLS refusal on INSERT arrives as
    // zero rows with `error: null`. Without this check the caller would report a
    // cap that was never stored — the same silence that hid the original defect.
    return {
      ok: false,
      error:
        "The database accepted the request but stored no cap row, so the cap is still not enforced. Only a broker or admin on this brokerage can write the cap ledger.",
    }
  }

  return {
    ok: true,
    result: {
      outcome: "seeded",
      capAmount: picked.capAmount,
      source: picked.source,
      basis,
      window: { start: win.window.start, end: win.window.end },
      trackingId: (written[0] as { id: string }).id,
    },
  }
}

// ── The TEAM seeder ──────────────────────────────────────────────────────────

export interface TeamCapSeedResult {
  /** `teams.cap_amount` as resolved. NULL = the team is uncapped and no row is written. */
  capAmount: number | null
  /** Agents on the team that were considered. */
  agentsConsidered: number
  /** Ledger rows written by this call. */
  seeded: number
  /** Agents that already had a window covering today — never overwritten. */
  alreadyCovered: number
  /** Per-agent failures, as sentences. Non-empty means the cap is only PARTLY enforced. */
  errors: string[]
}

/**
 * MATERIALISE the TEAM's cap into `team_cap_tracking`, one row per agent on the
 * team, for the anniversary window that contains today.
 *
 * ══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
 *
 * This is the m461 defect one level down, and `lib/commission/team-lead-split.ts`
 * says so in its own header: "a cap configured on the `teams` row with no
 * team_cap_tracking row covering today is NOT enforced — the engine reads the
 * ledger, so an unseeded cap is an unenforced cap."
 *
 * Stage 08 reads `team_cap_tracking` and nothing else. Without this function a
 * team lead could type a ceiling into settings, watch it save, and have the
 * waterfall keep collecting past it for ever — the same silence that let four
 * agents carry a cap the payout engine had never once applied.
 *
 * ══ THE GRAIN IS agents.team_id, NOT team_members ═══════════════════════════
 *
 * MEASURED against the consumer rather than guessed: `resolveTeamLeadAgreement`
 * in waterfall/08-team-split.ts finds the team by reading `agents.team_id` for
 * the deal's agent. `team_members` drives a DIFFERENT thing in the same stage —
 * per-member `split_percent` payouts to individual agents, which are not the
 * team's take and are outside this ceiling. Seeding on `team_members` would
 * therefore write rows for pairs the cap logic never looks up, and miss the ones
 * it does.
 *
 * ══ WHY THE CALLER MUST PASS A SERVICE CLIENT ═══════════════════════════════
 *
 * `team_cap_tracking`'s INSERT policy (m461) admits brokerage admins only —
 * deliberately, because it is a money ledger and a team lead editing their own
 * collections counter is exactly what that policy exists to stop. But a team
 * lead IS allowed to set their team's cap, and this seeding is a CONSEQUENCE of
 * that already-authorised act rather than a ledger edit in its own right. So the
 * authorisation happens where it belongs — `resolveWritableTeamId` in
 * app/actions/team-branding.ts, which lets a lead reach only their own team —
 * and the write goes on the service client, the same shape `createAgent` uses
 * for `ensureAgentCapWindow`. A session client would be refused here with zero
 * rows and `error: null`, which is silence, and silence is the defect.
 *
 * ══ WHAT IT WILL NOT DO ═════════════════════════════════════════════════════
 *
 * It never UPDATES a window that already covers today. `cap_paid_to_date` on a
 * live row is money the team has already collected, advanced by stage 11 on each
 * disbursement; moving the ceiling under a half-run year, or resetting the
 * counter, is a deliberate administrative correction and not a side effect of
 * somebody saving a settings form. A lead who lowers the cap mid-year changes
 * NEXT year's rows, and this reports how many were left alone so the surface can
 * say that rather than imply otherwise.
 *
 * ══ MEASURED — the queries below, replayed against the live database ════════
 *
 * Run on VIP Premier Realty's team, on a throwaway cap, everything restored
 * afterwards (team_cap_tracking back to 0 rows, teams.cap_amount back to NULL):
 *
 *   agents on the team, via agents.team_id ................... 1
 *   teams.cap_amount NULL → rows written .................... 0 (short-circuits)
 *   anniversary basis, read from the brokerage .............. agent_start_date
 *   with a cap set: seeded / already covered ................ 1 / 0
 *   seeded windows that CONTAIN TODAY ....................... 1 of 1
 *   a second pass ........................................... 0 new (all covered)
 *   overlapping windows for one (team, agent) ............... 0
 *   residue after cleanup ................................... 0
 *
 * The last two are the ones worth having. A window that does not contain today
 * is a row stage 08 can never match — indistinguishable from the unseeded cap
 * this function exists to prevent. And overlapping windows would make stage 08's
 * `.maybeSingle()` THROW rather than pick, turning an unenforced cap into a
 * crashed commission calculation; `end = start + 1 year − 1 day` is what keeps
 * consecutive windows from sharing a seam day.
 */
export async function ensureTeamCapWindows(
  db: SupabaseClient,
  args: {
    teamId: string
    brokerageId: string
    /** YYYY-MM-DD. Defaults to today — injectable so the arithmetic is testable. */
    today?: string
  },
): Promise<{ ok: true; result: TeamCapSeedResult } | { ok: false; error: string }> {
  const today = parseCapDate(args.today ?? new Date().toISOString().slice(0, 10))
  if (!today) return { ok: false, error: `"${String(args.today)}" is not a calendar date.` }

  const empty: TeamCapSeedResult = {
    capAmount: null, agentsConsidered: 0, seeded: 0, alreadyCovered: 0, errors: [],
  }

  // TENANT-SCOPED: the team is filtered by brokerage_id as well as id, so a team
  // id from another tenant resolves to nothing rather than to a row.
  const { data: team, error: teamErr } = await db
    .from("teams")
    .select("id, cap_amount")
    .eq("id", args.teamId)
    .eq("brokerage_id", args.brokerageId)
    .maybeSingle()
  if (teamErr) return { ok: false, error: `Could not read the team: ${teamErr.message}` }
  if (!team) return { ok: false, error: "That team does not exist in this brokerage." }

  const capAmount = numOrNull((team as unknown as { cap_amount: unknown }).cap_amount)
  // NULL is UNCAPPED, which is what every team was before m461, and it is a real
  // answer rather than a missing one. No rows are written and, deliberately, no
  // existing rows are deleted: this year's ledger records what was already
  // collected under the ceiling that was in force when it was collected.
  if (capAmount === null) return { ok: true, result: empty }
  if (capAmount < 0) return { ok: false, error: `A cap cannot be negative — ${capAmount} was configured.` }

  const { data: brokerage, error: brokerageErr } = await db
    .from("brokerages")
    .select("id, created_at, default_cap_anniversary_basis")
    .eq("id", args.brokerageId)
    .maybeSingle()
  if (brokerageErr) return { ok: false, error: `Could not read the brokerage settings: ${brokerageErr.message}` }
  if (!brokerage) return { ok: false, error: "That brokerage record could not be read." }

  // The TEAM cap resets on the same schedule as the brokerage cap. One notion of
  // "the year" across both levels: a team year that drifted from the brokerage
  // year would make "how much is left" mean two different things on one deal.
  const brokerageRow = brokerage as unknown as { created_at: string | null; default_cap_anniversary_basis: unknown }
  const basis = normalizeCapAnniversaryBasis(brokerageRow.default_cap_anniversary_basis)

  const { data: agentRows, error: agentsErr } = await db
    .from("agents")
    .select("id, created_at")
    .eq("brokerage_id", args.brokerageId)
    .eq("team_id", args.teamId)
  if (agentsErr) return { ok: false, error: `Could not read the team's agents: ${agentsErr.message}` }

  const agents = (agentRows ?? []) as unknown as Array<{ id: string; created_at: string | null }>
  const result: TeamCapSeedResult = {
    capAmount, agentsConsidered: agents.length, seeded: 0, alreadyCovered: 0, errors: [],
  }
  if (agents.length === 0) return { ok: true, result }

  // One read for the whole team rather than one per agent: the answer is "which
  // of these agents already has a live window", and that is a single question.
  const { data: liveRows, error: liveErr } = await db
    .from("team_cap_tracking")
    .select("agent_id")
    .eq("brokerage_id", args.brokerageId)
    .eq("team_id", args.teamId)
    .lte("anniversary_start", today)
    .gte("anniversary_end", today)
  if (liveErr) return { ok: false, error: `Could not read the team cap ledger: ${liveErr.message}` }
  const covered = new Set(((liveRows ?? []) as unknown as Array<{ agent_id: string }>).map((r) => r.agent_id))

  for (const agent of agents) {
    if (covered.has(agent.id)) { result.alreadyCovered += 1; continue }

    const win = resolveAnniversaryWindow({
      basis, today, agentCreatedAt: agent.created_at, brokerageCreatedAt: brokerageRow.created_at,
    })
    if (!win.ok) { result.errors.push(`${agent.id}: ${win.error}`); continue }
    // Belt and braces, for the same reason ensureAgentCapWindow checks it: a row
    // the engine cannot find is indistinguishable from no row at all, and looks
    // like the problem was fixed.
    if (!windowContains(win.window, today)) {
      result.errors.push(
        `${agent.id}: refusing to write a cap window (${win.window.start} → ${win.window.end}) that does not contain today (${today}).`,
      )
      continue
    }

    const { data: written, error: writeErr } = await db
      .from("team_cap_tracking")
      .insert({
        brokerage_id: args.brokerageId,
        team_id: args.teamId,
        agent_id: agent.id,
        anniversary_start: win.window.start,
        anniversary_end: win.window.end,
        cap_amount: capAmount,
        cap_paid_to_date: 0,
        is_capped: false,
      })
      .select("id")

    if (writeErr) {
      // 23505 = team_cap_tracking_agent_window_key. A concurrent writer got there
      // first, so the row exists exactly once — the outcome wanted, not a failure.
      if (String((writeErr as { code?: string }).code) === "23505") { result.alreadyCovered += 1; continue }
      result.errors.push(`${agent.id}: ${writeErr.message}`)
      continue
    }
    // A refused INSERT arrives as zero rows with error:null. Counting it as
    // seeded would report a ceiling that is not in force.
    if (!written || written.length === 0) {
      result.errors.push(`${agent.id}: the database stored no cap row, so the team cap is not enforced for them.`)
      continue
    }
    result.seeded += 1
  }

  return { ok: true, result }
}
