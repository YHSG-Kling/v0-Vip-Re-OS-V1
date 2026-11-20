"use server"

/**
 * app/dashboard/settings/offices/actions.ts — the EXPLICIT membership door (wave 150, lane 150C, contract C34).
 * ─────────────────────────────────────────────────────────────────────────────
 * Places a person of THIS workspace in an office (and optionally one of its teams), or makes them that office's
 * head. Every rule is the hierarchy's own, checked against the GRANTER:
 *   · the tenant is the SESSION's (users.brokerage_id of the signed-in user) — never a form field;
 *   · the granter must SEE the office (lib/kernel/resolve-user-office.ts resolveViewerHierarchy) — an office head
 *     places people into their own office only; nobody below leadership places anyone;
 *   · OFFICE LEADERSHIP may only be granted by someone holding TENANT leadership (the aggregated view) — an office
 *     head cannot mint a second head, and a user_type never stands in for the grant;
 *   · the person must already sit in this workspace (provisionTenantStructure refuses anyone else — moving a person
 *     between workspaces is the consented transfer rail's job, never a name match);
 *   · the office's own seat ownership is enforced (lib/kernel/seat-usage.ts locationSeatGate).
 * Evidence: the membership row carries granted_by_user_id + source 'admin_grant' + evidence, and the placement's
 * outcome is evidenced / routed by provisionTenantStructure (seat_provisioning). Fail closed on every read.
 *
 * revokeOfficeMembershipAction (integrator, wave 150 — the census found revoked_at read by the hierarchy answer and
 * written by nobody): the grant's twin. The same granter scope that may PLACE a person in an office may REMOVE them
 * from it; an office head's own leadership grant is revoked only by tenant leadership. The row is never deleted — it is
 * stamped revoked_at / revoked_by_user_id (the audit stays) and the write is count-checked and ledgered.
 */

import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveViewerHierarchy } from "@/lib/kernel/resolve-user-office"
import { provisionTenantStructure, MEMBERSHIP_ACCESS_LEVELS } from "@/lib/kernel/tenant-creation"

const BACK = "/dashboard/settings/offices"
const done = (key: "placed" | "error", msg: string) => `${BACK}?${key}=${encodeURIComponent(msg.slice(0, 240))}`

export async function grantOfficeMembershipAction(formData: FormData): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const svc = createServiceClient()
  const { data: me, error: meErr } = await svc.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  const brokerageId = (me as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
  if (meErr || !brokerageId) redirect(done("error", meErr ? `Your workspace could not be read (${meErr.message}).` : "You are not a member of a workspace."))

  const memberId = String(formData.get("memberId") ?? "").trim()
  const locationId = String(formData.get("locationId") ?? "").trim()
  const teamId = String(formData.get("teamId") ?? "").trim() || null
  const access = String(formData.get("access") ?? "member").trim()
  // MOVE vs ADD (wave 151, lane 151A): "move" ends the person's other office placements (seat reassignment); the default
  // adds a placement and keeps the others (a person may hold several memberships).
  const reassign = String(formData.get("move") ?? "") === "1"
  if (!memberId || !locationId) redirect(done("error", "Choose a person and an office."))
  if (!(MEMBERSHIP_ACCESS_LEVELS as readonly string[]).includes(access)) redirect(done("error", "Unknown access level."))

  const granter = await resolveViewerHierarchy(svc, { userId: user.id, brokerageId })
  if (!granter.ok) redirect(done("error", `Your access could not be checked (${granter.error}) — nothing was changed.`))
  const scope = granter.scope
  if (!scope.aggregate && !scope.locationIds.includes(locationId)) redirect(done("error", "You can only place people in an office you lead."))
  if (teamId && !scope.aggregate && !scope.teamIds.includes(teamId)) redirect(done("error", "You can only place people in a team you lead."))
  if (access === "leadership" && !scope.aggregate) redirect(done("error", "Only the brokerage's leadership can name an office head."))

  const { data: person, error: personErr } = await svc.from("users").select("id, user_type, location_id").eq("id", memberId).eq("brokerage_id", brokerageId).maybeSingle()
  if (personErr) redirect(done("error", `That person could not be read (${personErr.message}) — nothing was changed.`))
  const row = person as { id: string; user_type: string | null; location_id: string | null } | null
  if (!row) redirect(done("error", "That person is not a member of this workspace."))
  if (!scope.aggregate && row.location_id && !scope.locationIds.includes(row.location_id)) redirect(done("error", "That person works out of another office — ask the brokerage's leadership to move them."))
  // A MOVE ends placements in offices the granter may not see; only the aggregated view may do that.
  if (reassign && !scope.aggregate) redirect(done("error", "Only the brokerage's leadership can move a person between offices — you can add them to an office you lead."))

  const { data: tenant, error: tierErr } = await svc.from("brokerages").select("plan_tier, name").eq("id", brokerageId).maybeSingle()
  if (tierErr || !tenant) redirect(done("error", "Your workspace's plan could not be read — nothing was changed."))
  const t = tenant as { plan_tier: string | null; name: string | null }

  const rec = await provisionTenantStructure(svc, {
    brokerageId, tier: t.plan_tier ?? "", ownerUserId: user.id, brokerageName: t.name ?? "", actorUserId: user.id,
    source: "admin_grant", evidence: { granted_via: "settings_offices", granter_scope: scope.kind, mode: reassign ? "move" : "add" },
    input: { members: [{ existingUserId: row.id, userType: row.user_type ?? "agent", locationId, teamId, officeLeadership: access === "leadership", reassign }] },
  })
  revalidatePath(BACK)
  if (!rec.complete) redirect(done("error", rec.errors.join("; ") || "The placement was refused."))
  const moved = rec.revoked ? ` ${rec.revoked} earlier placement${rec.revoked === 1 ? "" : "s"} ended.` : ""
  redirect(done("placed", (access === "leadership" ? "Office head named." : reassign ? "Moved to this office." : "Placed in the office.") + moved))
}

