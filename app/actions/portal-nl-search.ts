"use server"

/**
 * app/actions/portal-nl-search.ts — NATURAL-LANGUAGE property search for the
 * BUYER (owner rule: "buyers can search for properties from rentcast/idx
 * using natural language"). The engine already existed (searchPropertiesCore:
 * intent parser → our inventory + RentCast/IDX, Fair-Housing-sanitized
 * explanations) but only agents and the voice admin could reach it — this is
 * the buyer's own doorway on the portal search page. Contact-anchored like
 * every portal action (the buyer's portal user is not the agent); the search
 * logs to client_portal_activity so the "I saw you" recognition and search
 * signals see it.
 *
 * THE FIFTH SIBLING, NOW GATED. Wave 15 put `requireContactAccess` in front of
 * the four buyer-facing tools in buyer-offer-tools.ts and wrote this one down as
 * out of scope. It is the same defect verbatim: a bare `contactId` on a
 * "use server" export, straight onto the service client. Any authenticated user
 * holding a contact uuid could run a PAID RentCast/IDX search billed to that
 * contact's brokerage and stamp an activity row on someone else's client that
 * their agent reads as their buyer's intent. It authorizes through the same one
 * helper, in the same shape, so there is no second auth pattern to keep in step.
 *
 * The gate is not narrower than the surface: it admits the contact themselves
 * (linked user id, matching email, or an accepted+unexpired portal invite) and
 * staff in the contact's own brokerage — exactly the set the portal page at
 * app/portal/[contactId]/ already admits. No real user loses the button.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { requireContactAccess } from "@/lib/portal/require-contact-access"

export interface PortalSearchResult {
  address: string | null
  city: string | null
  price: number | null
  bedrooms: number | null
  bathrooms: number | null
  headline: string | null
  source: string
  listingId: string | null
}

/** The action's public answer, unchanged — named only so the body is one
 *  unambiguous block. A type alias is not an export, and a "use server" file
 *  constrains only what it EXPORTS (async functions). */
type PortalSearchOutcome =
  | { ok: true; results: PortalSearchResult[] }
  | { ok: false; error: string }

/** DERIVED from the gate rather than restated, so the vocabulary cannot drift:
 *  if requireContactAccess ever grows a fifth refusal, this is the type that
 *  changes underneath the mapper below. */
type PortalAccessRefusal = Extract<Awaited<ReturnType<typeof requireContactAccess>>, { ok: false }>["error"]

/**
 * THE GATE'S REFUSAL, SAID TO A BUYER. Same mapper the four siblings use, and
 * the same rule: `requireContactAccess` answers in internal vocabulary and a
 * buyer told "Forbidden" learns nothing they can act on, so every branch names
 * the next move. Kept as a LOCAL non-exported function because it is neither
 * async nor exportable from a "use server" module — the shared thing between
 * the five actions is the gate itself, not this sentence table.
 *
 * The four answers are deliberately DISTINCT. "Access check failed" is a
 * REFUSED READ (an outage) and "Forbidden" is a DECISION; telling a legitimate
 * buyer they are signed in with the wrong account because a lookup was denied
 * sends them to change something that was never wrong.
 */
function accessRefusal(error: PortalAccessRefusal): string {
  switch (error) {
    case "Unauthorized":
      return "Please sign in to your portal and try again."
    case "Forbidden":
      return "You're signed in with a different account than this page belongs to — sign in with the email your agent invited you at, or reply to their last message."
    case "Contact not found":
      return "We couldn't find your client record — reply to your agent's last message and they'll get this to the right place."
    default:
      return "We couldn't verify your account just now — please try again in a moment."
  }
}

