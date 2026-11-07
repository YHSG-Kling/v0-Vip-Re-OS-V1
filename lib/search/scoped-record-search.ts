// lib/search/scoped-record-search.ts
//
// R6 (wave 150, lane 150QTV — owner ruling 2026-11-06, verbatim: "Global search finds contacts, listings AND leads — scoped
// strictly to what the signed-in user may see (tenant, office, team, assignment, role; agents never see raw tenant leads merely
// because they exist)").
//
// SURVIVOR VERDICT. There was no app-wide RECORD search: the header box (app/components/layout/global-search.tsx) only opened the
// ⌘K command palette (pages and actions), and the per-desk searches (app/actions/crm.ts searchContacts — agentId from a
// PARAMETER) are desk-local. MISSING → this is the smallest complete implementation, composed ONLY of the scope survivors:
//   · tenant          — the SESSION brokerage (app/actions/global-search.ts takes it from requireCaller, never from the box);
//   · office / team   — resolveViewerHierarchy (lib/kernel/resolve-user-office.ts, C34 — the scope answer on multi-location
//                       tenants; a single-office tenant keeps the CLAUDE.md §4 roster rule inside it);
//   · assignment      — contacts.agent_id / leads.agent_id / listings.agent_id against the viewer's OWN agents rows
//                       (agents.user_id — agents.id and users.id are DISJOINT, CLAUDE.md §3);
//   · role / leads    — resolveLeadVisibility + applyLeadRowScope (lib/auth/lead-visibility.ts), the ONE lead-desk rule. A seat
//                       outside the lead desk (an agent) sees a lead ONLY when it is assigned to one of their own agents rows —
//                       never the brokerage's raw pool (lane 150PU Outside-lane; lane 150BAA Outside-lane).
// Every read goes through the caller's SESSION client so RLS stays underneath the scope (lane 150BAA: "never use the service
// client for an agent's search"). Every `{ error }` is read; a refused scope read REFUSES the whole search (fail closed —
// "nobody checked" never renders as "nothing found"). The typed query is sanitised before it reaches a PostgREST filter string.

import type { SupabaseClient } from "@supabase/supabase-js"
import { resolveViewerHierarchy, type HierarchyScope } from "@/lib/kernel/resolve-user-office"
import { resolveLeadVisibility, applyLeadRowScope } from "@/lib/auth/lead-visibility"
import { isCrmContactStaff } from "@/lib/auth/crm-contact-staff"

type Client = SupabaseClient<any, any, any>

export interface RecordSearchViewer {
  /** users.id from the SESSION. */
  userId: string
  /** users.brokerage_id from the SESSION. */
  brokerageId: string
  userType: string | null
  platformRole: string | null
}

export interface RecordHit { id: string; label: string; detail: string | null; href: string }

export type ScopedRecordSearch =
  | {
      ok: true
      query: string
      contacts: RecordHit[]
      listings: RecordHit[]
      leads: RecordHit[]
      /** How far this viewer's search reached, per record kind — shown under the results, asserted by the proof. */
      reach: { contacts: string; listings: string; leads: string }
    }
  | { ok: false; error: string }

const PER_KIND = 6
const MIN_QUERY = 2

/** PURE. The typed words, safe inside a PostgREST `or=(…)` filter: every character that is filter syntax (, ( ) * % \ : ")
 *  becomes a space, runs collapse, and the result is capped. Null when there is nothing left to search for. */
