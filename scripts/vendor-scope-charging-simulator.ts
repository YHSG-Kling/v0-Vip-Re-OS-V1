#!/usr/bin/env tsx
/**
 * scripts/vendor-scope-charging-simulator.ts
 *   run: npx tsx scripts/vendor-scope-charging-simulator.ts
 *   suggested npm script (NOT added here — package.json is owned elsewhere):
 *     "test:vendor-scope-charging": "tsx scripts/vendor-scope-charging-simulator.ts"
 *
 * ROUND 37 PROOF — "agents and teams can invite vendors and charge them also":
 *
 *  Layer 1 (pure): invite gate covers agent + team_lead (round-15 openness kept,
 *    mirrored constants can't drift), charge-scope resolution (led team → team,
 *    agent → agent, admin → brokerage), the zero-amount charge_attribution
 *    line-item round-trips, "THEIR vendors" gate, mark-paid management matrix.
 *  Layer 2 (behavioral, stubbed I/O): resolveVendorActorScope reads
 *    teams.team_lead_id (users.id — never agents.id) and agents.team_id.
 *  Layer 3 (source locks): the invite action stamps first-inviter-wins
 *    attribution and rides the EXISTING governed sends (Supabase auth invite /
 *    dispatchEmail — no new raw senders); issueVendorCharge appends attribution
 *    and gates agents on migration-1106 columns with an honest pre-migration
 *    error; the vendors page keeps ONE brokerage-wide charge query (admin
 *    visibility, no scope fork); premium placement stays a documented
 *    brokerage-level verdict with untouched internals; migration 1106 SQL exists.
 */

import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import {
  VENDOR_INVITE_ROLES,
  VENDOR_CHARGE_ADMIN_ROLES,
  canInviteVendors,
  vendorChargeScopeForActor,
  buildChargeAttribution,
  findChargeAttribution,
  agentMayChargeVendor,
  canManageVendorCharge,
  resolveVendorActorScope,
  PREMIUM_PLACEMENT_SCOPE,
  PREMIUM_PLACEMENT_SCOPE_VERDICT,
  CHARGE_ATTRIBUTION_TYPE,
} from "../lib/vendors/vendor-scope"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function section(title: string) { console.log(`\n■ ${title}`) }

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 1 — invite gate (every tier can invite; leaf actors cannot)")

for (const role of ["agent", "team_lead", "broker", "broker_admin", "admin", "superadmin"]) {
  check(`${role} can invite vendors`, canInviteVendors(role))
}
for (const role of ["vendor", "contact", "tc", "", null] as const) {
  check(`${String(role ?? "null")} cannot invite vendors`, !canInviteVendors(role as any))
}

// THE MIRROR IS GONE, AND THAT IS THE POINT.
//
// This used to regex a local `INVITE_ALLOWED_ROLES = new Set([...])` out of
// app/actions/vendor-invite.ts and compare it, member by member, against
// VENDOR_INVITE_ROLES — a "these two copies must not drift" assertion. Wave 6
// removed the second copy: the action now calls the shared predicate
// `canInviteVendors(caller.user_type)` directly, so there is exactly ONE role
// list on the platform and drift is not possible rather than merely detected.
//
// Asserting the mirror still exists would have demanded the duplicate be
// restored to keep a proof green — a guard forcing the anti-pattern it was
// written to police. So assert the stronger, simpler property: the action holds
// NO private role list, and it gates through the one shared door.
const inviteSrc = src("app/actions/vendor-invite.ts")
{
  check("the invite action keeps NO private copy of the role list — the mirror\n    was collapsed onto lib/vendors/vendor-scope.ts, so it cannot drift",
    !/INVITE_ALLOWED_ROLES\s*=\s*new Set/.test(inviteSrc),
    `local set present: ${/INVITE_ALLOWED_ROLES\s*=\s*new Set/.test(inviteSrc)}`)
  check("...and it gates through the shared predicate canInviteVendors()",
    /if \(!canInviteVendors\(caller\.user_type\)\)/.test(inviteSrc))
  // The membership question the deleted assertion really cared about, asked of
  // the surviving single source of truth instead of a copy of it.
  check("the one surviving role list still admits agent AND team_lead",
    VENDOR_INVITE_ROLES.has("agent") && VENDOR_INVITE_ROLES.has("team_lead"))
}

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 1b — charge scope resolution (pure)")

check("team lead → team scope with the LED team",
  (() => { const r = vendorChargeScopeForActor({ userType: "team_lead", ledTeamId: "t-1", membershipTeamId: null }); return r.scope === "team" && r.teamId === "t-1" })())
