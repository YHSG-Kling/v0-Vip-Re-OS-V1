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
 * The bucket's own layout (FormWizard loadStep2 + prefill-storage-form):
 *   brokerage/{brokerageId}/…   the brokerage library
 *   teams/{teamId}/…            the team library
 *   agents/{userId}/…           the agent's own library + uploads/
 *   filled/{userId | offerId}/… filled copies written by prefillStorageFormAction
 */

export type FormPathOwner =
  | { kind: "brokerage"; id: string }
  | { kind: "team"; id: string }
  | { kind: "agent"; id: string }
  | { kind: "filled"; id: string }

const PREFIX_KIND: Record<string, FormPathOwner["kind"]> = {
  brokerage: "brokerage",
  teams: "team",
  agents: "agent",
  filled: "filled",
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

/**
 * PURE part of the verdict. `filled/{id}` is in scope when id is the actor's own user id;
 * any OTHER filled id must be proven to be one of the actor's brokerage's offers — that
 * proof needs the database, so it comes back as `needsOfferCheck`.
 */
function formPathVerdict(path: string, actor: FormPathActor): "allowed" | "refused" | "needsOfferCheck" {
  const owner = formPathOwner(path)
  if (!owner) return "refused"
  switch (owner.kind) {
    case "brokerage": return owner.id === actor.brokerageId ? "allowed" : "refused"
    case "team":      return actor.teamId && owner.id === actor.teamId ? "allowed" : "refused"
    case "agent":     return owner.id === actor.userId ? "allowed" : "refused"
    case "filled":    return owner.id === actor.userId ? "allowed" : "needsOfferCheck"
  }
}

type OfferReader = {
  from: (t: "offers") => {
    select: (c: string) => { in: (col: string, ids: string[]) => { eq: (col: string, v: string) => PromiseLike<{ data: Array<{ id: string }> | null; error: { message: string } | null }> } }
  }
}

/**
 * Every path in scope for the actor, or the list that is not. A refused offer read FAILS
 * CLOSED (the path is refused and the reason is returned), never waved through.
 */
export async function checkFormPathsInScope(
  svc: unknown,
  paths: string[],
  actor: FormPathActor,
): Promise<{ ok: boolean; refused: string[]; error?: string }> {
  const refused: string[] = []
  const offerChecks = new Map<string, string[]>()
  for (const p of paths) {
    const v = formPathVerdict(p, actor)
    if (v === "refused") refused.push(p)
    else if (v === "needsOfferCheck") {
      const id = formPathOwner(p)!.id
      offerChecks.set(id, [...(offerChecks.get(id) ?? []), p])
    }
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
