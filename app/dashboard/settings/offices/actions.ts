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

  const { data: tenant, error: tierErr } = await svc.from("brokerages").select("plan_tier, name").eq("id", brokerageId).maybeSingle()
  if (tierErr || !tenant) redirect(done("error", "Your workspace's plan could not be read — nothing was changed."))
  const t = tenant as { plan_tier: string | null; name: string | null }

  const rec = await provisionTenantStructure(svc, {
    brokerageId, tier: t.plan_tier ?? "", ownerUserId: user.id, brokerageName: t.name ?? "", actorUserId: user.id,
    source: "admin_grant", evidence: { granted_via: "settings_offices", granter_scope: scope.kind },
    input: { members: [{ existingUserId: row.id, userType: row.user_type ?? "agent", locationId, teamId, officeLeadership: access === "leadership" }] },
  })
  revalidatePath(BACK)
  if (!rec.complete) redirect(done("error", rec.errors.join("; ") || "The placement was refused."))
  redirect(done("placed", access === "leadership" ? "Office head named." : "Placed in the office."))
}