check("agent who leads a team → team scope (the charge is the team's story)",
  vendorChargeScopeForActor({ userType: "agent", ledTeamId: "t-1", membershipTeamId: "t-2" }).scope === "team")
check("team-member agent → agent scope, membership team recorded",
  (() => { const r = vendorChargeScopeForActor({ userType: "agent", ledTeamId: null, membershipTeamId: "t-2" }); return r.scope === "agent" && r.teamId === "t-2" })())
check("solo agent → agent scope, no team",
  (() => { const r = vendorChargeScopeForActor({ userType: "agent", ledTeamId: null, membershipTeamId: null }); return r.scope === "agent" && r.teamId === null })())
check("broker → brokerage scope",
  vendorChargeScopeForActor({ userType: "broker", ledTeamId: null, membershipTeamId: null }).scope === "brokerage")

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 1c — charge attribution line item (typed, zero-amount, round-trips)")

const attr = buildChargeAttribution({ scope: "agent", userId: "u-1", teamId: "t-2" })
check("attribution entry is typed + zero-amount (never changes invoice totals)",
  attr.type === CHARGE_ATTRIBUTION_TYPE && attr.amount === 0 && attr.quantity === 0 && attr.unitPrice === 0)
{
  // The exact subtotal math createVendorInvoice uses: Σ line.amount.
  const userItems = [{ description: "Sponsorship", quantity: 1, unitPrice: 250, amount: 250 }]
  const withAttr = [...userItems, attr]
  const subtotal = withAttr.reduce((s, l: any) => s + l.amount, 0)
  check("subtotal with attribution appended == user line items alone", subtotal === 250)
  const found = findChargeAttribution(withAttr)
  check("findChargeAttribution round-trips {scope, user_id, team_id}",
    !!found && found.scope === "agent" && found.user_id === "u-1" && found.team_id === "t-2")
}
check("findChargeAttribution ignores plain line items and junk",
  findChargeAttribution([{ description: "x", amount: 5 }]) === null
  && findChargeAttribution("nope") === null
  && findChargeAttribution([{ type: "charge_attribution" }]) === null) // no user_id → not attribution

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 1d — \"THEIR vendors\" gate + mark-paid management matrix")

check("agent may charge a vendor THEY invited",
  agentMayChargeVendor({ invitedByUserId: "u-1", invitedByTeamId: null }, { userId: "u-1", teamId: null }))
check("agent may charge a vendor their TEAM brought",
  agentMayChargeVendor({ invitedByUserId: "u-9", invitedByTeamId: "t-2" }, { userId: "u-1", teamId: "t-2" }))
check("agent may NOT charge an unattributed (brokerage) vendor",
  !agentMayChargeVendor({ invitedByUserId: null, invitedByTeamId: null }, { userId: "u-1", teamId: "t-2" }))
check("agent may NOT charge another agent's vendor",
  !agentMayChargeVendor({ invitedByUserId: "u-9", invitedByTeamId: "t-9" }, { userId: "u-1", teamId: "t-2" }))

const agentAttr = buildChargeAttribution({ scope: "agent", userId: "u-1", teamId: null })
check("admin roles manage ANY vendor charge (brokerage visibility, no forks)",
  ["broker", "broker_owner", "broker_admin", "admin", "superadmin", "team_lead"].every((r) =>
    VENDOR_CHARGE_ADMIN_ROLES.has(r)
    && canManageVendorCharge({ userType: r, callerUserId: "someone-else", attribution: agentAttr })))
check("the raising agent manages their own charge",
  canManageVendorCharge({ userType: "agent", callerUserId: "u-1", attribution: agentAttr }))
check("a DIFFERENT agent cannot manage it",
  !canManageVendorCharge({ userType: "agent", callerUserId: "u-2", attribution: agentAttr }))
check("an agent cannot manage an unattributed (brokerage-raised) charge",
  !canManageVendorCharge({ userType: "agent", callerUserId: "u-1", attribution: null }))
check("agents are NOT in the admin charge set (they go through attribution)",
  !VENDOR_CHARGE_ADMIN_ROLES.has("agent"))

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 2 — resolveVendorActorScope (stubbed I/O, zero network)")

function stubSvc(tables: Record<string, { data: unknown; error: null } >, log: Array<{ table: string; filters: Record<string, unknown> }>) {
  const builder = (table: string) => {
    const filters: Record<string, unknown> = {}
    const b: any = {
      select: () => b,
      eq: (k: string, v: unknown) => { filters[k] = v; return b },
      is: (k: string, v: unknown) => { filters[k] = v; return b },
      limit: () => b,
      maybeSingle: async () => { log.push({ table, filters }); return tables[table] ?? { data: null, error: null } },
    }
    return b
  }
  return { from: (t: string) => builder(t) } as any
}