function searchTerm(raw: string): string | null {
  const t = String(raw ?? "").replace(/[,()*%\\:"'`]/g, " ").replace(/\s+/g, " ").trim().slice(0, 64)
  return t.length >= MIN_QUERY ? t : null
}

/** PURE. `col.in.(a,b)` for every non-empty id list — ids are uuids from our own reads, never typed text. */
function inClauses(parts: Array<[string, string[]]>): string[] {
  return parts.filter(([, ids]) => ids.length > 0).map(([col, ids]) => `${col}.in.(${ids.join(",")})`)
}

/**
 * The search, scoped. `client` MUST be the caller's session client; `viewer` MUST come from the session.
 */
export async function searchScopedRecords(client: Client, viewer: RecordSearchViewer, rawQuery: string): Promise<ScopedRecordSearch> {
  const q = searchTerm(rawQuery)
  if (!viewer.userId || !viewer.brokerageId) return { ok: false, error: "Search needs your workspace — sign in again." }
  const t = String(viewer.userType ?? "").toLowerCase()
  if (t === "contact" || t === "vendor") return { ok: false, error: "Search is for your team's workspace." }
  if (!q) return { ok: true, query: "", contacts: [], listings: [], leads: [], reach: { contacts: "type at least two letters", listings: "", leads: "" } }

  // ── scope facts (each read's error is READ; any refusal refuses) ──
  const hier = await resolveViewerHierarchy(client, { userId: viewer.userId, brokerageId: viewer.brokerageId })
  if (!hier.ok) return { ok: false, error: `Search could not confirm what you may see (${hier.error}).` }
  const scope: HierarchyScope = hier.scope
  const multi = hier.tier === "multi_location"
  const { data: ownRows, error: ownErr } = await client.from("agents").select("id, location_id").eq("brokerage_id", viewer.brokerageId).eq("user_id", viewer.userId)
  if (ownErr) return { ok: false, error: `Search could not read your agent profile (${ownErr.message}).` }
  const own = (ownRows ?? []) as Array<{ id: string; location_id: string | null }>
  const ownAgentIds = own.map((a) => a.id)

  // The agents inside a non-aggregate office / team scope — the only way a lead (which carries no office or team) is placed.
  let scopeAgentIds: string[] = [...ownAgentIds]
  if (!scope.aggregate && (scope.locationIds.length > 0 || scope.teamIds.length > 0)) {
    const { data: inScope, error: sErr } = await client.from("agents").select("id").eq("brokerage_id", viewer.brokerageId)
      .or(inClauses([["location_id", scope.locationIds], ["team_id", scope.teamIds]]).join(","))
    if (sErr) return { ok: false, error: `Search could not read your office's agents (${sErr.message}).` }
    scopeAgentIds = [...new Set([...ownAgentIds, ...((inScope ?? []) as Array<{ id: string }>).map((a) => a.id)])]
  }

  // ── CONTACTS: tenant for an aggregate view (or back-office contact staff on a single-office tenant, the contact-access rule),
  //    otherwise the viewer's offices / teams / own assignments. ──
  const contactsTenantWide = scope.aggregate || (!multi && isCrmContactStaff(t) && t !== "agent")
  const contactScope = contactsTenantWide ? [] : inClauses([["location_id", scope.locationIds], ["team_id", scope.teamIds], ["agent_id", ownAgentIds]])
  let contacts: RecordHit[] = []
  let contactsReach = contactsTenantWide ? "your whole workspace" : scope.kind === "offices" ? "your office(s)" : scope.kind === "teams" ? "your team(s) and your own" : "contacts assigned to you"
  if (contactsTenantWide || contactScope.length > 0) {
    let cq = client.from("contacts").select("id, first_name, last_name, email, city").eq("brokerage_id", viewer.brokerageId).is("deleted_at", null)
      .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`)
    if (!contactsTenantWide) cq = cq.or(contactScope.join(","))
    const { data, error } = await cq.limit(PER_KIND)
    if (error) return { ok: false, error: `Contact search was refused (${error.message}).` }
    contacts = ((data ?? []) as Array<Record<string, string | null>>).map((c) => ({
      id: String(c.id), label: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "Unnamed contact",
      detail: [c.email, c.city].filter(Boolean).join(" · ") || null, href: `/crm/contacts/${c.id}`,
    }))
  } else contactsReach = "no contacts are assigned to you yet"

  // ── LISTINGS: the tenant's inventory on a single-office tenant; on a multi-location tenant the viewer's office(s) — their
  //    scope's offices, else the office their own agent profile sits in — plus their teams and their own listings. ──
  const listingOffices = [...new Set([...scope.locationIds, ...own.map((a) => a.location_id).filter((x): x is string => !!x)])]
  const listingsTenantWide = scope.aggregate || !multi
  const listingScope = listingsTenantWide ? [] : inClauses([["location_id", listingOffices], ["team_id", scope.teamIds], ["agent_id", ownAgentIds]])
  let listings: RecordHit[] = []
  let listingsReach = listingsTenantWide ? "your workspace's listings" : "your office's listings"
  if (listingsTenantWide || listingScope.length > 0) {
    let lq = client.from("listings").select("id, address, city, state, status, mls_number").eq("brokerage_id", viewer.brokerageId).is("deleted_at", null)
      .or(`address.ilike.%${q}%,city.ilike.%${q}%,zip.ilike.%${q}%,mls_number.ilike.%${q}%`)
    if (!listingsTenantWide) lq = lq.or(listingScope.join(","))
    const { data, error } = await lq.limit(PER_KIND)
    if (error) return { ok: false, error: `Listing search was refused (${error.message}).` }
    listings = ((data ?? []) as Array<Record<string, string | null>>).map((l) => ({
      id: String(l.id), label: l.address || l.mls_number || "Listing", detail: [l.city, l.state, l.status].filter(Boolean).join(" · ") || null,
      href: `/dashboard/listings/${l.id}`,
    }))
  } else listingsReach = "no listings in your scope yet"

  // ── LEADS: the lead desk reads through its ONE rule (narrowed to the office / team scope on a multi-location tenant); every
  //    other seat sees only leads ASSIGNED to its own agents rows — never the raw tenant pool. ──
  const vis = await resolveLeadVisibility(client, { userId: viewer.userId, userType: viewer.userType, platformRole: viewer.platformRole, brokerageId: viewer.brokerageId })
  if (!vis.allowed && vis.status === "unresolved") return { ok: false, error: `Search could not confirm your lead access (${vis.reason}).` }
  let leads: RecordHit[] = []
  let leadsReach: string
  const leadBase = () => client.from("leads").select("id, first_name, last_name, email, city, lead_stage")
    .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`)
  let lq2: ReturnType<typeof leadBase> | null = null
  if (vis.allowed) {
    // A platform scope is pinned to the session tenant here: this box searches the workspace the person is signed into.
    const leadScope = vis.scope.kind === "platform" ? { kind: "brokerage" as const, brokerageId: viewer.brokerageId } : vis.scope
    lq2 = applyLeadRowScope(leadBase(), leadScope)
    leadsReach = leadScope.kind === "team" ? "your team's leads" : "the lead desk"
    if (multi && !scope.aggregate) {
      lq2 = scopeAgentIds.length > 0 ? lq2.in("agent_id", scopeAgentIds) : null
      leadsReach = "leads worked in your office / team"
    }
  } else if (ownAgentIds.length > 0) {
    lq2 = leadBase().eq("brokerage_id", viewer.brokerageId).in("agent_id", ownAgentIds)
    leadsReach = "leads assigned to you"
  } else {
    leadsReach = "leads are handled by your brokerage's lead desk"
  }
  if (lq2) {
    const { data, error } = await lq2.limit(PER_KIND)
    if (error) return { ok: false, error: `Lead search was refused (${error.message}).` }
    leads = ((data ?? []) as Array<Record<string, string | null>>).map((l) => ({
      id: String(l.id), label: [l.first_name, l.last_name].filter(Boolean).join(" ") || l.email || "Unnamed lead",
      detail: [l.city, l.lead_stage].filter(Boolean).join(" · ") || null, href: `/leads/${l.id}`,
    }))
  }

  return { ok: true, query: q, contacts, listings, leads, reach: { contacts: contactsReach, listings: listingsReach, leads: leadsReach } }
}
