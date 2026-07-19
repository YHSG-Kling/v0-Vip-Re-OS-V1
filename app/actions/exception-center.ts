"use server"

/**
 * app/actions/exception-center.ts — the broker's Exception Center verbs.
 * Read (open exceptions + supervised repairs), RETRY (re-run the flow scan),
 * RESOLVE / DISMISS (append-only closure), and FLAG-WRONG (the ratchet's
 * feedback loop: a vetoed repair appends 'failed', demoting that repair type
 * to supervised instantly — zero-failure autonomy is strict by design).
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  applyExceptionLocationFilter,
  composeExceptionCenter,
  type ExceptionCenterRead,
  type ExceptionLedgerRow,
  type ExceptionScope,
} from "@/lib/kernel/exception-center"
import { resolveEgressScope } from "@/lib/kernel/egress-scope"

// PRINCIPAL seats (owner: not every subscription is a brokerage) — whoever
// OWNS the subscription's operations gets the Exception Center: brokers on
// brokerage/multi-location tiers, the solo agent on a solo tier, the team
// lead on a team tier. A team member or a brokerage's staff agent is
// OVERSEEN by their principal, not a principal themselves.
const PRINCIPAL_TYPES = new Set(["broker", "broker_admin", "admin", "superadmin", "solo_agent", "team_lead"])

async function resolveBroker() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase.from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
  if (!(profile as any)?.brokerage_id || !PRINCIPAL_TYPES.has(String((profile as any).user_type ?? ""))) return null
  return {
    userId: user.id,
    brokerageId: (profile as any).brokerage_id as string,
    userType: String((profile as any).user_type ?? ""),
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * MULTI-LOCATION attribution: resolve each exception SUBJECT (an entity id) to
 * an office. Entities carry either a direct location_id (contacts, listings)
 * or an agent reference whose agents.location_id supplies the office — the
 * SAME agents.location_id idiom the reporting scope resolver narrows by.
 * Best-effort: a subject that resolves to nothing stays UNATTRIBUTED (null).
 */
async function attributeSubjectsToLocations(
  svc: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  subjects: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  for (const s of subjects) out.set(s, null)
  const ids = [...new Set(subjects)].filter((s) => UUID_RE.test(s))
  if (ids.length === 0) return out

  const agentOf = new Map<string, string>() // subject -> agents.id
  const probes: Array<{ table: string; agentCol: string | null; locationCol: string | null }> = [
    { table: "contacts",     agentCol: "agent_id",             locationCol: "location_id" },
    { table: "listings",     agentCol: "agent_id",             locationCol: "location_id" },
    { table: "leads",        agentCol: "agent_id",             locationCol: null },
    { table: "transactions", agentCol: "agent_id",             locationCol: null },
    { table: "offers",       agentCol: "agent_id",             locationCol: null },
    { table: "tasks",        agentCol: "assigned_to_agent_id", locationCol: null },
  ]
  for (const p of probes) {
    const cols = ["id", p.agentCol, p.locationCol].filter(Boolean).join(", ")
    const { data } = await svc.from(p.table).select(cols)
      .eq("brokerage_id", brokerageId).in("id", ids)
    for (const row of ((data ?? []) as any[])) {
      const subject = String(row.id)
      if (out.get(subject)) continue // already attributed by an earlier probe
      if (p.locationCol && row[p.locationCol]) out.set(subject, String(row[p.locationCol]))
      else if (p.agentCol && row[p.agentCol] && !agentOf.has(subject)) agentOf.set(subject, String(row[p.agentCol]))
    }
  }

  const agentIds = [...new Set(agentOf.values())]
  if (agentIds.length > 0) {
    const { data: agents } = await svc.from("agents").select("id, location_id").in("id", agentIds)
    const agentLoc = new Map<string, string | null>(
      ((agents ?? []) as any[]).map((a) => [String(a.id), a.location_id ? String(a.location_id) : null]),
    )
    for (const [subject, agentId] of agentOf) {
      if (!out.get(subject)) out.set(subject, agentLoc.get(agentId) ?? null)
    }
  }
  return out
}

export async function getExceptionCenter(opts?: { locationId?: string | null }): Promise<
  { success: true; read: ExceptionCenterRead; scope: ExceptionScope } | { success: false; error: string }
