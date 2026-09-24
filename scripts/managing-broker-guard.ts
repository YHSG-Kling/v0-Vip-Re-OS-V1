#!/usr/bin/env tsx
/**
 * scripts/managing-broker-guard.ts   (npm run test:managing-broker)
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 81A — owner verbatim (2026-09-24): "a broker who is the broker of record
 * for a brokerage location has to be producing since that person manages the
 * agents of the brokerage. there can only be one managing broker per
 * brokerage location."
 *
 * THE RULE, asserted (never a waypoint — CLAUDE.md §2):
 *   1 · the predicate: a licensed role with managingBroker:true is a seat even
 *       when the tenant says produces:false; eligibility = LICENSED_SEAT_ROLES
 *   2 · the meter: a managing broker listed as exempt is BILLED and is not
 *       reported as an exemption in force; a refused offices read is PUBLISHED
 *   3 · the writer: refuses to exempt a managing broker (the office named);
 *       fails CLOSED on an unreadable offices row; clearing is never gated
 *   4 · the assigner: eligibility, tenant, office in tenant, principal office
 *       materialised, counted update, seat gate for an exempt broker, the
 *       exemption cleared through the one writer, audited
 *   5 · readiness: every office has one and there is at least one office
 *   6 · m661's shape: ONE scalar column on locations (uniqueness per location
 *       by construction), FK users(id), NO uniqueness on the user
 *   7 · surfaces: the card hides the toggle for a managing broker and mounts
 *       the assign door; the seat door reads the offices
 *   8 · registration (scripts + guard ordering after test:scrapers + registry)
 *
 * No DB, no network — an in-memory client (scripts/in-memory-supabase.ts).
 * Run: npx tsx --conditions=react-server scripts/managing-broker-guard.ts
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
/** POSITIVE CONTROL: the same finder, fed the defect, MUST report it. */
function control(name: string, defectSeen: boolean) {
  if (defectSeen) { passed++; console.log(`  ↺ control: ${name}`) }
  else { failed++; failures.push(`CONTROL DID NOT GO RED: ${name}`); console.log(`  ✗ CONTROL DID NOT GO RED: ${name}`) }
}
const root = process.cwd()
const raw = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : "")
const code = (p: string) => stripComments(raw(p))

const MATRIX = "lib/kernel/tier-role-matrix.ts"
const USAGE = "lib/kernel/seat-usage.ts"
const KERNEL = "lib/kernel/managing-broker.ts"
const ACTION = "app/actions/managing-broker.ts"
const BILLING = "app/actions/billing.ts"
const CARD = "app/dashboard/admin/billing/seat-door-card.tsx"
const READINESS = "lib/onboarding/setup-readiness.ts"
const MIGRATION = "supabase/migrations/m661-one-managing-broker-per-location-and-agent-book-transfers.sql"

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1 · THE PREDICATE — the managing broker is a seat whatever the tenant says]")
const { roleConsumesSeat, canBeManagingBroker, MANAGING_BROKER_ELIGIBLE_ROLES, LICENSED_SEAT_ROLES, FREE_STAFF_ROLES, PRODUCER_SEAT_ROLES } = await import("../lib/kernel/tier-role-matrix")
for (const r of LICENSED_SEAT_ROLES) {
  check(`${r}: exempt (produces:false) is FREE — until they are a managing broker, then a SEAT`,
    !roleConsumesSeat(r, { produces: false }) && roleConsumesSeat(r, { produces: false, managingBroker: true }) && roleConsumesSeat(r, { managingBroker: true }))
}
control("the pre-81A rule (exemption always wins) reads `!roleConsumesSeat('broker', { produces:false, managingBroker:true })` — that now goes red",
  !roleConsumesSeat("broker", { produces: false, managingBroker: true }) === false)
check("managingBroker:true changes nothing for a producer by type or for staff (it is a licensed-role fact)",
  PRODUCER_SEAT_ROLES.every((r) => roleConsumesSeat(r, { managingBroker: true }) && roleConsumesSeat(r, { produces: false }))
  && FREE_STAFF_ROLES.every((r) => !roleConsumesSeat(r, { managingBroker: true, produces: true }))
  && !roleConsumesSeat("admin", { managingBroker: true }))
