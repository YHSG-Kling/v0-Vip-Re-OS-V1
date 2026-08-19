#!/usr/bin/env tsx
/**
 * scripts/commission-cap-consolidation-simulator.ts  (npm run test:commission-cap)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves that a COMMISSION CAP set anywhere in this app reaches the one table
 * the payout engine reads — and that the arithmetic which puts it there cannot
 * produce a row the engine will never find.
 *
 * ══ THE DEFECT ══════════════════════════════════════════════════════════════
 *
 * A cap is a CEILING ON WHAT AN ENTITY COLLECTS from an agent per anniversary
 * year. `lib/commission/waterfall/07-apply-cap.ts` reads exactly one table for
 * it — `agent_cap_tracking` — filtered `anniversary_start <= today AND
 * anniversary_end >= today`, and returns capStatus 'n/a' when it finds nothing.
 *
 * THREE places stored an agent's cap:
 *
 *   agent_cap_tracking.cap_amount        the LEDGER. Canonical, and the only one
 *                                        the engine has ever read.
 *   agent_commission_profiles.cap_amount the per-agent configured override
 *   agents.cap_amount / cap_progress     a third copy
 *
 * MEASURED on the live database before m461: four agents carried
 * `agents.cap_amount` and THREE had NO ledger row at all. A broker set a cap,
 * every screen showed it, and the engine had never once enforced it. The fourth
 * disagreed with itself — agents.cap_amount 100,000 against a ledger row saying
 * 80,000 with 72,500 collected.
 *
 * TWO THINGS THIS PROVES, because either alone would leave the bug in place:
 *
 *   RESOLUTION — a cap configured at any level resolves to ONE number, with a
 *     stated precedence (per-agent override → brokerage default → none).
 *   MATERIALISATION — that number lands in the ledger inside a window that
 *     CONTAINS TODAY. A window anchored naively on the join date has already
 *     closed for any agent older than a year: a row that exists, is never
 *     matched, and is indistinguishable from the bug being fixed.
 *
 * PURE: the precedence and the anniversary arithmetic, asserted directly.
 * SOURCE: the settings writers are gated and allow-listed, the seeder proves its
 *         write landed, and the dead columns are no longer written or read.
 * NEGATIVE CONTROLS: every check is re-run against a deliberately broken
 *         implementation (pure) or a deliberately broken copy of the file
 *         (source), and must go RED.
 * LIVE (creds-gated): m461 is in the DATABASE, not merely on disk.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { stripComments as canonicalStripComments } from "./strip-comments"
import {
  pickCapAmount,
  resolveAnniversaryWindow,
  windowContains,
  parseCapAmountInput,
  normalizeCapAnniversaryBasis,
  CAP_ANNIVERSARY_BASES,
  DEFAULT_CAP_ANNIVERSARY_BASIS,
  type CommissionProfileCapRow,
} from "../lib/commission/cap-resolver"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const RESOLVER = "lib/commission/cap-resolver.ts"
const BROKERAGE = "app/actions/settings/brokerage-identity.ts"
const TEAM = "app/actions/team-branding.ts"
const AGENTS = "app/actions/agents.ts"
const AGENT360 = "app/actions/admin/agent-360.ts"
const SETTINGS_PAGE = "app/dashboard/settings/page.tsx"
const CDA_PAGE = "app/dashboard/transactions/[id]/cda/page.tsx"
const CDA_CLIENT = "app/dashboard/transactions/[id]/cda/cda-workflow-client.tsx"
const BROKERAGE_FIN = "app/dashboard/financials/brokerage/page.tsx"
const AGENT_FIN = "app/dashboard/financials/agent/page.tsx"
const AI_CHAT = "app/api/internal/ai-chat/route.ts"
const FORECASTER = "lib/kernel/commission-forecaster.ts"
const FORECASTER_SIM = "scripts/commission-forecaster-simulator.ts"
const RECRUITER_SIM = "scripts/recruiter-agent-management-simulator.ts"

// ─── Dates, derived from the real today so these stay true forever ───────────

const TODAY = new Date().toISOString().slice(0, 10)

/** Shift an ISO date by whole days, via UTC so no local offset can move it. */
function shiftDays(iso: string, days: number): string {
  const t = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10)
}

/** An agent who joined THREE AND A HALF YEARS AGO — the case a naive window
 *  gets wrong, and the case every established agent on a live tenant is in. */
const LONG_AGO = shiftDays(TODAY, -1278)
/** The same date as a timestamptz, which is what `agents.created_at` really is. */
const LONG_AGO_TS = `${LONG_AGO}T14:22:07.123456+00:00`

// ─── The kit, so a negative control can swap ONE function for a broken one ───

interface Kit {
  pick: typeof pickCapAmount
  window: typeof resolveAnniversaryWindow
  contains: typeof windowContains
  parse: typeof parseCapAmountInput
}

const REAL: Kit = {
  pick: pickCapAmount,
  window: resolveAnniversaryWindow,
  contains: windowContains,
  parse: parseCapAmountInput,
}

function profile(over: Partial<CommissionProfileCapRow>): CommissionProfileCapRow {
  return { cap_amount: null, is_active: true, effective_date: null, ...over }
}

// ─── PURE PROBES ─────────────────────────────────────────────────────────────

type PureProbe = { name: string; run: (k: Kit) => boolean }

