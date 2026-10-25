/**
 * lib/forms/form-path-scope.ts — WHOSE is a `brokerage-forms` object path?
 *
 * The FormWizard reads and writes the private `brokerage-forms` bucket through three
 * server actions that run on the SERVICE client (prefillStorageFormAction,
 * buildEsignAnchorPlanAction, and the e-sign dispatch). Each took a caller-supplied
 * `formPath` and downloaded it with no ownership check — any signed-in user could name
 * `brokerage/<another tenant>/…` or a `filled/…` copy (which carries a buyer's name,
 * price and terms) and get it back as a signed preview URL. Lane 88C closes that with
 * ONE predicate every door asks (CLAUDE.md §4: tenant from the session, never the body).
 *
 * The bucket's own layout:
 *   brokerage/{brokerageId}/…                     the brokerage library (loose files)
 *   brokerage/{brokerageId}/packets/{rowId}/…     a REGISTERED brokerage packet (brokerage_form_library row, wave 144)
 *   teams/{teamId}/…                              the team library (loose files)
 *   teams/{teamId}/packets/{rowId}/…              a REGISTERED team packet — shared with that team only (wave 144)
 *   agents/{userId}/…                             the agent's own library + uploads/
 *   filled/{userId | offerId}/…                   filled copies written by prefillStorageFormAction
 *   platform/{packetId}/{file}.pdf                the platform CATALOGUE master — NOT fillable by a tenant (see below)
 *
 * WAVE 144 (lane 144C — owner ruling 3: "Form packets are NOT platform-owned … Agents only see packets reachable through their
 * actual memberships/permissions; no cross-tenant/team leakage"):
 *   · TEAM paths are judged by the person's ACTUAL membership (lib/kernel/resolve-user-team.ts, the twin of RLS's
 *     resolve_team_id), not only by the `teamId` a caller happened to read off users.team_id — a team lead whose users row carries
 *     no team_id was refused their own team's library, and a stale users.team_id was the only key.
 *   · a REGISTERED packet path is admitted only while its library row is active, in licence, EXACTLY that path, and visible to
 *     the actor (lib/forms/tenant-form-packets.ts usableTenantPacketPaths) — retiring a packet stops it being fillable at once.
 *   · TOMBSTONE: `platform/…` was admitted for every tenant while its m807 row was approved (wave 143). It is REFUSED now: a
 *     catalogue packet reaches agents only after their brokerage adds it to its own library (lib/forms/platform-form-packets.ts
 *     addPlatformPacketToLibrary), and then it is a `brokerage/…/packets/…` or `teams/…/packets/…` path like any other.
 */

import { parseTenantPacketPath, resolvePacketActor, usableTenantPacketPaths, type PacketActor } from "./tenant-form-packets"

// File-local (opposite-missing cat 3, lane 89E): no other file names this type.
type FormPathOwner =
  | { kind: "brokerage"; id: string }
  | { kind: "team"; id: string }
  | { kind: "agent"; id: string }
  | { kind: "filled"; id: string }
  | { kind: "platform"; id: string }

const PREFIX_KIND: Record<string, FormPathOwner["kind"]> = {
  brokerage: "brokerage",
  teams: "team",
  agents: "agent",
  filled: "filled",
  platform: "platform",
}

/** PURE: parse the owner segment of a form path. null = malformed / traversal / unknown root.
 */