> {
  const caller = await resolveBroker()
  if (!caller) return { success: false, error: "Broker access required" }
  const svc = createServiceClient()
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data } = await svc.from("self_heal_events")
    .select("id, subject, action, outcome, detail, created_at")
    .eq("domain", "data_flow").eq("brokerage_id", caller.brokerageId)
    .gte("created_at", since).order("created_at", { ascending: true }).limit(1000)
  const rows: ExceptionLedgerRow[] = ((data ?? []) as any[]).map((r) => ({
    id: r.id, subject: r.subject, action: r.action ?? null, outcome: r.outcome,
    detail: (r.detail as any) ?? null, createdAt: r.created_at,
  }))
  const read = composeExceptionCenter(rows)

  // ── MULTI-LOCATION scoping (owner: "exception center — brokerage, multiple
  // location brokerage"). Office narrowing exists ONLY on the multi_location
  // tier; every other tier gets the plain brokerage-scoped read. The honest
  // default is ALL locations — narrowing is an explicit choice (or the
  // egress-scope rule: a location admin is pinned to their own office).
  const scope: ExceptionScope = {
    multiLocation: false, locations: [], selectedLocationId: null, forced: false, hiddenUnattributed: 0,
  }
  const { data: brokerage } = await svc.from("brokerages")
    .select("plan_tier").eq("id", caller.brokerageId).maybeSingle()
  if ((brokerage as any)?.plan_tier !== "multi_location") {
    return { success: true, read, scope }
  }

  scope.multiLocation = true
  const { data: locs } = await svc.from("locations")
    .select("id, name").eq("brokerage_id", caller.brokerageId).order("name")
  scope.locations = ((locs ?? []) as any[]).map((l) => ({ id: String(l.id), name: String(l.name ?? "Office") }))

  // Same scope resolver reporting uses (keep-one): a multi-location office
  // admin (admin WITH agents.location_id) oversees ONLY their office;
  // broker/broker_admin/superadmin see all locations and may narrow by choice.
  const { data: agentRow } = await svc.from("agents")
    .select("location_id, team_id").eq("user_id", caller.userId).maybeSingle()
  const egress = resolveEgressScope({
    userType: caller.userType,
    userId: caller.userId,
    brokerageId: caller.brokerageId,
    locationId: (agentRow as any)?.location_id ?? null,
    teamId: (agentRow as any)?.team_id ?? null,
  })

  let selected: string | null = null
  if (egress.kind === "location" && egress.locationId) {
    selected = egress.locationId
    scope.forced = true
  } else if (opts?.locationId && scope.locations.some((l) => l.id === opts.locationId)) {
    selected = opts.locationId
  }
  scope.selectedLocationId = selected

  if (!selected) return { success: true, read, scope } // honest all-locations default

  const subjects = [...read.open.map((e) => e.subject), ...read.supervised.map((r) => r.subject)]
  const attribution = await attributeSubjectsToLocations(svc, caller.brokerageId, subjects)
  const filtered = applyExceptionLocationFilter(read, attribution, selected)
  scope.hiddenUnattributed = filtered.hiddenUnattributed
  return { success: true, read: filtered.read, scope }
}

/** Append-only closure: 'resolved' (handled) or 'dismissed' (not an issue). */
async function closeException(eventId: string, closure: "resolved" | "dismissed"): Promise<{ success: boolean; error?: string }> {
  const caller = await resolveBroker()
  if (!caller) return { success: false, error: "Broker access required" }
  const svc = createServiceClient()
  const { data: original } = await svc.from("self_heal_events")
    .select("id, brokerage_id, subject, action, detail")
    .eq("id", eventId).eq("brokerage_id", caller.brokerageId).eq("outcome", "escalated").maybeSingle()
  if (!original) return { success: false, error: "Exception not found on your brokerage" }
  const { error } = await svc.from("self_heal_events").insert({
    brokerage_id: caller.brokerageId,
    domain: "data_flow",
    subject: (original as any).subject,
    action: (original as any).action ?? "none",
    outcome: closure,
    detail: { flow: (original as any).detail?.flow ?? null, original_event_id: eventId, by_user: caller.userId },
  })
  return error ? { success: false, error: "Could not record the closure — try again" } : { success: true }
}

export async function resolveException(eventId: string) {
  return closeException(eventId, "resolved")
}

export async function dismissException(eventId: string) {
  return closeException(eventId, "dismissed")
}

/** Re-run the full contract scan + heal pass for this brokerage, on demand. */
export async function retryDataFlows(): Promise<
  { success: true; breaks: number; healed: number } | { success: false; error: string }
> {
  const caller = await resolveBroker()
  if (!caller) return { success: false, error: "Broker access required" }
  const svc = createServiceClient()
  const { runFlowIntegrity } = await import("@/lib/kernel/flow-integrity")
  const r = await runFlowIntegrity(svc, caller.brokerageId)
  return { success: true, breaks: r.breaks, healed: r.healed }
}

/**
 * THE RATCHET'S FEEDBACK LOOP: a human vetoing a supervised repair appends
 * outcome 'failed' for that action — and because earned autonomy requires
 * ZERO recorded failures, the repair type demotes to supervised instantly.
 */
export async function flagRepairWrong(eventId: string): Promise<{ success: boolean; error?: string }> {
  const caller = await resolveBroker()
  if (!caller) return { success: false, error: "Broker access required" }
  const svc = createServiceClient()
  const { data: original } = await svc.from("self_heal_events")
    .select("id, brokerage_id, subject, action, detail")
    .eq("id", eventId).eq("brokerage_id", caller.brokerageId).eq("outcome", "healed").maybeSingle()
  if (!original || !(original as any).action) return { success: false, error: "Repair not found on your brokerage" }
  const { error } = await svc.from("self_heal_events").insert({
    brokerage_id: caller.brokerageId,
    domain: "data_flow",
    subject: (original as any).subject,
    action: (original as any).action,
    outcome: "failed",
    detail: { flow: (original as any).detail?.flow ?? null, human_flagged: true, original_event_id: eventId, by_user: caller.userId },
  })
  return error ? { success: false, error: "Could not record the veto — try again" } : { success: true }
}