const PURE_PROBES: PureProbe[] = [
  // ── Precedence ────────────────────────────────────────────────────────────
  {
    name: "R1 an in-force per-agent profile cap OUTRANKS the brokerage default",
    run: (k) => {
      const r = k.pick({
        profiles: [profile({ cap_amount: 80000, effective_date: "2020-01-01" })],
        brokerageDefaultCap: 150000,
        today: TODAY,
      })
      return r.capAmount === 80000 && r.source === "agent_profile"
    },
  },
  {
    name: "R2 the brokerage default applies when no profile cap qualifies",
    run: (k) => {
      const r = k.pick({ profiles: [], brokerageDefaultCap: "150000.00", today: TODAY })
      return r.capAmount === 150000 && r.source === "brokerage_default"
    },
  },
  {
    name: "R3 nothing configured anywhere resolves to NO CAP — not to zero",
    run: (k) => {
      const r = k.pick({ profiles: [], brokerageDefaultCap: null, today: TODAY })
      return r.capAmount === null && r.source === "none"
    },
  },
  {
    name: "R4 an INACTIVE profile row is ignored even though it carries a cap",
    run: (k) => {
      const r = k.pick({
        profiles: [profile({ cap_amount: 80000, is_active: false })],
        brokerageDefaultCap: 150000,
        today: TODAY,
      })
      return r.capAmount === 150000 && r.source === "brokerage_default"
    },
  },
  {
    name: "R5 a profile whose effective_date has NOT ARRIVED is ignored",
    run: (k) => {
      const r = k.pick({
        profiles: [profile({ cap_amount: 80000, effective_date: shiftDays(TODAY, 30) })],
        brokerageDefaultCap: 150000,
        today: TODAY,
      })
      return r.capAmount === 150000 && r.source === "brokerage_default"
    },
  },
  {
    name: "R6 among several in-force profiles the LATEST effective_date wins",
    run: (k) => {
      const r = k.pick({
        profiles: [
          profile({ cap_amount: 60000, effective_date: "2022-01-01" }),
          profile({ cap_amount: 95000, effective_date: shiftDays(TODAY, -10) }),
          profile({ cap_amount: 70000, effective_date: "2024-06-01" }),
        ],
        brokerageDefaultCap: 150000,
        today: TODAY,
      })
      return r.capAmount === 95000 && r.source === "agent_profile"
    },
  },
  {
    name: "R7 a NULL effective_date means 'from the start' and still counts",
    run: (k) => {
      const r = k.pick({
        profiles: [profile({ cap_amount: 42000, effective_date: null })],
        brokerageDefaultCap: 150000,
        today: TODAY,
      })
      return r.capAmount === 42000 && r.source === "agent_profile"
    },
  },
  {
    name: "R8 a cap named EXPLICITLY in the act outranks both configured levels",
    run: (k) => {
      const r = k.pick({
        explicitCapAmount: 25000,
        profiles: [profile({ cap_amount: 80000 })],
        brokerageDefaultCap: 150000,
        today: TODAY,
      })
      return r.capAmount === 25000 && r.source === "explicit"
    },
  },
  {
    name: "R9 a profile cap of 0 is a REAL answer ('collects nothing'), not 'unset' — it beats the default",
    run: (k) => {
      const r = k.pick({
        profiles: [profile({ cap_amount: 0 })],
        brokerageDefaultCap: 150000,
        today: TODAY,
      })
      return r.capAmount === 0 && r.source === "agent_profile"
    },
  },

  // ── The anniversary window ────────────────────────────────────────────────
  {
    name: "W1 an agent created THREE AND A HALF YEARS AGO gets a window that CONTAINS TODAY",
    run: (k) => {
      const w = k.window({ basis: "agent_start_date", today: TODAY, agentCreatedAt: LONG_AGO_TS })
      return w.ok && k.contains(w.window, TODAY)
    },
  },
  {
    name: "W2 …and the NAIVE window for that same agent (join date → +1y) does not — this is why the roll-forward exists",
    run: (k) => {
      // Not a claim about the module: a statement about the input, proving W1 is
      // testing something. If the naive window happened to contain today, W1
      // would pass for free.
      const naiveEnd = `${Number(LONG_AGO.slice(0, 4)) + 1}${LONG_AGO.slice(4)}`
      const w = k.window({ basis: "agent_start_date", today: TODAY, agentCreatedAt: LONG_AGO_TS })
      return !k.contains({ start: LONG_AGO, end: naiveEnd }, TODAY) && w.ok && w.window.yearsElapsed >= 3
    },
  },
  {
    name: "W3 the window is one year long MINUS A DAY, so consecutive windows do not share a seam day",
    run: (k) => {
      const w = k.window({ basis: "agent_start_date", today: TODAY, agentCreatedAt: LONG_AGO_TS })
      if (!w.ok) return false
      // Next year's window starts the day after this one ends: no date is in two
      // windows, which matters because stage 07 uses .maybeSingle() over an
      // inclusive range and THROWS on two matches.
      const nextStart = shiftDays(w.window.end, 1)
      const expectedNext = `${Number(w.window.start.slice(0, 4)) + 1}${w.window.start.slice(4)}`
      return nextStart === expectedNext
    },
  },
  {
    name: "W4 the CALENDAR-YEAR basis is 1 January → 31 December of today's year",
    run: (k) => {
      const w = k.window({ basis: "calendar_year", today: TODAY, agentCreatedAt: LONG_AGO_TS })
      const y = TODAY.slice(0, 4)
      return w.ok && w.window.start === `${y}-01-01` && w.window.end === `${y}-12-31` && k.contains(w.window, TODAY)
    },
  },
  {
    name: "W5 the BROKERAGE-FISCAL-YEAR basis anchors on the brokerage, not the agent",
    run: (k) => {
      const brokerageStart = shiftDays(TODAY, -900)
      const w = k.window({
        basis: "brokerage_fiscal_year",
        today: TODAY,
        agentCreatedAt: LONG_AGO_TS,
        brokerageCreatedAt: `${brokerageStart}T00:00:00Z`,
      })
      return w.ok
        && w.window.anchor === brokerageStart
        && w.window.anchor !== LONG_AGO
        && k.contains(w.window, TODAY)
    },
  },
  {
    name: "W6 a 29 FEBRUARY anchor clamps to 28 February in a non-leap year and still contains today",
    run: (k) => {
      const w = k.window({ basis: "agent_start_date", today: "2025-06-15", agentCreatedAt: "2024-02-29T09:00:00Z" })
      return w.ok && w.window.start === "2025-02-28" && k.contains(w.window, "2025-06-15")
    },
  },
  {
    name: "W7 an agent created TODAY gets a window that starts TODAY (year 0, not year -1)",
    run: (k) => {
      const w = k.window({ basis: "agent_start_date", today: TODAY, agentCreatedAt: `${TODAY}T11:00:00Z` })
      return w.ok && w.window.start === TODAY && w.window.yearsElapsed === 0 && k.contains(w.window, TODAY)
    },
  },
  {
    name: "W8 a created_at in the FUTURE is REFUSED rather than yielding a window the engine could never match",
    run: (k) => {
      const w = k.window({ basis: "agent_start_date", today: TODAY, agentCreatedAt: shiftDays(TODAY, 40) })
      return !w.ok
    },
  },
  {
    name: "W9 an unreadable anchor is refused — a missing created_at never becomes a guessed window",
    run: (k) => {
      const a = k.window({ basis: "agent_start_date", today: TODAY, agentCreatedAt: null })
      const b = k.window({ basis: "brokerage_fiscal_year", today: TODAY, brokerageCreatedAt: "not-a-date" })
      return !a.ok && !b.ok
    },
  },
  {
    name: "W10 the window survives stage 07's OWN filter across every basis — start <= today <= end",
    run: (k) => {
      return CAP_ANNIVERSARY_BASES.every((basis) => {
        const w = k.window({
          basis,
          today: TODAY,
          agentCreatedAt: LONG_AGO_TS,
          brokerageCreatedAt: `${shiftDays(TODAY, -2000)}T00:00:00Z`,
        })
        return w.ok && w.window.start <= TODAY && TODAY <= w.window.end
      })
    },
  },

  // ── Money ─────────────────────────────────────────────────────────────────
  {
    name: "M1 a THIRD decimal place is REFUSED, never silently rounded — numeric(12,2)",
    run: (k) => {
      const r = k.parse("100000.125", "Cap")
      return !r.ok && /decimal/i.test(r.error)
    },
  },
  {
    name: "M2 blank means UNCAPPED (null) and '0' means COLLECTS NOTHING (0) — two different facts",
    run: (k) => {
      const blank = k.parse("", "Cap")
      const zero = k.parse("0", "Cap")
      return blank.ok && blank.value === null && zero.ok && zero.value === 0
    },
  },
  {
    name: "M3 shapes that survive Number() but do not belong in a money column are refused",
    run: (k) =>
      ["1e5", "0x10", "Infinity", "-5000", "abc"].every((s) => !k.parse(s, "Cap").ok),
  },
  {
    name: "M4 a cap typed the way a human types it — $120,000.50 — is accepted exactly",
    run: (k) => {
      const r = k.parse("$120,000.50", "Cap")
      return r.ok && r.value === 120000.5
    },
  },
  {
    name: "M5 the basis normalizer admits exactly the three values the live CHECK constraint admits",
    run: () =>
      CAP_ANNIVERSARY_BASES.every((b) => normalizeCapAnniversaryBasis(b) === b)
      && normalizeCapAnniversaryBasis("quarterly") === DEFAULT_CAP_ANNIVERSARY_BASIS
      && normalizeCapAnniversaryBasis(null) === DEFAULT_CAP_ANNIVERSARY_BASIS
      && DEFAULT_CAP_ANNIVERSARY_BASIS === "agent_start_date",
  },
]