function formPathOwner(path: string | null | undefined): FormPathOwner | null {
  if (!path || typeof path !== "string") return null
  if (path.startsWith("/") || path.includes("..") || path.includes("\\") || /^[a-z]+:\/\//i.test(path)) return null
  const [root, id, ...rest] = path.split("/")
  const kind = PREFIX_KIND[root]
  if (!kind || !id || rest.length === 0 || rest.join("/").trim() === "") return null
  return { kind, id } as FormPathOwner
}

export interface FormPathActor { brokerageId: string; teamId: string | null; userId: string }

type Verdict = "allowed" | "refused" | "needsOfferCheck" | "needsPacketCheck" | "needsTeamCheck"

/**
 * PURE part of the verdict. `filled/{id}` is in scope when id is the actor's own user id;
 * any OTHER filled id must be proven to be one of the actor's brokerage's offers — that
 * proof needs the database, so it comes back as `needsOfferCheck`. A registered packet needs its
 * library row (`needsPacketCheck`); a loose team file outside the caller's stated team needs the
 * actor's real membership (`needsTeamCheck`).
 */
function formPathVerdict(path: string, actor: FormPathActor): Verdict {
  const owner = formPathOwner(path)
  if (!owner) return "refused"
  switch (owner.kind) {
    case "brokerage":
      if (owner.id !== actor.brokerageId) return "refused"
      return path.split("/")[2] === "packets" ? (parseTenantPacketPath(path) ? "needsPacketCheck" : "refused") : "allowed"
    case "team":
      if (path.split("/")[2] === "packets") return parseTenantPacketPath(path) ? "needsPacketCheck" : "refused"
      return actor.teamId && owner.id === actor.teamId ? "allowed" : "needsTeamCheck"
    case "agent":     return owner.id === actor.userId ? "allowed" : "refused"
    case "filled":    return owner.id === actor.userId ? "allowed" : "needsOfferCheck"
    // The platform catalogue is not a tenant's to fill (wave 144 — see the header).
    case "platform":  return "refused"
  }
}

type OfferReader = {
  from: (t: "offers") => {
    select: (c: string) => { in: (col: string, ids: string[]) => { eq: (col: string, v: string) => PromiseLike<{ data: Array<{ id: string }> | null; error: { message: string } | null }> } }
  }
}

/**
 * Every path in scope for the actor, or the list that is not. A refused offer read FAILS
 * CLOSED (the path is refused and the reason is returned), never waved through. So does a
 * membership or library read that could not run.
 */
export async function checkFormPathsInScope(
  svc: unknown,
  paths: string[],
  actor: FormPathActor,
): Promise<{ ok: boolean; refused: string[]; error?: string }> {
  const refused: string[] = []
  const offerChecks = new Map<string, string[]>()
  const packetPaths: string[] = []
  const teamPaths: string[] = []
  for (const p of paths) {
    const v = formPathVerdict(p, actor)
    if (v === "refused") refused.push(p)
    else if (v === "needsPacketCheck") packetPaths.push(p)
    else if (v === "needsTeamCheck") teamPaths.push(p)
    else if (v === "needsOfferCheck") {
      const id = formPathOwner(p)!.id
      offerChecks.set(id, [...(offerChecks.get(id) ?? []), p])
    }
  }
  // The actor's REAL membership, resolved once and only when a path needs it. The brokerage it resolves to must be the one the
  // caller stated — a mismatch refuses every path that needed it.
  let resolved: PacketActor | null = null
  if (packetPaths.length > 0 || teamPaths.length > 0) {
    const r = await resolvePacketActor(svc as Parameters<typeof resolvePacketActor>[0], actor.userId)
    if (!r.ok || r.actor.brokerageId !== actor.brokerageId) {
      return { ok: false, refused: [...refused, ...packetPaths, ...teamPaths], error: r.ok ? "your brokerage could not be confirmed for these forms" : `could not verify your team or brokerage for these forms: ${r.error}` }
    }
    resolved = r.actor
  }
  if (resolved && teamPaths.length > 0) {
    for (const p of teamPaths) {
      const teamId = formPathOwner(p)!.id
      // a loose team file: the person's own team, or (oversight) any team of their brokerage — the latter verified below
      if (teamId === resolved.teamId) continue
      if (!resolved.oversight) { refused.push(p); continue }
      const { data, error } = await (svc as { from: (t: string) => any }).from("teams").select("id").eq("id", teamId).eq("brokerage_id", actor.brokerageId).maybeSingle()
      if (error) return { ok: false, refused: [...refused, ...teamPaths, ...packetPaths], error: `could not verify the team folder belongs to your brokerage: ${error.message}` }
      if (!data) refused.push(p)
    }
  }
  if (resolved && packetPaths.length > 0) {
    const packets = await usableTenantPacketPaths(svc as Parameters<typeof usableTenantPacketPaths>[0], resolved, packetPaths)
    if (!packets.ok) return { ok: false, refused: [...refused, ...packetPaths], error: packets.error }
    for (const p of packetPaths) if (!packets.usable.has(p)) refused.push(p)
  }
  if (offerChecks.size > 0) {
    const ids = [...offerChecks.keys()]
    const { data, error } = await (svc as OfferReader).from("offers").select("id").in("id", ids).eq("brokerage_id", actor.brokerageId)
    if (error) {
      for (const ps of offerChecks.values()) refused.push(...ps)
      return { ok: false, refused, error: `could not verify the filled form belongs to your brokerage: ${error.message}` }
    }
    const mine = new Set((data ?? []).map((r) => r.id))
    for (const [id, ps] of offerChecks) if (!mine.has(id)) refused.push(...ps)
  }
  return { ok: refused.length === 0, refused }
}