export async function portalNaturalSearchAction(input: {
  contactId: string
  query: string
}): Promise<PortalSearchOutcome> {
  // Shape check only — it reads nothing and spends nothing, and its answer is
  // the same sentence for every caller, so it may stand in front of the gate
  // (analyzeAddressForBuyer orders its own input check the same way).
  const query = (input.query ?? "").trim().slice(0, 300)
  if (query.length < 5) return { ok: false, error: "Tell me a little more — beds, price range, area…" }

  // ── THE GATE — BEFORE THE SERVICE CLIENT, BEFORE THE PROVIDER ──────────────
  // Refusing has to cost nothing: no privileged read is issued and no paid
  // RentCast/IDX call is made until the caller has been proven to be this
  // contact (or staff on them). It FAILS CLOSED — a refused access check comes
  // back as its own answer rather than being laundered into a decision, and
  // never as a cheerful empty result set, because "no homes matched" is what a
  // buyer would read as a real search that found nothing.
  const access = await requireContactAccess(input.contactId)
  if (!access.ok) return { ok: false, error: accessRefusal(access.error) }

  const svc = createServiceClient()
  // THE ROW READ IS STILL NEEDED, and deliberately so: the gate hands back
  // `brokerageId`, but the activity row below also needs `agent_id`, which the
  // gate does not return and could not substitute for — `agents.id`,
  // `users.id` and `contacts.id` are DISJOINT id spaces, so the gate's `userId`
  // is not an agent id in any sense and writing it into that column would put a
  // row in no staff lane at all (or fail the FK outright). What the gate DOES
  // buy here is the bound on the read: the service client bypasses RLS, so the
  // tenant it resolved is applied as a filter rather than trusted implicitly.
  // The error is destructured because supabase-js RESOLVES a refused read —
  // "no contact" and "the read was refused" used to be the same answer here.
  const { data: contact, error: contactError } = await svc.from("contacts")
    .select("id, brokerage_id, agent_id, has_login")
    .eq("id", input.contactId)
    .eq("brokerage_id", access.brokerageId)
    .maybeSingle()
  if (contactError) {
    console.error("[portal-nl-search] contact read refused:", contactError.message)
    return { ok: false, error: "We couldn't reach your account just now — please try again." }
  }
  if (!contact) return { ok: false, error: accessRefusal("Contact not found") }

  const { searchPropertiesCore } = await import("@/lib/buyer-search")
  const r: any = await searchPropertiesCore({
    contactId: input.contactId,
    naturalLanguageQuery: query,
    options: { limit: 8, logSignals: true },
  }).catch(() => null)
  if (!r?.success) return { ok: false, error: "That search didn't run — try rephrasing (beds, price, area)." }

  // The engagement ledger the recognition + preference rails already read. TENANT-STAMPED: the
  // row's SELECT policy admits the agent side only via has_brokerage_access(brokerage_id) or
  // agent_id = current_user_agent_id(), so the unstamped version of this row told the agent
  // nothing about what their buyer is out there searching for — the one signal it exists to carry.
  // Both columns are nullable, so the insert succeeded and the loss was silent. `.then(ok, err)`
  // was standing in for an error check and could never fire: supabase-js RESOLVES a refused write.
  const searchActivityRow = {
    brokerage_id: (contact as { brokerage_id: string | null }).brokerage_id,
    contact_id: input.contactId,
    agent_id: (contact as { agent_id: string | null }).agent_id,
    activity_type: "nl_property_search",
    metadata: { query },
  }
  const { error: activityError } = await svc.from("client_portal_activity").insert(searchActivityRow)
  if (activityError) console.error("[portal-nl-search] portal activity NOT recorded:", activityError.message)

  const results: PortalSearchResult[] = ((r.results ?? []) as any[]).slice(0, 8).map((m) => ({
    address: m.address ?? null,
    city: m.city ?? null,
    price: m.price ?? null,
    bedrooms: m.bedrooms ?? null,
    bathrooms: m.bathrooms ?? null,
    headline: m.headline ?? null,
    source: String(m.source ?? "platform"),
    listingId: m.listing_id ?? null,
  }))
  return { ok: true, results }
}