{
  const log: Array<{ table: string; filters: Record<string, unknown> }> = []
  const svc = stubSvc({ teams: { data: { id: "t-led" }, error: null }, agents: { data: { team_id: "t-member" }, error: null } }, log)
  const r = await resolveVendorActorScope(svc, { userId: "u-1", userType: "agent", brokerageId: "b-1" })
  check("lead of a team → team scope on the LED team (membership recorded separately)",
    r.scope === "team" && r.teamId === "t-led" && r.membershipTeamId === "t-member")
  const teamRead = log.find((l) => l.table === "teams")
  check("led-team lookup keys on teams.team_lead_id = users.id (never agents.id)",
    !!teamRead && teamRead.filters.team_lead_id === "u-1" && teamRead.filters.brokerage_id === "b-1")
}
{
  const svc = stubSvc({ teams: { data: null, error: null }, agents: { data: { team_id: "t-2" }, error: null } }, [])
  const r = await resolveVendorActorScope(svc, { userId: "u-1", userType: "agent", brokerageId: "b-1" })
  check("team-member agent → agent scope, team recorded for attribution", r.scope === "agent" && r.teamId === "t-2")
}
{
  const svc = stubSvc({ teams: { data: null, error: null }, agents: { data: null, error: null } }, [])
  const r = await resolveVendorActorScope(svc, { userId: "u-b", userType: "broker", brokerageId: "b-1" })
  check("broker with no team → brokerage scope", r.scope === "brokerage" && r.teamId === null)
}

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 3 — source locks: invite attribution + existing governed sends")

check("invite action stamps vendor attribution first-inviter-wins (.is invited_by_user_id null guard)",
  inviteSrc.includes("stampVendorInviteAttribution")
  && inviteSrc.includes('.is("invited_by_user_id", null)')
  && inviteSrc.includes("invited_by_team_id"))
check("invite attribution resolves the inviter's team via the shared scope resolver (led team wins)",
  inviteSrc.includes("resolveVendorActorScope")
  && /ledTeamId \?\? actorScope\.membershipTeamId/.test(inviteSrc))
check("accept flow back-fills attribution from the invitation's recorded inviter (legacy invites)",
  inviteSrc.includes("invitation.invited_by") && /invitedByTeamId: null/.test(inviteSrc))
check("invite email is the EXISTING Supabase auth invite (no new raw sender)",
  inviteSrc.includes("auth.admin.inviteUserByEmail")
  && !inviteSrc.includes("nodemailer") && !inviteSrc.includes("sendgrid")
  && !inviteSrc.includes('from "@/lib/providers/messaging"'))
check("attribution stamp is best-effort with an honest migration-1106 warning (invite never fails on it)",
  /migration 1106/.test(inviteSrc) && inviteSrc.includes("console.warn"))

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 3b — source locks: the ONE charging lane, scope-aware")

const paySrc = src("app/actions/vendor-payments.ts")
check("vendor-payments imports the shared scope model (no local re-derivation)",
  paySrc.includes('from "@/lib/vendors/vendor-scope"')
  && paySrc.includes("VENDOR_CHARGE_ADMIN_ROLES")
  && !paySrc.includes("const VENDOR_CHARGE_ADMIN_ROLES = new Set"))
check("issueVendorCharge admits agents alongside leadership (one lane, three scopes)",
  /isAdminCharger && ctx\.userType !== "agent"/.test(paySrc))
check("agent path enforces the THEIR-vendors gate on migration-1106 columns",
  paySrc.includes("agentMayChargeVendor")
  && paySrc.includes('select("invited_by_user_id, invited_by_team_id")'))
