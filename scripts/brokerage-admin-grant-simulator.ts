#!/usr/bin/env tsx
/**
 * scripts/brokerage-admin-grant-simulator.ts  (npm run test:brokerage-admin-grant)
 * ─────────────────────────────────────────────────────────────────────────────
 * A ROLE GRANT IS AN ADMINISTERING FACT, NOT A DECORATIVE LABEL.
 *
 * OWNER RULING this proof holds in place: a solo-agent tenant has TWO seats —
 * the producing agent, and a second person carrying everything else the business
 * needs (transactions, compliance, support, admin, marketing). Those business
 * roles are ASSIGNED through public.user_role_assignments, so ONE USER HOLDING
 * SEVERAL ROLES IS THE DESIGNED CASE.
 *
 * WHAT WAS WRONG (measured on the live database before m466):
 *   public.is_brokerage_admin() read users.user_type ONLY and never looked at
 *   user_role_assignments, while the app gate lib/auth/require-brokerage-admin.ts
 *   admitted that same user_type set AND a tenant role grant. The database was
 *   the NARROWER of the two, which is the dangerous direction: the app says yes,
 *   RLS returns zero rows, error is null, and the surface reports success over a
 *   write that never happened. MEASURED: agent1@yourbrokerage.com is user_type
 *   'agent' holding admin+agent+isa grants on its OWN brokerage — the ruling's
 *   second seat, refused by all 225 policies that call this function.
 *
 * WHAT THIS PROOF DEFENDS, in three layers:
 *   PURE    the admin rule is EXECUTED as a model, both directions, including
 *           the tenant pin and the strict-boolean answer.
 *   SOURCE  the migration that DEFINES the function is located by scanning every
 *           migration for the function it defines — never by file path, so a
 *           rename cannot read as a removal — and the winning definition must
 *           still consult grants AND still pin them to the caller's tenant.
 *   LIVE    the function is CALLED on the real database. A migration file on
 *           disk is not the database.
 *
 * NEGATIVE CONTROLS: every structural check is re-run against a deliberately
 * broken copy and must go RED. A check that cannot fail is not a check.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { BROKERAGE_ADMIN_USER_TYPES } from "../lib/auth/require-brokerage-admin"

let pass = 0,
  fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail = "") => {
  if (c) {
    pass++
    console.log(`  ✓ ${n}`)
  } else {
    fail++
    fails.push(n)
    console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`)
  }
}

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations")

/** The roles that ADMINISTER a brokerage. One list, mirrored by the app gate. */
const ADMIN_ROLES = new Set(["admin", "broker", "broker_owner"])

// ─── PURE ────────────────────────────────────────────────────────────────────
// An executable model of public.is_brokerage_admin(). This is not a
// reimplementation for its own sake: it is the rule stated in a form that can be
// asserted case by case, including the cases the SQL is easy to get wrong.

type Grant = { role: string; brokerageId: string | null }
type Caller = { userType: string | null; brokerageId: string | null; grants: Grant[] }

/** Returns a STRICT boolean. Could-not-establish = no. */
export function isBrokerageAdmin(caller: Caller | null): boolean {
  if (!caller) return false
  // BRANCH 1 — user_type, unchanged by m466.
  if (caller.userType !== null && ADMIN_ROLES.has(caller.userType)) return true
  // BRANCH 2 — a tenant role grant, PINNED to the caller's own brokerage.
  return caller.grants.some(
    (g) =>
      ADMIN_ROLES.has(g.role) &&
      g.brokerageId !== null &&
      caller.brokerageId !== null &&
      g.brokerageId === caller.brokerageId,
  )
}

const OWN = "231f4e64-5022-4752-8047-696886551c35"
const OTHER = "b0000000-0000-0000-0000-000000000001"