// ─── SOURCE PROBES ───────────────────────────────────────────────────────────

/**
 * CODE ONLY, comments removed. Several checks below assert that a name does NOT
 * appear — and this file's own prose names the very columns it is banning
 * ("agents.start_date DOES NOT EXIST", "cap_progress IS NO LONGER WRITTEN"). A
 * check satisfied by a comment is a check that would stay green while the code
 * underneath it did the wrong thing, so the comments are removed first.
 */
function stripComments(source: string): string {
  return canonicalStripComments(source)
}

/** One function body only, so a match elsewhere in the file cannot pass a check
 *  written for it. */
function body(source: string, signature: string): string {
  const start = source.indexOf(signature)
  if (start < 0) return ""
  const next = source.indexOf("\nexport ", start + signature.length)
  return source.slice(start, next < 0 ? source.length : next)
}

interface Sources {
  resolver: string
  brokerage: string
  team: string
  agents: string
  agent360: string
  settingsPage: string
  /** The four surfaces that read a cap OUTSIDE settings and admin. */
  cdaPage: string
  cdaClient: string
  brokerageFinancials: string
  agentFinancials: string
  aiChat: string
  forecaster: string
  /** The two live simulators that CONFIGURE a cap to test with. */
  forecasterSim: string
  recruiterSim: string
}

type SourceProbe = { name: string; run: (s: Sources) => boolean }

