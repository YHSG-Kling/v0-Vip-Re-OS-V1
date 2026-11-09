/**
 * app/dashboard/settings/offices/page.tsx — Settings → Offices (wave 150, lane 150C, contract C34)
 * ─────────────────────────────────────────────────────────────────────────────
 * The tenant's hierarchy as the VIEWER may see it: office (own legal identity, territories, brand overrides, seat
 * ownership) → teams. The read model is lib/kernel/resolve-user-office.ts loadOfficeDirectory, scoped by
 * resolveViewerHierarchy: the all-office view only with a TENANT LEADERSHIP grant (or, on a single-office tenant, the
 * CLAUDE.md §4 admin roster); an office head sees their office, a team lead their team, everyone else is told so.
 * The tenant is the SESSION's (users.brokerage_id of the signed-in user) — never a parameter. Office create / edit
 * stays on Admin → Office Locations (app/actions/admin/locations.ts).
 */

import { redirect } from "next/navigation"
import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { loadOfficeDirectory } from "@/lib/kernel/resolve-user-office"
import { grantOfficeMembershipAction, revokeOfficeMembershipAction } from "./actions"

export const metadata = { title: "Offices | Settings" }

const SCOPE_LABEL: Record<string, string> = {
  tenant: "Every office (leadership access)",
  offices: "The offices you lead",
  teams: "The teams you lead",
  own: "Your own work",
}