function pureLayer() {
  console.log("\n[PURE · the admin rule, executed both directions]")

  // THE RULING'S SECOND SEAT — this is the case the whole migration exists for.
  check(
    "P1 a user_type 'agent' holding an admin GRANT on their own brokerage IS an admin",
    isBrokerageAdmin({ userType: "agent", brokerageId: OWN, grants: [{ role: "admin", brokerageId: OWN }] }) === true,
  )

  // THE DESIGNED CASE: several roles at once. user_role_assignments is UNIQUE on
  // (user_id, role), NOT on user_id — multi-row per user is legal and live.
  check(
    "P2 holding admin + agent + isa at once is the DESIGNED case, not a conflict",
    isBrokerageAdmin({
      userType: "agent",
      brokerageId: OWN,
      grants: [
        { role: "agent", brokerageId: OWN },
        { role: "admin", brokerageId: OWN },
        { role: "isa", brokerageId: OWN },
      ],
    }) === true,
  )

  // THE TENANT PIN — the single most important negative.
  check(
    "P3 an admin grant on ANOTHER brokerage authorises NOTHING",
    isBrokerageAdmin({ userType: "agent", brokerageId: OWN, grants: [{ role: "admin", brokerageId: OTHER }] }) === false,
  )

  // MEASURED on the live table: the `lender` and `contact` grants carry NULL.
  check(
    "P4 a grant with NO brokerage is not a tenant grant and cannot administer one",
    isBrokerageAdmin({ userType: "lender", brokerageId: OWN, grants: [{ role: "lender", brokerageId: null }] }) === false,
  )

  check(
    "P5 a non-administering grant (team_lead) does not admit, however tenanted",
    isBrokerageAdmin({ userType: "team_lead", brokerageId: OWN, grants: [{ role: "team_lead", brokerageId: OWN }] }) ===
      false,
  )

  check(
    "P6 a plain agent with no grants is still refused (the population that must not widen)",
    isBrokerageAdmin({ userType: "agent", brokerageId: OWN, grants: [] }) === false,
  )

  check(
    "P7 a user_type admin with no grants is still admitted (no regression on the old population)",
    isBrokerageAdmin({ userType: "admin", brokerageId: OTHER, grants: [] }) === true,
  )

  // STRICT BOOLEAN. m465 shipped a first version answering NULL through
  // three-valued logic; RLS failed closed so nothing leaked, but a boolean
  // function that answers NULL is a trap for anything that composes it — and
  // this one is composed by 225 policies and a trigger.
  const noIdentity = isBrokerageAdmin(null)
  check(
    "P8 no identity at all answers a STRICT false — never null/undefined",
    noIdentity === false && typeof noIdentity === "boolean",
    `got ${String(noIdentity)} (${typeof noIdentity})`,
  )

  const unknown = isBrokerageAdmin({ userType: null, brokerageId: null, grants: [] })
  check(
    "P9 an unresolvable caller answers a STRICT false, not a null carried out through OR",
    unknown === false && typeof unknown === "boolean",
  )
}

function pureNegativeControls() {
  console.log("\n[NEGATIVE CONTROLS · pure rule, hand-broken and re-asserted]")

  // The defect this migration most plausibly could have shipped: reading the
  // grant but forgetting to pin it to the caller's tenant.
  const unpinned = (c: Caller) =>
    (c.userType !== null && ADMIN_ROLES.has(c.userType)) || c.grants.some((g) => ADMIN_ROLES.has(g.role))
  check(
    "NEGATIVE CONTROL an UNPINNED grant test admits a foreign-brokerage admin — P3 would have gone RED",
    unpinned({ userType: "agent", brokerageId: OWN, grants: [{ role: "admin", brokerageId: OTHER }] }) === true,
  )

  // The defect of treating a NULL-brokerage grant as a tenant anchor.
  const nullAnchored = (c: Caller) => c.grants.some((g) => ADMIN_ROLES.has(g.role) && g.brokerageId === c.brokerageId)
  check(
    "NEGATIVE CONTROL treating a NULL brokerage as a match admits an untenanted grant — P4 would have gone RED",
    nullAnchored({ userType: "x", brokerageId: null, grants: [{ role: "admin", brokerageId: null }] }) === true,
  )

  // The defect of picking ONE grant row (.maybeSingle()/LIMIT 1) instead of
  // asking whether ANY grant administers — which is what broke the app copy.
  const firstGrantOnly = (c: Caller) => {
    const g = c.grants[0]
    return !!g && ADMIN_ROLES.has(g.role) && g.brokerageId === c.brokerageId
  }
  check(
    "NEGATIVE CONTROL picking only the FIRST grant refuses the live admin+agent+isa holder — P2 would have gone RED",
    firstGrantOnly({
      userType: "agent",
      brokerageId: OWN,
      grants: [
        { role: "agent", brokerageId: OWN },
        { role: "admin", brokerageId: OWN },
      ],
    }) === false,
  )
}