check("pre-migration agent charge fails with an HONEST migration-1106 message (no silent fallback)",
  /migration 1106 \(vendors\.invited_by_user_id/.test(paySrc))
check("every charge carries the zero-amount attribution entry (premium-placement typed-line-item idiom)",
  paySrc.includes("buildChargeAttribution"))
check("charges stay billed_to='vendor' through the SAME createVendorInvoice",
  /billedTo: "vendor"/.test(paySrc))
check("markVendorChargePaid: agent allowed only for a charge THEY raised (attribution match)",
  paySrc.includes("canManageVendorCharge") && paySrc.includes("findChargeAttribution"))
check("vendor charges still never mint vendor_earnings (money flows vendor → brokerage)",
  /billed_to === "vendor"/.test(paySrc) && paySrc.includes("must NOT mint vendor earnings"))
check("vendor charge notification rides governed dispatchEmail as transactional (no raw sender)",
  paySrc.includes('systemSource: "vendor_charge"')
  && /channelPurpose: "transactional"/.test(paySrc)
  && !paySrc.includes('from "@/lib/providers/messaging"'))

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 3c — source locks: surfaces (agent-visible, brokerage-visible, no forks)")

const pageSrc = src("app/dashboard/vendors/page.tsx")
const panelSrc = src("app/dashboard/vendors/vendor-charges-panel.tsx")
check("vendors page keeps ONE brokerage-wide charge query (billed_to='vendor', brokerage anchor — admins see agent/team charges)",
  pageSrc.includes('.eq("billed_to", "vendor")')
  && pageSrc.includes('.eq("brokerage_id", profile.brokerage_id)')
  && !pageSrc.includes('.eq("attributed_user_id"'))
check("page extracts attribution from line_items and passes viewer identity to the panel",
  pageSrc.includes("findChargeAttribution") && pageSrc.includes("viewerUserId={profile.id}")
  && pageSrc.includes("chargeableVendorIds"))
check("page computes the agent's chargeable set from invited_by_* (own OR team), soft pre-migration",
  pageSrc.includes("invited_by_user_id.eq.") && pageSrc.includes("invited_by_team_id.eq."))
check("panel renders for agents too (no manager-only wall)",
  panelSrc.includes('userRole === "agent"') && /if \(!isManager && !isAgent\) return null/.test(panelSrc))
check("panel narrows agents to their attributed vendors + their own raised charges (mirrors server gates)",
  panelSrc.includes("chargeableVendorIds") && panelSrc.includes("attributed_user_id === viewerUserId"))
check("panel shows an honest empty state when the agent has no attributed vendors",
  panelSrc.includes("No vendors are attributed to you yet"))

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 3d — premium placement: documented brokerage-level verdict (not faked team scope)")

check("verdict constant: placement scope is 'brokerage'", PREMIUM_PLACEMENT_SCOPE === "brokerage")
check("verdict documents WHY (brokerage-wide placement flags, no team-scoped surface)",
  /brokerage-wide vendor placement flags/.test(PREMIUM_PLACEMENT_SCOPE_VERDICT)
  && /no team- or agent-scoped directory/.test(PREMIUM_PLACEMENT_SCOPE_VERDICT))
// COMMENT-STRIPPED on purpose. `src` reads raw, and this asserts what the module
// DOES, not what it says. The header legitimately narrates the m355 merge (and so
// names the dropped table); reading prose as code made a truthful comment fail a
// check about queries.
const placementSrc = src("lib/vendors/premium-placement.ts")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "")
// The flags moved onto `vendors` in m355; the SCOPE claim is unchanged, and that
// is what this asserts — a brokerage-anchored flip of the placement flags.
//
// The `team_id` clause is the load-bearing half: `vendors` now HAS a team_id
// column, so this proves premium-placement never reads or writes it. A placement
// that quietly narrowed to one team would contradict the verdict above while the
// scope constant still said "brokerage".
check("premium-placement flips brokerage-anchored placement flags, and nothing team-scoped",
  placementSrc.includes('.from("vendors")')
  && !placementSrc.includes("vendor_directory")
  && placementSrc.includes("preferred: true")
  && placementSrc.includes('.eq("brokerage_id", brokerageId)')
  && !placementSrc.includes("team_id"))

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 3e — migration 1106 SQL (written + reported, not applied here)")

const mig = src("scripts/1106-vendor-invite-attribution.sql")
check("adds vendors.invited_by_user_id + invited_by_team_id (IF NOT EXISTS)",
  mig.includes("ADD COLUMN IF NOT EXISTS invited_by_user_id UUID REFERENCES public.users(id)")
  && mig.includes("ADD COLUMN IF NOT EXISTS invited_by_team_id UUID REFERENCES public.teams(id)"))
check("backfills first inviter from vendor_invitations (m1057 invited_by), first-wins",
  mig.includes("DISTINCT ON (vendor_id)") && mig.includes("invited_by_user_id IS NULL"))
check("does NOT fabricate team history in the backfill",
  /Team attribution is NOT backfilled/i.test(mig) && !/SET invited_by_team_id/.test(mig))

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}\n${fail === 0 ? "✅" : "❌"} vendor-scope-charging simulator: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