const SOURCE_PROBES: SourceProbe[] = [
  {
    name: "S1 the brokerage writer ALLOW-LISTS the two cap columns and still forbids plan_tier / slug / billing_metadata",
    run: (s) =>
      /BROKERAGE_CAP_FIELDS\s*=\s*\[[\s\S]*?'default_cap_amount'[\s\S]*?'default_cap_anniversary_basis'[\s\S]*?\]/.test(s.brokerage)
      && /BROKERAGE_WRITABLE_FIELDS\s*=\s*\[\s*\.\.\.BROKERAGE_IDENTITY_FIELDS,\s*\.\.\.BROKERAGE_CAP_FIELDS,?\s*\]/.test(s.brokerage)
      && /BROKERAGE_IDENTITY_FORBIDDEN_FIELDS\s*=\s*\[[\s\S]*?'plan_tier'[\s\S]*?'billing_metadata'[\s\S]*?\]/.test(s.brokerage)
      && /const smuggled = BROKERAGE_IDENTITY_FORBIDDEN_FIELDS\.filter/.test(s.brokerage),
  },
  {
    name: "S2 the cap is written through the SAME role gate as the licence — canEdit, from the session, never from the wire",
    run: (s) => {
      const b = body(s.brokerage, "export async function updateBrokerageIdentity")
      return /const \{ supabase, brokerageId, canEdit, error: sessionError \} = await resolveSessionBrokerage\(\)/.test(b)
        && /if \(!canEdit\)/.test(b)
        // Keyed to canEdit being resolved from the SESSION through the one roster
        // module, not to the identifier. The gate has been renamed twice since this
        // line was written (the admin-vocabulary consolidation, then m472 moving the
        // brokerage row onto the finance tier because it carries default_cap_amount
        // — this very cap) and each rename read as a regression.
        && /from\s+["']@\/lib\/auth\/resolve-user-role["']/.test(s.brokerage)
        && /canEdit: (isBrokerageFinanceAdmin\(|isAdminOrBroker\(|\w+\.is(Finance|Tenant)Admin\b)/.test(s.brokerage)
        // The brokerage id comes from users.brokerage_id for auth.uid(), never a payload field.
        && !/brokerageId = \(?input/.test(b)
    },
  },
  {
    name: "S3 the brokerage cap UPDATE proves it landed — .select('id') plus a length check, because an RLS refusal is error:null",
    run: (s) => {
      const b = body(s.brokerage, "export async function updateBrokerageIdentity")
      return /\.update\(\{ \.\.\.updates[\s\S]{0,120}?\.select\('id'\)/.test(b)
        && /if \(!saved \|\| saved\.length === 0\)/.test(b)
    },
  },
  {
    name: "S4 an unrecognised cap reset schedule is REFUSED, not silently defaulted into a different reset day",
    run: (s) => {
      const b = body(s.brokerage, "export async function updateBrokerageIdentity")
      return /CAP_ANNIVERSARY_BASES as readonly string\[\]\)\.includes\(rawBasis\)/.test(b)
        && /is not a cap reset schedule/.test(b)
    },
  },
  {
    name: "S5 the brokerage cap amount is parsed by the SHARED parser, so it cannot accept what the team cap refuses",
    run: (s) =>
      /parseCapAmountInput/.test(s.brokerage)
      && /from '@\/lib\/commission\/cap-resolver'/.test(s.brokerage)
      && /parseCapAmountInput/.test(s.team)
      && /from "@\/lib\/commission\/cap-resolver"/.test(s.team),
  },
  {
    name: "S6 the TEAM cap goes through resolveWritableTeamId — a lead may cap their own team and only their own",
    run: (s) => {
      const b = body(s.team, "export async function saveTeamSplits")
      return /const target = await resolveWritableTeamId\(g, input\.teamId, "set the splits for"\)/.test(b)
        && /if \(!target\.ok\) return \{ success: false, error: target\.error \}/.test(b)
        && /cap_amount: cap\.value/.test(b)
    },
  },
  {
    name: "S7 …and the team-cap write is confirmed — writeTeamRow counts affected rows rather than trusting a resolved promise",
    run: (s) => {
      const b = body(s.team, "export async function saveTeamSplits")
      const w = body(s.team, "async function writeTeamRow")
      return /const wrote = await writeTeamRow\(g, target\.teamId, patch\)/.test(b)
        && /if \(!wrote\.ok\) return \{ success: false, error: wrote\.error \}/.test(b)
        && /\.select\("id"\)/.test(w)
        && /written\.length === 0/.test(w)
    },
  },
  {
    name: "S8 the team cap is on the MONEY allow-list, and the brand writer still cannot reach it",
    run: (s) =>
      /TEAM_SPLIT_COLUMNS = \[[^\]]*"cap_amount",[^\]]*\] as const/.test(s.team)
      // `[^\]]*` and not `[\s\S]*?`: the lazy form walked straight past this
      // array's closing bracket into TEAM_SPLIT_COLUMNS below and reported the
      // brand list as carrying cap_amount when it does not.
      && !/TEAM_BRAND_COLUMNS = \[[^\]]*"cap_amount"[^\]]*\] as const/.test(s.team),
  },
  {
    name: "S9 agent creation NO LONGER writes agents.cap_amount or agents.cap_progress",
    run: (s) => {
      const b = body(s.agents, "export async function createAgent")
      return !/cap_amount:\s*agentData\.cap_amount/.test(b) && !/cap_progress:\s*0/.test(b)
    },
  },
  {
    name: "S10 agent creation SEEDS THE LEDGER instead — the number it sets is the number the engine enforces",
    run: (s) => {
      const b = body(s.agents, "export async function createAgent")
      return /await ensureAgentCapWindow\(svc, \{/.test(b)
        && /explicitCapAmount: agentData\.cap_amount/.test(b)
        && /brokerageId: ctx\.brokerageId/.test(b)
        && /import \{ ensureAgentCapWindow \} from "@\/lib\/commission\/cap-resolver"/.test(s.agents)
    },
  },
  {
    name: "S11 nothing else in agents.ts feeds the dead columns — the YTD ratchet stopped writing cap_progress",
    run: (s) => {
      const code = stripComments(s.agents)
      // `cap_progress: _dropped…` is the DEFENSIVE DESTRUCTURE in updateAgent
      // that strips the column out of a caller-supplied spread — the opposite of
      // a write, so it is the one spelling allowed.
      // The lookahead sits INSIDE the whitespace class on purpose: `\s*(?!…)`
      // backtracks to zero-width and then succeeds against the space itself,
      // which made this check pass for free.
      return !/cap_progress:(?!\s*_dropped)/.test(code)
        && !/\.select\("[^"]*cap_(?:amount|progress)[^"]*"\)/.test(code)
    },
  },
  {
    name: "S12 agent-360 reads the CANONICAL LEDGER with stage 07's own window filter",
    run: (s) =>
      /\.from\("agent_cap_tracking"\)[\s\S]{0,400}?\.eq\("brokerage_id", caller\.brokerage_id\)[\s\S]{0,200}?\.lte\("anniversary_start", today\)[\s\S]{0,120}?\.gte\("anniversary_end", today\)/.test(s.agent360)
      && /capProgress: capPaid/.test(s.agent360)
      && /capAmount: capAmount/.test(s.agent360),
  },
  {
    name: "S13 …and agent-360 no longer SELECTS the dead columns at all",
    run: (s) => {
      // Comment lines may sit between the .from() and its .select(), so the
      // window is a bounded any-character span rather than one newline.
      const sel = /\.from\("agents"\)[\s\S]{0,400}?\.select\("([^"]*)"\)/.exec(s.agent360)
      return !!sel && !/cap_progress/.test(sel[1]) && !/cap_amount/.test(sel[1])
    },
  },
  {
    name: "S14 the settings panel's cap is no longer a hardcoded null — it reads brokerages.default_cap_amount",
    run: (s) =>
      !/capAmount: null/.test(s.settingsPage)
      && /\.select\("plan_tier, billing_metadata, default_cap_amount, default_cap_anniversary_basis"\)/.test(s.settingsPage)
      && /capAmount: parsedDefaultCap/.test(s.settingsPage),
  },
  {
    name: "S15 the seeder PROVES its insert landed — a zero-row RLS refusal arrives as error:null",
    run: (s) => {
      const b = body(s.resolver, "export async function ensureAgentCapWindow")
      return /\.from\("agent_cap_tracking"\)\s*\n\s*\.insert\(\{/.test(b)
        && /\.select\("id"\)/.test(b)
        && /if \(!written \|\| written\.length === 0\)/.test(b)
    },
  },
  {
    name: "S16 every read in the seeder destructures and checks its error — a refusal never reads as 'no cap'",
    run: (s) => {
      const b = body(s.resolver, "export async function ensureAgentCapWindow")
      return /const \{ data: existing, error: existingErr \}/.test(b)
        && /if \(existingErr\)/.test(b)
        && /if \(agentRes\.error\)/.test(b)
        && /if \(brokerageRes\.error\)/.test(b)
        && /if \(profileRes\.error\)/.test(b)
    },
  },
  {
    name: "S17 the seeder REFUSES a window that does not contain today rather than writing a row the engine cannot find",
    run: (s) => {
      const b = body(s.resolver, "export async function ensureAgentCapWindow")
      return /if \(!windowContains\(win\.window, today\)\)/.test(b)
        && /would never find it/.test(b)
    },
  },
  {
    name: "S18 the seeder never overwrites a LIVE window — cap_paid_to_date is money already collected",
    run: (s) => {
      const b = body(s.resolver, "export async function ensureAgentCapWindow")
      return /outcome: "already_covered"/.test(b)
        && !/\.from\("agent_cap_tracking"\)\s*\n\s*\.update\(/.test(b)
    },
  },
  {
    name: "S19 the seeder is TENANT-SCOPED on every read and stamps brokerage_id on the write",
    run: (s) => {
      const b = body(s.resolver, "export async function ensureAgentCapWindow")
      return /\.from\("agents"\)\s*\n\s*\.select\([^)]*\)\s*\n\s*\.eq\("brokerage_id", args\.brokerageId\)/.test(b)
        && /\.from\("agent_commission_profiles"\)[\s\S]{0,200}?\.eq\("brokerage_id", args\.brokerageId\)/.test(b)
        && /\.insert\(\{\s*\n\s*brokerage_id: args\.brokerageId,/.test(b)
    },
  },
  {
    name: "S20 the PHANTOM COLUMN is not reintroduced — nothing in the resolver reads agents.start_date",
    run: (s) =>
      // The CODE must never name it; the PROSE must still warn about it, so the
      // reason it is absent survives the next person who reads this file.
      // `agent_start_date` is the name of an anniversary BASIS (a value of the
      // live CHECK constraint) and is legitimate; it is masked out first so the
      // ban lands on the COLUMN and nothing else.
      !/start_date/.test(stripComments(s.resolver).replace(/agent_start_date/g, "ANNIVERSARY_BASIS"))
      && /agents\.start_date` DOES NOT EXIST/.test(s.resolver)
      && /agentCreatedAt/.test(s.resolver),
  },
  {
    // ══ S21-S30: THE CAP SURFACES OUTSIDE SETTINGS, AND THE TEAM SEEDER ══════
    //
    // S1-S20 prove the cap RESOLVES and MATERIALISES. These prove that every
    // screen which SHOWS a cap reads the same ledger — because the failure that
    // hid this defect was never a wrong number in the engine, it was a plausible
    // number on a screen. Two of these surfaces were not merely stale: they
    // rendered `agents.cap_progress`, a 0-100 PERCENTAGE, through a currency
    // formatter, so a Commission Disbursement Authorization printed
    // "$43.00 / $100,000.00" for an agent 43% of the way to their cap.
    name: "S21 the CDA no longer selects the dead columns, and reads the ledger with stage 07's own window filter",
    run: (s) => {
      const c = stripComments(s.cdaPage)
      return !/cap_amount|cap_progress/.test(c.split('.from("agents")')[1]?.slice(0, 200) ?? "")
        && /\.from\("agent_cap_tracking"\)/.test(c)
        && /\.lte\("anniversary_start", todayIso\)/.test(c)
        && /\.gte\("anniversary_end", todayIso\)/.test(c)
        // A refused read must not read as "no cap" — the CDA is a money document.
        && /const \{ data: capRows, error: capError \}/.test(c)
        && /capUnavailable=\{!!capError\}/.test(c)
    },
  },
  {
    name: "S22 the CDA renders DOLLARS over DOLLARS, and tells a refused read apart from an absent cap",
    run: (s) => {
      const c = stripComments(s.cdaClient)
      return !/agent\?\.cap_progress|agent\?\.cap_amount/.test(c)
        && /formatCurrency\(agentCap\.capPaidToDate \?\? 0\)/.test(c)
        && /formatCurrency\(agentCap\.capAmount\)/.test(c)
        // three distinct states, not one indistinguishable "$0.00 / $0.00"
        && /capUnavailable \?/.test(c)
        && /agentCap\?\.capAmount == null \?/.test(c)
    },
  },
  {
    name: "S23 the brokerage cap card is computed from the ledger, not from a percentage multiplied back into dollars",
    run: (s) => {
      const c = stripComments(s.brokerageFinancials)
      return !/cap_progress/.test(c)
        && /\.from\("agent_cap_tracking"\)/.test(c)
        && /\.lte\("anniversary_start", todayIso\)/.test(c)
        && /capByAgent/.test(c)
        // "Cap Revenue" is now collected dollars, clamped at the cap
        && /Math\.min\(c\.paid, c\.amount\)/.test(c)
        && /const \{ data: capRows, error: capRowsError \}/.test(c)
    },
  },
  {
    name: "S24 the impossible post-cap threshold is gone — a clamped percentage could never exceed 100, so that card always read zero",
    run: (s) => {
      const c = stripComments(s.brokerageFinancials)
      return !/>=\s*101/.test(c)
        && /capSummary\.atCap > capSummary\.totalAgents \* 0\.3/.test(c)
        // the genuinely distinct third state: no cap configured at all
        && /uncapped: agents\.filter/.test(c)
        && /capSummary\.uncapped/.test(c)
    },
  },
  {
    name: "S25 the agent cap bar has NO dollars-vs-percent fallback left — one source, and it is the ledger",
    run: (s) => {
      const c = stripComments(s.agentFinancials)
      return !/agentData\?\.cap_progress/.test(c)
        && !/agentData\?\.cap_amount/.test(c)
        && /capAmount=\{capTracking\?\.cap_amount \?\? null\}/.test(c)
        && /capProgress=\{capTracking\?\.cap_paid_to_date \?\? 0\}/.test(c)
    },
  },
  {
    name: "S26 the broker's AI context no longer carries a stale, mis-scaled cap figure",
    run: (s) => !/cap_progress/.test(stripComments(s.aiChat)),
  },
  {
    name: "S27 the forecaster's cap precedence is no longer INVERTED — it reads the ledger and never the agents row",
    run: (s) => {
      const b = body(s.forecaster, "async function resolveCap")
      return b.length > 0
        && !/from\("agents"\)/.test(b)
        && /\.from\("agent_cap_tracking"\)/.test(b)
        && /\.lte\("anniversary_start", today\)/.test(b)
        && /\.gte\("anniversary_end", today\)/.test(b)
        // a refused read must not become "uncapped"
        && /const \{ data: track, error \} =/.test(b)
        && /if \(error\) return null/.test(b)
    },
  },
  {
    name: "S28 both live simulators CONFIGURE their cap in the ledger, and clean up after themselves",
    run: (s) => {
      const ok = (c: string) =>
        !/from\("agents"\)\.update\(\{ cap_amount/.test(c)
        && /\.from\("agent_cap_tracking"\)/.test(c)
        && /borrowedCapRowId/.test(c)
        && /seededCapRowId/.test(c)
        // a borrowed window is RESTORED, never deleted — its cap_paid_to_date is
        // real collections history
        && /\.from\("agent_cap_tracking"\)\.update\(\{ cap_amount: savedCap \?\? null \}\)/.test(c)
        && /the seeded cap ledger row is gone/.test(c)
      return ok(stripComments(s.forecasterSim)) && ok(stripComments(s.recruiterSim))
    },
  },
  {
    name: "S29 the TEAM cap opens its ledger — a ceiling with no team_cap_tracking row is a ceiling stage 08 never applies",
    run: (s) => {
      const b = body(s.resolver, "export async function ensureTeamCapWindows")
      return b.length > 0
        // the grain is agents.team_id, which is what resolveTeamLeadAgreement reads
        && /\.from\("agents"\)[\s\S]{0,160}?\.eq\("team_id", args\.teamId\)/.test(b)
        && /\.from\("team_cap_tracking"\)[\s\S]{0,300}?\.insert\(\{/.test(b)
        // NULL cap is UNCAPPED and writes nothing
        && /if \(capAmount === null\) return \{ ok: true, result: empty \}/.test(b)
        // never overwrite a live window: cap_paid_to_date is money collected
        && !/\.from\("team_cap_tracking"\)[\s\S]{0,200}?\.update\(/.test(b)
        // a zero-row RLS refusal arrives as error:null
        && /if \(!written \|\| written\.length === 0\)/.test(b)
        && /String\(\(writeErr as \{ code\?: string \}\)\.code\) === "23505"/.test(b)
    },
  },
  {
    name: "S30 saveTeamSplits CALLS the team seeder and reports whether the cap is actually in force",
    run: (s) => {
      const b = body(s.team, "export async function saveTeamSplits")
      return /ensureTeamCapWindows\(/.test(b)
        && /createServiceClient\(\)/.test(b)
        && /brokerageId: g\.brokerageId/.test(b)
        // saved != enforced, and the caller is told which
        && /capLedger/.test(b)
        && /capLedger\?: \{/.test(s.team)
    },
  },
]

// ─── NEGATIVE CONTROLS ───────────────────────────────────────────────────────
// A check that cannot go red is not a check. Each entry below reintroduces
// exactly one real defect — as a broken IMPLEMENTATION for the pure probes, and
// as a broken COPY OF THE FILE for the source probes.

/** The window as it would be WITHOUT the roll-forward — the defect m461's
 *  backfill nearly shipped. */
const naiveWindow: Kit["window"] = (input) => {
  const raw = typeof input.agentCreatedAt === "string" ? input.agentCreatedAt.slice(0, 10) : null
  if (input.basis === "calendar_year") {
    const y = input.today.slice(0, 4)
    return { ok: true, window: { start: `${y}-01-01`, end: `${y}-12-31`, anchor: `${y}-01-01`, yearsElapsed: 0 } }
  }
  if (!raw) return { ok: false, error: "no anchor" }
  return {
    ok: true,
    window: { start: raw, end: `${Number(raw.slice(0, 4)) + 1}${raw.slice(4)}`, anchor: raw, yearsElapsed: 0 },
  }
}

/** The window with an OVERLAPPING seam — end = start + 1 year, so one day a year
 *  matches two rows and stage 07's .maybeSingle() throws. */
const seamWindow: Kit["window"] = (input) => {
  const w = resolveAnniversaryWindow(input)
  if (!w.ok) return w
  const end = `${Number(w.window.start.slice(0, 4)) + 1}${w.window.start.slice(4)}`
  return { ok: true, window: { ...w.window, end } }
}

/** A window that anchors the brokerage's own year on the AGENT's join date. */
const agentAnchoredFiscal: Kit["window"] = (input) =>
  resolveAnniversaryWindow({ ...input, brokerageCreatedAt: input.agentCreatedAt })

/** A future created_at silently clamped instead of refused. */
const clampingWindow: Kit["window"] = (input) => {
  const w = resolveAnniversaryWindow(input)
  if (w.ok) return w
  return { ok: true, window: { start: input.today, end: input.today, anchor: input.today, yearsElapsed: 0 } }
}

/** Precedence that ignores is_active. */
const ignoresActive: Kit["pick"] = (input) => {
  const withCap = input.profiles.filter((p) => p.cap_amount !== null && p.cap_amount !== undefined)
  if (withCap.length) return { capAmount: Number(withCap[0].cap_amount), source: "agent_profile" }
  return pickCapAmount({ ...input, profiles: [] })
}

/** Precedence that ignores effective_date. */
const ignoresEffectiveDate: Kit["pick"] = (input) =>
  pickCapAmount({ ...input, profiles: input.profiles.map((p) => ({ ...p, effective_date: null })) })

/** Precedence inverted — the brokerage default beating the per-agent override. */
const brokerageFirst: Kit["pick"] = (input) => {
  const d = input.brokerageDefaultCap
  if (d !== null && d !== undefined && d !== "") return { capAmount: Number(d), source: "brokerage_default" }
  return pickCapAmount({ ...input, brokerageDefaultCap: null })
}

/** Precedence that treats a configured 0 as "unset". */
const zeroIsUnset: Kit["pick"] = (input) =>
  pickCapAmount({ ...input, profiles: input.profiles.filter((p) => Number(p.cap_amount) !== 0) })

/** A parser that ROUNDS money instead of refusing it. */
const roundingParse: Kit["parse"] = (raw, label) => {
  const r = parseCapAmountInput(raw, label)
  if (r.ok) return r
  const n = Number(String(raw).replace(/[$,]/g, ""))
  return Number.isFinite(n) ? { ok: true, value: Math.round(n * 100) / 100 } : r
}

/** A parser where blank collapses into 0 — "no cap" becoming "collects nothing". */
const blankIsZeroParse: Kit["parse"] = (raw, label) => {
  const r = parseCapAmountInput(raw, label)
  return r.ok && r.value === null ? { ok: true, value: 0 } : r
}

/** stage 07's filter, mis-stated as start-only. */
const looseContains: Kit["contains"] = (w, today) => w.start <= today

const PURE_MUTATIONS: Array<{ name: string; probes: string[]; kit: Kit }> = [
  { name: "the anniversary window loses its roll-forward (the join-date anchor)", probes: ["W1", "W2", "W10"], kit: { ...REAL, window: naiveWindow } },
  { name: "consecutive windows share a seam day again (two rows match, .maybeSingle() throws)", probes: ["W3"], kit: { ...REAL, window: seamWindow } },
  { name: "the brokerage's own year is anchored on the AGENT's join date", probes: ["W5"], kit: { ...REAL, window: agentAnchoredFiscal } },
  { name: "a future created_at is silently clamped instead of refused", probes: ["W8"], kit: { ...REAL, window: clampingWindow } },
  { name: "an unreadable anchor is guessed at instead of refused", probes: ["W9"], kit: { ...REAL, window: clampingWindow } },
  { name: "the precedence stops honouring is_active", probes: ["R4"], kit: { ...REAL, pick: ignoresActive } },
  { name: "the precedence stops honouring effective_date", probes: ["R5"], kit: { ...REAL, pick: ignoresEffectiveDate } },
  { name: "the brokerage default outranks the per-agent override", probes: ["R1", "R6", "R7", "R8"], kit: { ...REAL, pick: brokerageFirst } },
  { name: "a configured cap of 0 is treated as 'unset'", probes: ["R9"], kit: { ...REAL, pick: zeroIsUnset } },
  { name: "the money parser ROUNDS a third decimal instead of refusing it", probes: ["M1"], kit: { ...REAL, parse: roundingParse } },
  { name: "blank collapses to 0 — 'no cap' becomes 'collects nothing'", probes: ["M2"], kit: { ...REAL, parse: blankIsZeroParse } },
  // W2 is the probe that DEPENDS on `contains` being both-ended: it asserts the
  // naive window does NOT contain today, and a start-only filter says it does.
  // W1/W4 would have stayed green here — the window they check really does start
  // before today — so pointing this control at them proved nothing.
  { name: "stage 07's filter is mis-stated as start-only", probes: ["W2"], kit: { ...REAL, contains: looseContains } },
]

const SOURCE_MUTATIONS: Array<{ name: string; probe: string; mutate: (s: Sources) => Sources }> = [
  {
    name: "the CDA goes back to selecting the dead columns off the agents row",
    probe: "S21",
    mutate: (s) => ({ ...s, cdaPage: s.cdaPage.replace('.select("id, user_id, commission_split")', '.select("id, user_id, commission_split, cap_amount, cap_progress")') }),
  },
  {
    name: "the CDA stops distinguishing a refused cap read from an absent cap",
    probe: "S21",
    mutate: (s) => ({ ...s, cdaPage: s.cdaPage.replace("const { data: capRows, error: capError }", "const { data: capRows }").replace("capUnavailable={!!capError}", "capUnavailable={false}") }),
  },
  {
    name: "the CDA renders a PERCENTAGE through the currency formatter again",
    probe: "S22",
    mutate: (s) => ({ ...s, cdaClient: s.cdaClient.replace("formatCurrency(agentCap.capPaidToDate ?? 0)", "formatCurrency(agent?.cap_progress ?? 0)") }),
  },
  {
    name: "the brokerage cap card reconstructs dollars from a percentage again",
    probe: "S23",
    mutate: (s) => ({ ...s, brokerageFinancials: s.brokerageFinancials.replace("Math.min(c.paid, c.amount)", "((a.cap_progress || 0) / 100) * (a.cap_amount || 0)") }),
  },
  {
    name: "the brokerage cap read stops checking its error (nobody capped, confidently)",
    probe: "S23",
    mutate: (s) => ({ ...s, brokerageFinancials: s.brokerageFinancials.replace("const { data: capRows, error: capRowsError }", "const { data: capRows }") }),
  },
  {
    name: "the impossible >= 101 post-cap threshold is restored",
    probe: "S24",
    mutate: (s) => ({ ...s, brokerageFinancials: s.brokerageFinancials.replace("capSummary.atCap > capSummary.totalAgents * 0.3", "capSummary.atCap >= 101") }),
  },
  {
    name: "the agent cap bar gets its dollars-vs-percent fallback back",
    probe: "S25",
    mutate: (s) => ({ ...s, agentFinancials: s.agentFinancials.replace("capProgress={capTracking?.cap_paid_to_date ?? 0}", "capProgress={capTracking?.cap_paid_to_date ?? agentData?.cap_progress ?? 0}") }),
  },
  {
    name: "the broker AI context starts carrying cap_progress again",
    probe: "S26",
    mutate: (s) => ({ ...s, aiChat: s.aiChat.replace('.select("id, user_id, ytd_gci, ytd_transactions, is_active")', '.select("id, user_id, ytd_gci, ytd_transactions, cap_progress, is_active")') }),
  },
  {
    name: "the forecaster reads agents.cap_amount FIRST again (the inverted precedence)",
    probe: "S27",
    mutate: (s) => ({ ...s, forecaster: s.forecaster.replace('  const today = now.toISOString().slice(0, 10)\n  const { data: track, error } = await supabase', '  const { data: a } = await supabase.from("agents").select("cap_amount").eq("id", agentId).maybeSingle()\n  if (a) return 1\n  const today = now.toISOString().slice(0, 10)\n  const { data: track, error } = await supabase') }),
  },
  {
    name: "the forecaster stops checking its cap-read error (a refusal becomes 'uncapped')",
    probe: "S27",
    mutate: (s) => ({ ...s, forecaster: s.forecaster.replace("  if (error) return null\n", "\n") }),
  },
  {
    name: "the forecaster simulator seeds agents.cap_amount again, proving nothing about the engine",
    probe: "S28",
    mutate: (s) => ({ ...s, forecasterSim: s.forecasterSim.replace('await svc.from("agent_cap_tracking").update({ cap_amount: 100000 }).eq("id", liveCapRow.id)', 'await svc.from("agents").update({ cap_amount: 100000 }).eq("id", agentId)') }),
  },
  {
    name: "the recruiter simulator DELETES the borrowed window instead of restoring it (erasing collections history)",
    probe: "S28",
    mutate: (s) => ({ ...s, recruiterSim: s.recruiterSim.replace('await svc.from("agent_cap_tracking").update({ cap_amount: savedCap ?? null }).eq("id", borrowedCapRowId)', 'await svc.from("agent_cap_tracking").delete().eq("id", borrowedCapRowId)') }),
  },
  {
    name: "the team seeder keys on team_members instead of agents.team_id (a grain stage 08 never looks up)",
    probe: "S29",
    mutate: (s) => ({ ...s, resolver: s.resolver.replace('.eq("team_id", args.teamId)\n  if (agentsErr)', '.eq("tid", args.teamId)\n  if (agentsErr)') }),
  },
  {
    name: "the team seeder OVERWRITES a live window, moving the ceiling under a half-run year",
    probe: "S29",
    mutate: (s) => ({ ...s, resolver: s.resolver.replace('    if (covered.has(agent.id)) { result.alreadyCovered += 1; continue }', '    if (covered.has(agent.id)) { await db.from("team_cap_tracking").update({ cap_amount: capAmount }).eq("agent_id", agent.id); continue }') }),
  },
  {
    name: "the team seeder counts a zero-row RLS refusal as a seeded row",
    probe: "S29",
    mutate: (s) => ({ ...s, resolver: s.resolver.replace("    if (!written || written.length === 0) {", "    if (false) {") }),
  },
  {
    name: "saveTeamSplits stops opening the ledger, so the team cap is decorative again",
    probe: "S30",
    mutate: (s) => ({ ...s, team: s.team.replace("const seeded = await ensureTeamCapWindows(", "const seeded = await Promise.resolve({ ok: false, error: 'skipped' } as never) as never; void (") }),
  },
  {
    name: "the cap columns are spread in rather than allow-listed",
    probe: "S1",
    mutate: (s) => ({ ...s, brokerage: s.brokerage.replace(/const BROKERAGE_CAP_FIELDS = \[[\s\S]*?\] as const/, "const BROKERAGE_CAP_FIELDS = [] as const") }),
  },
  {
    name: "the write-permission check is dropped from the identity writer",
    probe: "S2",
    mutate: (s) => ({ ...s, brokerage: s.brokerage.replace("  if (!canEdit) {", "  if (false) {") }),
  },
  {
    name: "the brokerage UPDATE stops counting affected rows (a refusal reads as a save)",
    probe: "S3",
    mutate: (s) => ({ ...s, brokerage: s.brokerage.replace("  if (!saved || saved.length === 0) {", "  if (false) {") }),
  },
  {
    name: "an unrecognised reset schedule is silently normalized to the default",
    probe: "S4",
    mutate: (s) => ({
      ...s,
      brokerage: s.brokerage.replace(
        /if \(rawBasis && !\(CAP_ANNIVERSARY_BASES as readonly string\[\]\)\.includes\(rawBasis\)\) \{[\s\S]*?\n    \}/,
        "// silently normalized",
      ),
    }),
  },
  {
    name: "the brokerage cap gets its own parser instead of the shared one",
    probe: "S5",
    mutate: (s) => ({ ...s, brokerage: s.brokerage.replace(/parseCapAmountInput/g, "localParseMoney") }),
  },
  {
    name: "the team cap is written to a team id taken straight off the wire",
    probe: "S6",
    mutate: (s) => ({
      ...s,
      team: s.team.replace(
        'const target = await resolveWritableTeamId(g, input.teamId, "set the splits for")',
        "const target = { ok: true as const, teamId: input.teamId as string }",
      ),
    }),
  },
  {
    name: "the team write stops proving it changed a row",
    probe: "S7",
    mutate: (s) => ({ ...s, team: s.team.replace("  if (!written || written.length === 0) {", "  if (false) {") }),
  },
  {
    name: "the team cap moves onto the BRAND allow-list, where the brand writer could clear it",
    probe: "S8",
    mutate: (s) => ({
      ...s,
      team: s.team
        .replace(/(const TEAM_SPLIT_COLUMNS = \[[\s\S]*?)  "cap_amount",\n/, "$1")
        .replace('  "bio_text",\n] as const', '  "bio_text",\n  "cap_amount",\n] as const'),
    }),
  },
  {
    name: "agent creation writes agents.cap_amount again",
    probe: "S9",
    mutate: (s) => ({
      ...s,
      agents: s.agents.replace(
        "      commission_split: agentData.commission_split ?? null,",
        "      commission_split: agentData.commission_split ?? null,\n      cap_amount: agentData.cap_amount ?? null,",
      ),
    }),
  },
  {
    name: "agent creation stops seeding the ledger, so a cap set at creation is unenforced again",
    probe: "S10",
    mutate: (s) => ({ ...s, agents: s.agents.replace("await ensureAgentCapWindow(svc, {", "await Promise.resolve({ ok: true, result: null } as any) || ({} as any) && ({") }),
  },
  {
    name: "the YTD ratchet goes back to writing cap_progress",
    probe: "S11",
    mutate: (s) => ({
      ...s,
      agents: s.agents.replace("      ytd_transactions: ytdTransactions,\n      updated_at:", "      ytd_transactions: ytdTransactions,\n      cap_progress: 0,\n      updated_at:"),
    }),
  },
  {
    name: "agent-360's ledger read drops the anniversary-window filter and shows a closed year",
    probe: "S12",
    mutate: (s) => ({ ...s, agent360: s.agent360.replace('      .lte("anniversary_start", today)\n      .gte("anniversary_end", today)\n', "") }),
  },
  {
    name: "agent-360 goes back to selecting agents.cap_progress / cap_amount",
    probe: "S13",
    mutate: (s) => ({
      ...s,
      agent360: s.agent360.replace(
        '.select("id, created_at, ytd_gci, ytd_transactions, gamification_points")',
        '.select("id, created_at, ytd_gci, ytd_transactions, cap_progress, cap_amount, gamification_points")',
      ),
    }),
  },
  {
    name: "the settings panel's cap goes back to a hardcoded null",
    probe: "S14",
    mutate: (s) => ({ ...s, settingsPage: s.settingsPage.replace(/capAmount: parsedDefaultCap[^\n]*/, "capAmount: null,") }),
  },
  {
    name: "the seeder's INSERT stops proving it landed",
    probe: "S15",
    mutate: (s) => ({ ...s, resolver: s.resolver.replace("  if (!written || written.length === 0) {", "  if (false) {") }),
  },
  {
    name: "the seeder stops destructuring the existing-window read's error",
    probe: "S16",
    mutate: (s) => ({ ...s, resolver: s.resolver.replace("const { data: existing, error: existingErr } = await db", "const { data: existing } = await db") }),
  },
  {
    name: "the seeder writes a window without checking it contains today",
    probe: "S17",
    mutate: (s) => ({ ...s, resolver: s.resolver.replace("  if (!windowContains(win.window, today)) {", "  if (false) {") }),
  },
  {
    name: "the seeder UPDATES a live window, moving a ceiling somebody is already counting against",
    probe: "S18",
    mutate: (s) => ({
      ...s,
      resolver: s.resolver.replace(
        '  const { data: written, error: writeErr } = await db\n    .from("agent_cap_tracking")\n    .insert({',
        '  await db\n    .from("agent_cap_tracking")\n    .update({ cap_paid_to_date: 0 })\n  const { data: written, error: writeErr } = await db\n    .from("agent_cap_tracking")\n    .insert({',
      ),
    }),
  },
  {
    name: "the seeder's agent read loses its tenant anchor",
    probe: "S19",
    mutate: (s) => ({ ...s, resolver: s.resolver.replace('      .eq("brokerage_id", args.brokerageId)\n      .eq("id", args.agentId)', '      .eq("id", args.agentId)') }),
  },
  {
    name: "the phantom agents.start_date is written back into the resolver",
    probe: "S20",
    mutate: (s) => ({ ...s, resolver: s.resolver.replace('.select("id, created_at")', '.select("id, created_at, start_date")') }),
  },
]

// ─── LAYERS ──────────────────────────────────────────────────────────────────

function pureLayer() {
  console.log("\n[ASSERTIONS · one cap, resolved once, in a window the engine can find]")
  for (const p of PURE_PROBES) check(p.name, p.run(REAL))
}

function sourceLayer(s: Sources) {
  console.log("\n[ASSERTIONS · the writers are gated, allow-listed, and prove their writes]")
  for (const p of SOURCE_PROBES) check(p.name, p.run(s))
}

function negativeControls(s0: Sources) {
  console.log("\n[NEGATIVE CONTROLS · pure — each must go RED]")
  for (const m of PURE_MUTATIONS) {
    for (const id of m.probes) {
      const probe = PURE_PROBES.find((p) => p.name.startsWith(id + " "))
      if (!probe) { check(`NEGATIVE CONTROL ${m.name} — probe ${id} not found`, false); continue }
      let stillGreen: boolean
      try { stillGreen = probe.run(m.kit) } catch { stillGreen = false }
      check(`NEGATIVE CONTROL [${id}] ${m.name} — went RED as required`, !stillGreen,
        stillGreen ? `probe ${id} stayed green against the broken implementation` : "")
    }
  }

  console.log("\n[NEGATIVE CONTROLS · source — each must go RED]")
  for (const m of SOURCE_MUTATIONS) {
    const probe = SOURCE_PROBES.find((p) => p.name.startsWith(m.probe + " "))
    if (!probe) { check(`NEGATIVE CONTROL ${m.name} — probe ${m.probe} not found`, false); continue }
    const broken = m.mutate(s0)
    // EVERY field, keyed off the object rather than a hand-written list — the
    // previous form named six fields, so a mutation to any file added later
    // would have silently reported "changed: false" and passed as a control
    // that proved nothing.
    const changed = (Object.keys(s0) as Array<keyof Sources>).some((k) => broken[k] !== s0[k])
    if (!changed) {
      check(`NEGATIVE CONTROL [${m.probe}] ${m.name} — the mutation actually changed the source`, false,
        "the replace matched nothing, so this control proves nothing")
      continue
    }
    const stillGreen = probe.run(broken)
    check(`NEGATIVE CONTROL [${m.probe}] ${m.name} — went RED as required`, !stillGreen,
      stillGreen ? `probe ${m.probe} stayed green against the broken copy` : "")
  }
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    console.log("\n[live] ⊘ skipped (no SUPABASE creds) — the pure and source layers proved the resolution and the write path")
    return
  }
  const svc = createClient(url, key)
  console.log("\n[LIVE · m461 is in the database, not merely on disk]")

  // A migration on disk is not a migration that ran. PostgREST rejects the
  // ENTIRE select when a named column does not exist, so a clean read IS the
  // existence proof.
  const { error: brokErr } = await svc
    .from("brokerages")
    .select("id, default_cap_amount, default_cap_anniversary_basis")
    .limit(1)
  check("live: brokerages.default_cap_amount + default_cap_anniversary_basis exist", !brokErr, brokErr?.message ?? "")

  const { error: teamErr } = await svc.from("teams").select("id, cap_amount").limit(1)
  check("live: teams.cap_amount exists", !teamErr, teamErr?.message ?? "")

  const { error: tctErr } = await svc
    .from("team_cap_tracking")
    .select("id, brokerage_id, team_id, agent_id, anniversary_start, anniversary_end, cap_amount, cap_paid_to_date, is_capped")
    .limit(1)
  check("live: the team_cap_tracking ledger exists with the agent ledger's shape", !tctErr, tctErr?.message ?? "")

  // THE POINT OF THE WHOLE CHANGE: every agent carrying a cap on the losing copy
  // must now have a ledger row whose window CONTAINS TODAY, or the engine still
  // cannot see it.
  const today = new Date().toISOString().slice(0, 10)
  const { data: capped, error: cappedErr } = await svc
    .from("agents")
    .select("id, brokerage_id, cap_amount")
    .not("cap_amount", "is", null)
    .gt("cap_amount", 0)
  if (cappedErr) {
    check("live: agents carrying a legacy cap could be listed", false, cappedErr.message)
    return
  }

  const rows = (capped ?? []) as Array<{ id: string; brokerage_id: string; cap_amount: number }>
  let unenforced = 0
  for (const a of rows) {
    const { data: ledger, error: ledgerErr } = await svc
      .from("agent_cap_tracking")
      .select("id, cap_amount")
      .eq("brokerage_id", a.brokerage_id)
      .eq("agent_id", a.id)
      .lte("anniversary_start", today)
      .gte("anniversary_end", today)
    if (ledgerErr) { unenforced++; continue }
    if (!ledger || ledger.length === 0) unenforced++
  }
  check(
    `live: every agent with a legacy cap has a ledger row covering today (${rows.length} checked)`,
    unenforced === 0,
    unenforced > 0 ? `${unenforced} agent(s) still carry a cap the commission engine cannot see` : "",
  )
}

async function main() {
  const s: Sources = {
    resolver: src(RESOLVER),
    brokerage: src(BROKERAGE),
    team: src(TEAM),
    agents: src(AGENTS),
    agent360: src(AGENT360),
    settingsPage: src(SETTINGS_PAGE),
    cdaPage: src(CDA_PAGE),
    cdaClient: src(CDA_CLIENT),
    brokerageFinancials: src(BROKERAGE_FIN),
    agentFinancials: src(AGENT_FIN),
    aiChat: src(AI_CHAT),
    forecaster: src(FORECASTER),
    forecasterSim: src(FORECASTER_SIM),
    recruiterSim: src(RECRUITER_SIM),
  }
  pureLayer()
  sourceLayer(s)
  negativeControls(s)
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ COMMISSION_CAP_FAIL"); process.exit(1) }
  console.log(" ✅ COMMISSION_CAP_PASS — one cap resolver, one ledger, and a window the payout engine can actually find")
}
main()