check("eligibility is LICENSED_SEAT_ROLES by IDENTITY (one list, §6)", MANAGING_BROKER_ELIGIBLE_ROLES === LICENSED_SEAT_ROLES)
check("canBeManagingBroker: broker / broker_owner yes; agent, admin, team_lead, tc, vendor, null no",
  canBeManagingBroker("broker") && canBeManagingBroker("broker_owner")
  && ["agent", "admin", "team_lead", "tc", "vendor", "compliance_officer", "", null, undefined].every((r) => !canBeManagingBroker(r as never)))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2 · THE METER — an exempt managing broker is billed; a refused offices read is published]")
const { resolveSeatUsage, setLicensedProducerExemption } = await import("../lib/kernel/seat-usage")
const roster = [
  { id: "mb", user_type: "broker", status: "active", brokerage_id: "b1" },      // managing broker, LISTED as exempt
  { id: "bo", user_type: "broker_owner", status: "active", brokerage_id: "b1" }, // exempt, not managing
  { id: "ag", user_type: "agent", status: "active", brokerage_id: "b1" },
]
const seedMeter = (withOffice: boolean) => ({
  users: roster,
  user_role_assignments: [],
  agents: [{ user_id: "ag", is_active: true, brokerage_id: "b1" }],
  brokerages: [{ id: "b1", billing_metadata: { non_producing_user_ids: ["mb", "bo"] } }],
  locations: withOffice ? [{ id: "loc1", brokerage_id: "b1", name: "Downtown", managing_broker_user_id: "mb" }] : [],
})
{
  const u = await resolveSeatUsage(memSupabase(seedMeter(true)), "b1")
  check("mb (managing broker, listed exempt) IS billed; bo (exempt) is free; ag by type → 2 seats; nonProducingIds reports only bo; managingBrokerIds = mb",
    u.ok && u.seatCount === 2 && [...u.seatHolderIds].sort().join() === "ag,mb" && u.nonProducingIds.join() === "bo" && u.managingBrokerIds.join() === "mb" && !u.managingBrokerReadRefused, JSON.stringify(u))
  const none = await resolveSeatUsage(memSupabase(seedMeter(false)), "b1")
  control("with NO office naming mb the same roster bills 1 — the managing-broker fact is what moved the number", none.seatCount === 1 && [...none.nonProducingIds].sort().join() === "bo,mb")
  const refused = await resolveSeatUsage(memSupabase(seedMeter(true), { missingColumns: { locations: ["managing_broker_user_id"] } }), "b1")
  check("m661 NOT APPLIED (42703) or a refused offices read: the meter still runs (ok), applies the list as written (1 seat) and PUBLISHES managingBrokerReadRefused",
    refused.ok && refused.seatCount === 1 && refused.managingBrokerReadRefused === true, JSON.stringify(refused))
  const rls = await resolveSeatUsage(memSupabase(seedMeter(true), { refuse: { locations: "permission denied" } }), "b1")
  check("…same for an RLS refusal", rls.ok && rls.managingBrokerReadRefused === true)
  check("the meter's fifth read is the locations table filtered to non-null managing_broker_user_id, and the seat predicate receives the managingBroker fact",
    /from\("locations"\)\.select\("managing_broker_user_id"\)\.eq\("brokerage_id", brokerageId\)\.not\("managing_broker_user_id", "is", null\)/.test(code(USAGE))
    && /managingBroker: managingBrokers\.has\(userId\)/.test(code(USAGE)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3 · THE WRITER — refuses to exempt a managing broker; fails closed; clearing is never gated]")
{
  const seed = () => ({
    users: [{ id: "mb", user_type: "broker", brokerage_id: "b1" }, { id: "bo", user_type: "broker_owner", brokerage_id: "b1" }],
    brokerages: [{ id: "b1", billing_metadata: { non_producing_user_ids: ["mb"] } }],
    locations: [{ id: "loc1", brokerage_id: "b1", name: "Downtown", managing_broker_user_id: "mb" }],
  })
  const svc = memSupabase(seed())
  const r = await setLicensedProducerExemption(svc, "b1", "mb", true)
  check("REFUSES to mark the managing broker non-producing — reason managing_broker, the office NAMED, nothing written",
    !r.ok && r.reason === "managing_broker" && /Downtown/.test(r.error) && /managing broker/i.test(r.error) && svc.writes.length === 0, JSON.stringify(r))
  const other = memSupabase(seed())
  const r2 = await setLicensedProducerExemption(other, "b1", "bo", true)
  control("…while a licensed user who is NOT a managing broker is still exemptible by the same writer", r2.ok && r2.nonProducingIds.join() === "bo,mb")
  const unreadable = memSupabase(seed(), { refuse: { locations: "permission denied" } })
  const r3 = await setLicensedProducerExemption(unreadable, "b1", "bo", true)
  check("FAILS CLOSED: an unreadable offices row refuses the exemption (tenant_unreadable, names the check) and writes nothing",
    !r3.ok && r3.reason === "tenant_unreadable" && /managing broker/i.test(r3.error) && unreadable.writes.length === 0, JSON.stringify(r3))
  const unapplied = memSupabase(seed(), { missingColumns: { locations: ["managing_broker_user_id"] } })
  check("…and so does m661-not-yet-applied (42703) — no free seat before the column exists", !(await setLicensedProducerExemption(unapplied, "b1", "bo", true)).ok && unapplied.writes.length === 0)
  const clearing = memSupabase(seed(), { refuse: { locations: "permission denied" } })
  const r4 = await setLicensedProducerExemption(clearing, "b1", "mb", false)
  check("CLEARING an exemption (producing again) is never gated by the offices read — it succeeds even when that read is refused", r4.ok && r4.nonProducingIds.length === 0, JSON.stringify(r4))
  check("the writer gates only the exempting direction, in source: the offices read sits inside `if (nonProducing)` and fails closed on its error",
    /if \(nonProducing\) \{\s*const \{ data: offices, error: officesErr \} = await svc\s*\.from\("locations"\)/.test(code(USAGE)) && /if \(officesErr\) \{\s*return \{ ok: false, reason: "tenant_unreadable"/.test(code(USAGE)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4 · THE ASSIGNER — eligibility, tenant, office, principal office, counted write, seat gate, audit]")
const { assignManagingBroker, readManagingBrokerRoster, managingBrokerReadiness } = await import("../lib/kernel/managing-broker")
const TEAM = 10
const tierRows = [{ tier_name: "team", max_agents: TEAM, is_active: true, seat_package_size: null, seat_package_price_cents: null, stripe_seat_price_id: null }]
type Seed = Record<string, any[]>
// A function, not `=> ({…})`: a parenthesised object literal followed by the
// bare `{` block below makes tsc's arrow-parameter speculation swallow it.
function baseSeed(over: Partial<Seed> = {}): Seed { return {
  users: [
    { id: "brk", user_type: "broker", brokerage_id: "b1", status: "active", first_name: "Bea", last_name: "Broker" },
    { id: "ag", user_type: "agent", brokerage_id: "b1", status: "active", first_name: "Al" },
    { id: "adm", user_type: "admin", brokerage_id: "b1", status: "active" },
    { id: "far", user_type: "broker", brokerage_id: "b2", status: "active" },
  ],
  agents: [{ id: "a-ag", user_id: "ag", brokerage_id: "b1", is_active: true }],
  user_role_assignments: [],
  brokerages: [{ id: "b1", name: "Kling Realty", address: "1 Main St", city: "Austin", license_state: "TX", plan_tier: "team", billing_metadata: {} }],
  subscription_tiers: tierRows,
  subscriptions: [],
  locations: [] as any[],
  lifecycle_events: [] as any[],
  ...over,
} }
{
  const svc = memSupabase(baseSeed())
  const bad = await assignManagingBroker(svc, { brokerageId: "b1", locationId: null, userId: "ag", actorUserId: "adm" })
  check("an AGENT cannot be a managing broker (not_eligible), nothing written", !bad.ok && bad.reason === "not_eligible" && svc.writes.length === 0)
  const bad2 = await assignManagingBroker(svc, { brokerageId: "b1", locationId: null, userId: "adm", actorUserId: "adm" })
  check("nor an ADMIN", !bad2.ok && bad2.reason === "not_eligible")
  const far = await assignManagingBroker(svc, { brokerageId: "b1", locationId: null, userId: "far", actorUserId: "adm" })
  check("a broker of ANOTHER tenant is not on this workspace (user_not_in_tenant) — the tenant predicate is the session's, never the id", !far.ok && far.reason === "user_not_in_tenant" && svc.writes.length === 0)
  const foreignOffice = await assignManagingBroker(memSupabase(baseSeed({ locations: [{ id: "locX", brokerage_id: "b2", name: "Elsewhere" }] })), { brokerageId: "b1", locationId: "locX", userId: "brk", actorUserId: "adm" })
  check("an office of another tenant is refused (office_not_in_tenant)", !foreignOffice.ok && foreignOffice.reason === "office_not_in_tenant")
}
{
  // Single-office tenant: the principal office is materialised on first assignment.
  const svc = memSupabase(baseSeed())
  const ok = await assignManagingBroker(svc, { brokerageId: "b1", locationId: null, userId: "brk", actorUserId: "adm" })
  const loc = svc.tables.locations[0]
  check("a tenant with NO offices gets its principal office created (name = the brokerage's, address copied) and the broker assigned; the write is counted",
    ok.ok && ok.principalOfficeCreated && !ok.seatAdded && svc.tables.locations.length === 1 && loc.name === "Kling Realty" && loc.city === "Austin" && loc.state === "TX"
    && loc.managing_broker_user_id === "brk" && loc.managing_broker_assigned_by === "adm" && !!loc.managing_broker_assigned_at, JSON.stringify(ok))
  const audit = svc.tables.lifecycle_events.find((e) => e.event_type === "managing_broker_assigned")
  check("audited on lifecycle_events (entity location, actor, the user id)", !!audit && audit.entity_type === "location" && audit.entity_id === loc.id && audit.actor_user_id === "adm" && audit.metadata.managing_broker_user_id === "brk")
  const again = await assignManagingBroker(svc, { brokerageId: "b1", locationId: null, userId: "brk", actorUserId: "adm" })
  check("a second assignment with locationId null reuses the existing principal office — never a second row (one per location)", again.ok && !again.principalOfficeCreated && svc.tables.locations.length === 1)
  const roster = await readManagingBrokerRoster(svc, "b1")
  check("the roster reads the office with its broker's label and lists only licensed eligible people",
    roster.ok && roster.slots.length === 1 && roster.slots[0].managingBrokerLabel === "Bea Broker" && roster.eligible.map((e) => e.userId).join() === "brk")
  const cleared = await assignManagingBroker(svc, { brokerageId: "b1", locationId: loc.id, userId: null, actorUserId: "adm" })
  check("clearing (userId null) empties the column and audits managing_broker_cleared",
    cleared.ok && svc.tables.locations[0].managing_broker_user_id === null && svc.tables.lifecycle_events.some((e) => e.event_type === "managing_broker_cleared"))
  const empty = await readManagingBrokerRoster(memSupabase(baseSeed()), "b1")
  check("a tenant with no offices is shown ONE virtual principal-office slot (locationId null) so the surface can assign into it",
    empty.ok && empty.slots.length === 1 && empty.slots[0].locationId === null && empty.slots[0].locationName === "Kling Realty")
}
{
  // An EXEMPT broker becomes managing broker: the seat gate runs; over the limit refuses; with room the exemption is cleared through the one writer.
  const fullAgents = Array.from({ length: TEAM }, (_, i) => ({ id: `u${i}`, user_type: "agent", brokerage_id: "b1", status: "active" }))
  const full = memSupabase(baseSeed({
    users: [...fullAgents, { id: "brk", user_type: "broker", brokerage_id: "b1", status: "active" }],
    agents: fullAgents.map((u) => ({ id: `a-${u.id}`, user_id: u.id, brokerage_id: "b1", is_active: true })),
    brokerages: [{ id: "b1", name: "Full House", plan_tier: "team", billing_metadata: { non_producing_user_ids: ["brk"] } }],
  }))
  const refused = await assignManagingBroker(full, { brokerageId: "b1", locationId: null, userId: "brk", actorUserId: "adm" })
  check(`an EXEMPT broker on a FULL team plan (${TEAM}/${TEAM}) cannot become managing broker — seat_limit, the door's sentence quoted, nothing written`,
    !refused.ok && refused.reason === "seat_limit" && /producing seat/.test(refused.error) && /in use/.test(refused.error) && full.writes.length === 0, JSON.stringify(refused))
  const room = memSupabase(baseSeed({
    brokerages: [{ id: "b1", name: "Room", plan_tier: "team", billing_metadata: { non_producing_user_ids: ["brk"], seat_override: 12 } }],
  }))
  const ok = await assignManagingBroker(room, { brokerageId: "b1", locationId: null, userId: "brk", actorUserId: "adm" })
  check("with room, the exemption is CLEARED through setLicensedProducerExemption (the rest of billing_metadata survives) and seatAdded is reported",
    ok.ok && ok.seatAdded && room.tables.brokerages[0].billing_metadata.non_producing_user_ids.length === 0 && room.tables.brokerages[0].billing_metadata.seat_override === 12, JSON.stringify(ok))
  const after = await resolveSeatUsage(room, "b1")
  check("…and the meter now bills them (agent + managing broker = 2)", after.seatCount === 2 && after.managingBrokerIds.join() === "brk")
  control("a non-exempt broker never touches the gate: the same assignment on a full plan succeeds (they already hold the seat)",
    (await assignManagingBroker(memSupabase(baseSeed({
      users: [...fullAgents, { id: "brk", user_type: "broker", brokerage_id: "b1", status: "active" }],
      agents: fullAgents.map((u) => ({ id: `a-${u.id}`, user_id: u.id, brokerage_id: "b1", is_active: true })),
      brokerages: [{ id: "b1", name: "Full House", plan_tier: "team", billing_metadata: {} }],
    })), { brokerageId: "b1", locationId: null, userId: "brk", actorUserId: "adm" })).ok)
  const zero = memSupabase(baseSeed({ locations: [{ id: "loc1", brokerage_id: "b1", name: "Downtown" }] }), { refuse: { locations: "permission denied" } })
  const rz = await assignManagingBroker(zero, { brokerageId: "b1", locationId: "loc1", userId: "brk", actorUserId: "adm" })
  check("a refused office read is a refusal (unreadable), never a silent success", !rz.ok && rz.reason === "unreadable")
  check("the UPDATE is `.select('id')`-counted in source and 0 rows is a refusal", /\.eq\("id", locationId\)\.eq\("brokerage_id", brokerageId\)\s*\.select\("id"\)/.test(code(KERNEL)) && /\(written \?\? \[\]\)\.length !== 1/.test(code(KERNEL)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[5 · READINESS — every office has one, and there is at least one]")
{
  check("no offices → NOT ready (nobody is on file as responsible)", !managingBrokerReadiness([]).ready)
  check("one office with a broker → ready", managingBrokerReadiness([{ managing_broker_user_id: "u" }]).ready)
  const two = managingBrokerReadiness([{ managing_broker_user_id: "u" }, { managing_broker_user_id: null }])
  check("two offices, one unassigned → NOT ready, unassigned counted", !two.ready && two.unassigned === 1 && two.offices === 2)
  const { SETUP_ITEMS, resolveSetupReadiness } = await import("../lib/onboarding/setup-readiness")
  const item = SETUP_ITEMS.find((i) => i.key === "managing_broker")
  check("the managing_broker setup item exists: REQUIRED, broker + admin, brokerage + multi_location tiers only, deep-links to the seat door",
    !!item && item.required && item.roles.join() === "broker,admin" && (item.tiers ?? []).join() === "brokerage,multi_location" && item.href === "/dashboard/admin/billing")
  // A snapshot where EVERYTHING is done except (maybe) the managing broker — so
  // the item under test is the only thing that can move the verdict.
  const mk = (v: boolean) => new Proxy({}, { get: (_t, k) => (k === "hasManagingBroker" ? v : true) }) as any
  const brk = resolveSetupReadiness("broker", mk(false), "brokerage")
  check("a brokerage-tier broker with no managing broker on file is NOT complete and it is the next required action",
    !brk.isComplete && brk.items.some((i) => i.key === "managing_broker" && i.required && !i.done) && brk.nextAction?.key === "managing_broker")
  check("…and is complete once one is named", resolveSetupReadiness("broker", mk(true), "brokerage").isComplete)
  check("solo and team tiers do not carry the item (a team plan has no broker in the subscription)",
    !resolveSetupReadiness("broker", mk(false), "team").items.some((i) => i.key === "managing_broker") && !resolveSetupReadiness("admin", mk(false), "solo_agent").items.some((i) => i.key === "managing_broker"))
  check("the readiness loader detects from locations.managing_broker_user_id and a REFUSED read is not-ready (fail closed)",
    /select\("id, managing_broker_user_id"\)/.test(code(READINESS)) && /snap\.hasManagingBroker = !locs\.error && managingBrokerReadiness\(/.test(code(READINESS)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[6 · m661 — one scalar column on the LOCATION row; FK users(id); no uniqueness on the user]")
{
  const sql = raw(MIGRATION).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
  check("the migration file exists and adds locations.managing_broker_user_id as a uuid FK to public.users(id)",
    /ALTER TABLE public\.locations[\s\S]*ADD COLUMN IF NOT EXISTS managing_broker_user_id uuid REFERENCES public\.users\(id\)/.test(sql))
  check("the column is on `locations` (the office row), NOT on brokerages and NOT a users flag — one per location by construction",
    !/ALTER TABLE public\.brokerages/.test(sql) && !/ALTER TABLE public\.users/.test(sql))
  check("NO unique index on the user: the same broker may be broker of record for several offices (TX/FL) — every CREATE UNIQUE INDEX here is on another table",
    !/CREATE UNIQUE INDEX[^;]*ON public\.locations/.test(sql))
  control("the finder sees a unique-on-user index when one is there", /CREATE UNIQUE INDEX[^;]*ON public\.locations/.test("CREATE UNIQUE INDEX uq ON public.locations (managing_broker_user_id);"))
  check("the FK is to users(id) — never agents(id) (disjoint id classes, §3)", !/managing_broker_user_id uuid REFERENCES public\.agents/.test(sql))
  check("m661 is the number the wave assigned lane 81A (LANE_RULES: 81A m661)", /m661/.test(MIGRATION))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[7 · SURFACES — the card hides the toggle for a managing broker; the doors are mounted]")
{
  const card = code(CARD), billing = code(BILLING), action = code(ACTION)
  check("the licensed row carries managingBrokerOf from the seat door, read from locations in the same tick",
    /managingBrokerOf: string\[\]/.test(billing) && /from\("locations"\)\.select\("id, name, managing_broker_user_id"\)/.test(billing) && /managingBrokerOf: officesOf\.get\(p\.id\) \?\? \[\]/.test(billing))
  check("the card renders 'managing broker · <office>' and offers the non-producing toggle ONLY when managingBrokerOf is empty",
    /managing broker · \{p\.managingBrokerOf\.join\(", "\)\}/.test(card) && /\{p\.managingBrokerOf\.length === 0 && \(\s*<Button[\s\S]{0,400}setLicensedProducerAction\(p\.userId, !p\.producing\)/.test(card))
  control("the finder sees an unguarded toggle when one is there", !/\{p\.managingBrokerOf\.length === 0 && \(\s*<Button[\s\S]{0,400}setLicensedProducerAction/.test("<Button onClick={() => setLicensedProducerAction(p.userId, !p.producing)}>"))
  check("the card mounts the assign door (per-office select → setManagingBrokerAction) and the roster read — no orphan action",
    /import \{ listManagingBrokerSlotsAction, setManagingBrokerAction \} from "@\/app\/actions\/managing-broker"/.test(card) && /setManagingBrokerAction\(\{ locationId: s\.locationId, userId \}\)/.test(card))
  check("the action file is 'use server', gates on TENANT_COMMERCE_ADMIN_USER_TYPES (an assignment may add a seat) and takes the tenant from the SESSION",
    /^"use server"/.test(raw(ACTION)) && /TENANT_COMMERCE_ADMIN_USER_TYPES\.has\(/.test(action) && /brokerageId: auth\.brokerageId/.test(action) && !/brokerageId: input/.test(action))
  check("every export of the action file is async (a 'use server' export is a public endpoint, §4)",
    (action.match(/^export (async )?function/gm) ?? []).every((l) => /export async function/.test(l)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[8 · REGISTRATION]")
{
  const pkg = JSON.parse(raw("package.json")) as { scripts: Record<string, string> }
  check("package.json: test:managing-broker runs this guard", /scripts\/managing-broker-guard\.ts/.test(pkg.scripts["test:managing-broker"] ?? ""))
  const g = pkg.scripts.guard ?? ""
  check("guard chain: test:managing-broker runs AFTER test:scrapers (ordering only, never adjacency)", g.indexOf("npm run test:scrapers") > -1 && g.indexOf("npm run test:managing-broker") > g.indexOf("npm run test:scrapers"))
  const { MAINTENANCE_DOMAINS } = await import("../lib/kernel/manager-registry")
  const dom = MAINTENANCE_DOMAINS.managing_broker_per_location
  check("MAINTENANCE_DOMAINS.managing_broker_per_location names this proof, recruiting_manager accountable, finance_manager + data_steward co-own",
    !!dom && dom.proof === "test:managing-broker" && dom.manager === "recruiting_manager" && (dom.coOwners ?? []).join() === "finance_manager,data_steward")
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log(" Denominator: the predicate, the meter, the writer, the assigner, readiness, m661, the card + action, registration. Blind spot: the live column/table are WRITTEN NOT APPLIED until the integrator applies m661 — the meter publishes that state as managingBrokerReadRefused and the writer refuses on it; neither is asserted against a live row here.")
if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
console.log(" MANAGING_BROKER_PASS — one managing broker per location, always a producing seat, the exemption refused, the door gated and audited")