// ─── SOURCE ──────────────────────────────────────────────────────────────────

/**
 * Find the migration that DEFINES public.is_brokerage_admin, by scanning every
 * migration for the definition itself. Never by file path: pinning a probe to
 * "m466-….sql" means renaming the file reads as the function being removed, and
 * this session already paid for that mistake seven times. Migrations apply in
 * filename order, so the LAST definer is the one the database ends up with.
 */
/** Locate the LAST migration that defines `public.<fn>`, by what it DEFINES
 *  rather than by filename — a rename must never read as a removal. */
export function winningDefinitionOf(fn: string, files: Array<{ name: string; body: string }>): { name: string; def: string } | null {
  const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(`, "i")
  const definers = files
    .filter((f) => re.test(f.body))
    .sort((a, b) => a.name.localeCompare(b.name))
  const last = definers[definers.length - 1]
  if (!last) return null
  const start = last.body.search(re)
  // The body runs to the end of the dollar-quoted block that closes it.
  const end = last.body.indexOf("$$;", start)
  return { name: last.name, def: last.body.slice(start, end === -1 ? undefined : end + 3) }
}

/** The admin gate, by name. Kept as its own export so existing probes read unchanged. */
export function winningDefinition(files: Array<{ name: string; body: string }>): { name: string; def: string } | null {
  return winningDefinitionOf("is_brokerage_admin", files)
}

function loadMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((name) => ({ name, body: readFileSync(join(MIGRATIONS_DIR, name), "utf8") }))
}

function sourceLayer() {
  console.log("\n[SOURCE · the winning definition still consults grants and still pins the tenant]")

  const winner = winningDefinition(loadMigrations())
  check("S1 some migration DEFINES public.is_brokerage_admin (located by what it defines, not by filename)", !!winner)
  if (!winner) return

  console.log(`      winning definer: ${winner.name}`)
  const def = winner.def.toLowerCase()

  check("S2 the winning definition CONSULTS user_role_assignments — the grant is an administering fact", def.includes("user_role_assignments"))

  check(
    "S3 the grant is PINNED to the caller's own tenant — a grant on another brokerage authorises nothing",
    def.includes("current_user_brokerage_id"),
  )

  check(
    "S4 it still admits the user_type branch — the pre-existing admin population did not regress",
    def.includes("user_type"),
  )

  check("S5 it answers a STRICT boolean (coalesce to false), never NULL", def.includes("coalesce") && def.includes("false"))

  for (const role of ADMIN_ROLES) {
    check(`S6 the administering role '${role}' is admitted from the grant table`, def.includes(`'${role}'`))
  }

  // THE APP AND THE DATABASE MUST AGREE. That disagreement is the whole defect.
  check(
    "S7 the app gate's BROKERAGE_ADMIN_USER_TYPES is exactly the SQL role set — app and DB agree on 'admin'",
    BROKERAGE_ADMIN_USER_TYPES.size === ADMIN_ROLES.size &&
      [...ADMIN_ROLES].every((r) => BROKERAGE_ADMIN_USER_TYPES.has(r)),
    `app=${[...BROKERAGE_ADMIN_USER_TYPES].join(",")} sql=${[...ADMIN_ROLES].join(",")}`,
  )

  // ── THE READ SIDE (m467) ──────────────────────────────────────────────────
  // Widening only the ADMIN gate left the second seat able to CHANGE the books
  // and unable to LOOK at them. A gate that admits a write and refuses the
  // matching read is not narrower, it is incoherent — and the ruling is that
  // this person must SEE the transactions.
  const books = winningDefinitionOf("can_read_brokerage_books", loadMigrations())
  check("S8 some migration DEFINES public.can_read_brokerage_books (located by what it defines)", !!books)
  if (books) {
    const bdef = books.def.toLowerCase()
    check("S9 the books gate CONSULTS grants too — the write/read asymmetry is closed",
      bdef.includes("user_role_assignments"))
    check("S10 …pinned to the caller's own tenant, exactly as the admin gate is",
      bdef.includes("current_user_brokerage_id"))
    check("S11 …and answers a STRICT boolean, never NULL",
      bdef.includes("coalesce") && bdef.includes("false"))
    // The set is WIDER than the admin set on purpose: reading the books is not
    // the same circle as administering the brokerage. Copying the 3-role admin
    // set across would have silently revoked the compliance officer's path.
    for (const role of ["admin", "broker", "broker_owner", "broker_admin", "compliance_officer"]) {
      check(`S12 the books gate admits '${role}' from the grant table`, bdef.includes(`'${role}'`))
    }
    check("S13 the books gate is STRICTLY WIDER than the admin gate (it is a different question)",
      bdef.includes("'compliance_officer'") && !winningDefinition(loadMigrations())?.def.toLowerCase().includes("'compliance_officer'"))
  }
}

function sourceNegativeControls() {
  console.log("\n[NEGATIVE CONTROLS · structural probes, against broken copies]")
  const base = loadMigrations()
  const winner = winningDefinition(base)
  if (!winner) {
    check("NEGATIVE CONTROL cannot run without a winning definition", false)
    return
  }

  // A later migration that reverts the function to user_type-only must be caught
  // by S2 — this is the exact regression the ruling forbids.
  const reverted = [
    ...base,
    {
      name: "zzz-hypothetical-revert.sql",
      body: `create or replace function public.is_brokerage_admin() returns boolean language sql as $$ select coalesce((select user_type in ('admin') from public.users where id = auth.uid() limit 1), false); $$;`,
    },
  ]
  const w2 = winningDefinition(reverted)
  check(
    "NEGATIVE CONTROL a later migration reverting to user_type-only becomes the winner and fails S2 — went RED as required",
    !!w2 && w2.name === "zzz-hypothetical-revert.sql" && !w2.def.toLowerCase().includes("user_role_assignments"),
  )

  // A definition that reads grants but drops the tenant pin must fail S3.
  const unpinned = winner.def.replace(/current_user_brokerage_id/gi, "xxx_removed")
  check(
    "NEGATIVE CONTROL a definition that drops the tenant pin fails S3 — went RED as required",
    !unpinned.toLowerCase().includes("current_user_brokerage_id"),
  )

  // A definition that drops the coalesce must fail S5.
  const nulling = winner.def.replace(/coalesce/gi, "xxx_removed")
  check(
    "NEGATIVE CONTROL a definition that drops coalesce fails S5 — went RED as required",
    !nulling.toLowerCase().includes("coalesce"),
  )

  // Renaming the migration must NOT read as a removal — the probe follows the
  // definition, which is the point of locating it this way.
  const renamed = base.map((f) => (f.name === winner.name ? { ...f, name: "m999-renamed-entirely.sql" } : f))
  const w3 = winningDefinition(renamed)
  check(
    "NEGATIVE CONTROL renaming the migration still finds the definition — a rename is not a removal",
    !!w3 && w3.def.toLowerCase().includes("user_role_assignments"),
  )
}

// ─── LIVE ────────────────────────────────────────────────────────────────────

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    console.log("\n[live] ⊘ skipped (no SUPABASE creds) — the pure + source layers proved the rule")
    return
  }
  const svc = createClient(url, key)
  console.log("\n[LIVE · the function on the real database, not the file on disk]")

  // CALL IT. The service role carries no auth.uid(), so both branches must fail
  // and the answer must be a STRICT false — not null. A gate that answered true
  // to an identity-less caller would be no gate at all, and one that answered
  // null would be the m465 defect returning.
  const { data, error } = await svc.rpc("is_brokerage_admin")
  check(
    "live: is_brokerage_admin() exists, is callable, and refuses an identity-less caller",
    !error && data === false,
    error?.message ?? `returned ${JSON.stringify(data)}`,
  )
  check(
    "live: it answers a STRICT boolean — null would be the m465 three-valued-logic defect returning",
    !error && data !== null && typeof data === "boolean",
    error?.message ?? `returned ${JSON.stringify(data)} (${typeof data})`,
  )

  // The ruling's shape must actually exist in the data. supabase-js RESOLVES a
  // failed query, so `error` is destructured rather than trusting `data`.
  const { data: grants, error: grantErr } = await svc
    .from("user_role_assignments")
    .select("user_id, role, brokerage_id")
  check("live: user_role_assignments is readable", !grantErr, grantErr?.message ?? "")

  if (!grantErr && grants) {
    const byUser = new Map<string, Array<{ role: string; brokerage_id: string | null }>>()
    for (const g of grants as Array<{ user_id: string; role: string; brokerage_id: string | null }>) {
      if (!byUser.has(g.user_id)) byUser.set(g.user_id, [])
      byUser.get(g.user_id)!.push({ role: g.role, brokerage_id: g.brokerage_id })
    }

    // THE DESIGNED CASE, live. If this ever goes to zero the ruling has not been
    // repealed — but the fixture proving it has gone, and that is worth knowing.
    const multi = [...byUser.values()].filter((rows) => rows.length > 1)
    check(
      "live: at least one user holds SEVERAL roles at once — the designed case, not a data smell",
      multi.length > 0,
      `${multi.length} multi-role users`,
    )

    // A tenanted admin grant must exist for the widening to mean anything.
    const admins = [...byUser.entries()].filter(([, rows]) =>
      rows.some((r) => ADMIN_ROLES.has(r.role) && r.brokerage_id !== null),
    )
    check(
      "live: at least one TENANTED administering grant exists (the second seat is real)",
      admins.length > 0,
      `${admins.length} holders`,
    )

    // THE PIN'S PREMISE: the function matches the grant against users.brokerage_id,
    // so for a grant holder to be admitted, their user row must carry that tenant.
    // Verify the premise rather than assuming it.
    for (const [userId, rows] of admins) {
      const grant = rows.find((r) => ADMIN_ROLES.has(r.role) && r.brokerage_id !== null)!
      const { data: user, error: userErr } = await svc
        .from("users")
        .select("brokerage_id, user_type")
        .eq("id", userId)
        .maybeSingle()
      if (userErr) {
        check(`live: resolvable user row for administering grant holder ${userId.slice(0, 8)}`, false, userErr.message)
        continue
      }
      const u = user as { brokerage_id: string | null; user_type: string | null } | null
      const modelled = isBrokerageAdmin({
        userType: u?.user_type ?? null,
        brokerageId: u?.brokerage_id ?? null,
        grants: rows.map((r) => ({ role: r.role, brokerageId: r.brokerage_id })),
      })
      check(
        `live: grant holder ${userId.slice(0, 8)} (user_type ${u?.user_type ?? "?"}) is admitted by the model — grant tenant ${
          u?.brokerage_id === grant.brokerage_id ? "matches" : "DIFFERS FROM"
        } users.brokerage_id`,
        modelled === true,
        `grant=${grant.brokerage_id} user=${u?.brokerage_id}`,
      )
    }
  }
}

async function main() {
  pureLayer()
  pureNegativeControls()
  sourceLayer()
  sourceNegativeControls()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) {
    console.log("FAILURES:")
    fails.forEach((f) => console.log("  - " + f))
  }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log(" ❌ BROKERAGE_ADMIN_GRANT_FAIL")
    process.exit(1)
  }
  console.log(
    " ✅ BROKERAGE_ADMIN_GRANT_PASS — a tenant role grant administers the brokerage it names, and only that one",
  )
}
main()