export async function revokeOfficeMembershipAction(formData: FormData): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const svc = createServiceClient()
  const { data: me, error: meErr } = await svc.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  const brokerageId = (me as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
  if (meErr || !brokerageId) redirect(done("error", meErr ? `Your workspace could not be read (${meErr.message}).` : "You are not a member of a workspace."))

  const membershipId = String(formData.get("membershipId") ?? "").trim()
  if (!membershipId) redirect(done("error", "Choose a placement to remove."))

  const granter = await resolveViewerHierarchy(svc, { userId: user.id, brokerageId })
  if (!granter.ok) redirect(done("error", `Your access could not be checked (${granter.error}) — nothing was changed.`))
  const scope = granter.scope

  // The membership must be THIS tenant's and still active; its scope must sit inside the granter's.
  const { data: m, error: mErr } = await svc.from("organization_members")
    .select("id, user_id, scope_kind, location_id, team_id, access_level")
    .eq("id", membershipId).eq("brokerage_id", brokerageId).is("revoked_at", null).maybeSingle()
  if (mErr) redirect(done("error", `That placement could not be read (${mErr.message}) — nothing was changed.`))
  const row = m as { id: string; user_id: string; scope_kind: string; location_id: string | null; team_id: string | null; access_level: string } | null
  if (!row) redirect(done("error", "That placement is not active in this workspace."))
  if (row.scope_kind === "tenant") redirect(done("error", "Workspace-level leadership is not removed here — it belongs to the brokerage's owner settings."))
  if (!scope.aggregate) {
    if (row.scope_kind === "location" && (!row.location_id || !scope.locationIds.includes(row.location_id))) redirect(done("error", "You can only remove people from an office you lead."))
    if (row.scope_kind === "team" && (!row.team_id || !scope.teamIds.includes(row.team_id))) redirect(done("error", "You can only remove people from a team you lead."))
    if (row.access_level === "leadership") redirect(done("error", "Only the brokerage's leadership can remove an office head."))
  }

  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const nowIso = new Date().toISOString()
  const result = await withActionLedger(
    {
      brokerageId, action: "office.membership.revoke", actor: { type: "user", userId: user.id },
      subject: { type: "organization_member", id: row.id }, reasonCode: "HUMAN_REQUESTED", systemSource: "settings_offices",
      reasonDetail: `removed a ${row.scope_kind} ${row.access_level} placement (granter scope ${scope.kind})`,
      riskClass: "OPERATIONAL", cycle: `office_membership_revoke:${row.id}`,
      detail: { membership_id: row.id, member_user_id: row.user_id, scope_kind: row.scope_kind, location_id: row.location_id, team_id: row.team_id, access_level: row.access_level },
    },
    async () => {
      const { data, error } = await svc.from("organization_members")
        .update({ revoked_at: nowIso, revoked_by_user_id: user.id, updated_at: nowIso })
        .eq("id", row.id).eq("brokerage_id", brokerageId).is("revoked_at", null)
        .select("id")
      if (error) return { n: 0, error: error.message as string }
      return { n: (data ?? []).length, error: null as string | null }
    },
    {
      settle: (r) => r.n === 1 ? { status: "executed", outcome: "office_membership_revoked", costUsd: null } : { status: "failed", outcome: "revocation_matched_nothing", error: r.error ?? "0 rows matched" },
      // A refused ledger claim is NOT a replay: say which it was (the evidence census reads this hook).
      replay: (claim) => ({ n: 0, error: claim.kind === "refused" ? `the removal could not be recorded on the action ledger (${claim.error}) — nothing was changed` : "this removal was already recorded" }),
    },
    { client: svc },
  )
  revalidatePath(BACK)
  if (result.n !== 1) redirect(done("error", `Not removed — ${result.error ?? "the placement changed underneath you"}`))
  redirect(done("placed", "Removed from the office."))
}