export default async function DashboardSettingsOfficesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const placedNote = typeof sp.placed === "string" ? sp.placed : null
  const errorNote = typeof sp.error === "string" ? sp.error : null
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const svc = createServiceClient()
  const { data: me, error: meErr } = await svc.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  const brokerageId = (me as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
  const dir = meErr || !brokerageId
    ? { ok: false as const, error: meErr ? `Your workspace could not be read (${meErr.message}).` : "You are not a member of a workspace." }
    : await loadOfficeDirectory(svc, { userId: user.id, brokerageId })

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Offices</h1>
        <p className="text-muted-foreground mt-1">
          Each office keeps its own legal identity, markets, brand touches and seats; teams work out of an office.
          Two offices may share a name — they are still two offices. A person may be placed in more than one office;
          &ldquo;Move here&rdquo; ends their other office placements instead.
        </p>
      </div>

      {placedNote ? <p role="status" className="rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-900">{placedNote}</p> : null}
      {errorNote ? <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">{errorNote}</p> : null}

      {!dir.ok ? (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-900">{dir.error}</p>
      ) : (
        <>
          <p className="text-sm text-foreground">
            <span className="font-medium">What you can see:</span> {SCOPE_LABEL[dir.scope.kind] ?? dir.scope.kind}
            {dir.scope.basis.length ? <span className="text-muted-foreground"> — {dir.scope.basis.join("; ")}</span> : null}
          </p>
          {dir.scope.kind === "own" ? (
            <p className="rounded-md border p-4 text-sm">
              No offices or teams are shared with you. An office head or the brokerage&apos;s leadership can grant you access.
            </p>
          ) : dir.offices.length === 0 && dir.unassignedTeams.length === 0 ? (
            <p className="rounded-md border p-4 text-sm">No offices yet. Add one under <Link className="text-primary underline" href="/dashboard/admin/locations">Office Locations</Link>.</p>
          ) : (
            <ul className="space-y-4">
              {dir.offices.map((o) => (
                <li key={o.id} className="rounded-lg border p-4 space-y-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-lg font-semibold">{o.name}{o.officeCode ? <span className="ml-2 text-xs font-normal text-muted-foreground">code {o.officeCode}</span> : null}</h2>
                    <span className="text-xs text-foreground">{o.status === "active" ? "Active" : "Archived"}</span>
                  </div>
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                    <div><dt className="inline font-medium">Legal name: </dt><dd className="inline">{o.legalName ?? "Not stated"}{o.dba ? ` (DBA ${o.dba})` : ""}</dd></div>
                    <div><dt className="inline font-medium">Licence: </dt><dd className="inline">{o.licenseNumber ? `${o.licenseNumber}${o.licenseState ? ` · ${o.licenseState}` : ""}` : "Not stated"}</dd></div>
                    <div><dt className="inline font-medium">Where: </dt><dd className="inline">{[o.city, o.state].filter(Boolean).join(", ") || "Not stated"}</dd></div>
                    <div><dt className="inline font-medium">Seats: </dt><dd className="inline">{o.seatCap === null ? `${o.seated} in use · the plan's band applies` : `${o.seated} of ${o.seatCap} owned by this office`}</dd></div>
                    <div className="sm:col-span-2"><dt className="inline font-medium">Markets: </dt><dd className="inline">{o.territories.length ? o.territories.join(", ") : "None set yet"}</dd></div>
                    <div className="sm:col-span-2"><dt className="inline font-medium">Brand touches: </dt><dd className="inline">{Object.keys(o.brandOverrides).length ? Object.keys(o.brandOverrides).join(", ") : "Inherits the brokerage brand"}</dd></div>
                    <div className="sm:col-span-2"><dt className="inline font-medium">Office settings: </dt><dd className="inline">{Object.keys(o.settings).length ? Object.keys(o.settings).join(", ") : "Brokerage defaults"}</dd></div>
                    <div className="sm:col-span-2"><dt className="inline font-medium">Opened by: </dt><dd className="inline">{o.createdBy ?? "Not recorded"}</dd></div>
                  </dl>
                  <div>
                    <h3 className="text-sm font-medium">Teams</h3>
                    {o.teams.length ? (
                      <ul className="mt-1 list-disc pl-5 text-sm">{o.teams.map((t) => <li key={t.id}>{t.name} — {t.members} member{t.members === 1 ? "" : "s"}</li>)}</ul>
                    ) : <p className="text-sm text-muted-foreground">No teams in this office yet.</p>}
                  </div>
                  <div>
                    <h3 className="text-sm font-medium">People placed here</h3>
                    {o.placements.length ? (
                      <ul className="mt-1 list-disc pl-5 text-sm">
                        {o.placements.map((p) => (
                          <li key={p.membershipId}>
                            {p.name}{p.team ? ` — ${p.team}` : ""} · {p.access === "leadership" ? (p.team ? "team lead" : "office head") : p.role.replace(/_/g, " ")}
                            {dir.scope.aggregate || p.access !== "leadership" ? (
                              <form action={revokeOfficeMembershipAction} className="ml-2 inline">
                                <input type="hidden" name="membershipId" value={p.membershipId} />
                                <button type="submit" className="rounded border px-2 py-0.5 text-xs font-medium text-foreground hover:bg-muted" aria-label={`Remove ${p.name} from this ${p.team ? "team" : "office"}`}>Remove</button>
                              </form>
                            ) : null}
                            <span className="text-muted-foreground">
                              {" "}· placed {p.joinedAt ? new Date(p.joinedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "on an unrecorded date"}
                              {p.grantedBy ? ` by ${p.grantedBy}` : ""} via {p.source.replace(/_/g, " ")}
                              {p.evidence.length ? ` (evidence: ${p.evidence.join(", ")})` : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : <p className="text-sm text-muted-foreground">No one placed here yet.</p>}
                  </div>
                  {dir.people.length ? (
                    <form action={grantOfficeMembershipAction} className="flex flex-wrap items-end gap-2 border-t pt-3 text-sm">
                      <input type="hidden" name="locationId" value={o.id} />
                      <label className="flex flex-col gap-1">
                        <span className="font-medium">Place a person</span>
                        <select name="memberId" required className="rounded border px-2 py-1">
                          {dir.people.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.userType.replace(/_/g, " ")})</option>)}
                        </select>
                      </label>
                      {o.teams.length ? (
                        <label className="flex flex-col gap-1">
                          <span className="font-medium">Team (optional)</span>
                          <select name="teamId" className="rounded border px-2 py-1">
                            <option value="">No team</option>
                            {o.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                          </select>
                        </label>
                      ) : null}
                      {dir.scope.aggregate ? (
                        <label className="flex flex-col gap-1">
                          <span className="font-medium">Access</span>
                          <select name="access" className="rounded border px-2 py-1">
                            <option value="member">Member</option>
                            <option value="leadership">Office head</option>
                          </select>
                        </label>
                      ) : <input type="hidden" name="access" value="member" />}
                      {dir.scope.aggregate ? (
                        <label className="flex items-center gap-2 pb-1.5">
                          <input type="checkbox" name="move" value="1" className="h-4 w-4" />
                          <span>Move here (end their other office placements)</span>
                        </label>
                      ) : null}
                      <button type="submit" className="rounded bg-primary px-3 py-1.5 font-medium text-primary-foreground">Place</button>
                    </form>
                  ) : null}
                </li>
              ))}
              <li className="rounded-lg border p-4">
                <h2 className="text-lg font-semibold">Recent removals</h2>
                {dir.recentRemovals.length ? (
                  <ul className="mt-1 list-disc pl-5 text-sm">
                    {dir.recentRemovals.map((r) => (
                      <li key={r.membershipId}>
                        {r.name} — {r.team ? `team ${r.team}` : "office placement"} · removed {new Date(r.removedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}{r.removedBy ? ` by ${r.removedBy}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-muted-foreground">No removals yet.</p>}
              </li>
              {dir.unassignedTeams.length ? (
                <li className="rounded-lg border p-4">
                  <h2 className="text-lg font-semibold">Teams not placed in an office</h2>
                  <ul className="mt-1 list-disc pl-5 text-sm">{dir.unassignedTeams.map((t) => <li key={t.id}>{t.name} — {t.members} member{t.members === 1 ? "" : "s"}</li>)}</ul>
                </li>
              ) : null}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
