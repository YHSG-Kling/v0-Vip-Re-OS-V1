"use server"
/**
 * app/actions/events-and-circles.ts — THE SESSION DOORS for local events (directive G8) and circle tactics (G9) (wave 154, 154G3).
 *
 * Every export is a public endpoint (CLAUDE.md §4): async, the tenant and the person from the SESSION (getAgentContext), never a
 * parameter. The logic lives in lib/newsletter/local-events.ts and lib/marketing/circle-tactics.ts; these doors only gate.
 *   · event sources, tenant events and a refresh are the operational admin roster's (TENANT_ADMIN_USER_TYPES) — a public
 *     community listing is a tenant decision;
 *   · sharing / revoking a method is the PRODUCER's own act (their opt-in) — never under impersonation (a support grant walks
 *     the account, it never consents for it);
 *   · reading, evaluating and adapting a shared method is any member's, through the live-membership reader.
 * A refusal a person reads goes through the tenant presenter (lib/errors presentTenantError) — never a raw database message.
 */
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { createServiceClient } from "@/lib/supabase/service"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { presentTenantError } from "@/lib/errors"

type Fail = { success: false; error: string }
const fail = (what: string, raw?: unknown, context = "events-and-circles"): Fail => ({ success: false, error: presentTenantError({ what, raw, context, next: raw ? "platform_support" : "you" }).sentence })

async function session(opts: { admin?: boolean; ownAct?: boolean } = {}) {
  const ctx = await getAgentContext()
  if (!ctx.brokerageId || !ctx.userId) return { error: fail("You need to be signed in to do this") }
  if (opts.admin && !TENANT_ADMIN_USER_TYPES.has(ctx.userType ?? "")) return { error: fail("Community event listings are managed by your brokerage administrators") }
  if (opts.ownAct && ctx.isImpersonating) return { error: fail("Sharing a method is the producer's own choice, so it cannot be done while viewing another account") }
  return { ctx: { userId: ctx.userId, brokerageId: ctx.brokerageId } }
}

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────────────────────

export async function listEventsAndCirclesAction(): Promise<{ success: true; events: Array<Record<string, unknown>>; sources: Array<Record<string, unknown>>; tactics: Array<Record<string, unknown>>; mine: Array<Record<string, unknown>>; circles: Array<{ kind: string; id: string | null; label: string }>; notes: string[] } | Fail> {
  const s = await session()
  if ("error" in s) return s.error!
  try {
    const svc = createServiceClient()
    const [{ loadEventOpportunities, loadEventSources, authorizeEventSource }, { listCircleTacticsForViewer }] = await Promise.all([import("@/lib/newsletter/local-events"), import("@/lib/marketing/circle-tactics")])
    const [ev, src, ct] = await Promise.all([loadEventOpportunities(svc, s.ctx.brokerageId), loadEventSources(svc, s.ctx.brokerageId), listCircleTacticsForViewer(svc, s.ctx)])
    const notes = [ev.error, src.error, ct.error].filter((e): e is string => !!e).map(() => "Part of this page could not be read just now; what is shown is incomplete.")
    const { data: ag } = await svc.from("agents").select("id, location_id").eq("brokerage_id", s.ctx.brokerageId).eq("user_id", s.ctx.userId).limit(1)
    const agentRow = ((ag ?? []) as Array<{ id: string; location_id: string | null }>)[0]
    const agentId = agentRow?.id ?? null
    const circles: Array<{ kind: string; id: string | null; label: string }> = [{ kind: "brokerage", id: null, label: "Everyone in my brokerage" }]
    // wave 155 (155K, K4): the office the agent is seated in, while it is active in this tenant — the only office they may share with.
    if (agentRow?.location_id) {
      const { data: loc } = await svc.from("locations").select("id, name, status").eq("id", agentRow.location_id).eq("brokerage_id", s.ctx.brokerageId).maybeSingle()
      const l = loc as { id: string; name: string | null; status: string | null } | null
      if (l && l.status === "active") circles.push({ kind: "office", id: l.id, label: `My office: ${l.name ?? "my office"}` })
    }
    if (agentId) {
      const { data: tm } = await svc.from("team_members").select("team_id, teams(name)").eq("brokerage_id", s.ctx.brokerageId).eq("agent_id", agentId).eq("is_active", true)
      for (const t of (tm ?? []) as unknown as Array<{ team_id: string; teams: { name: string | null } | null }>) circles.push({ kind: "team", id: t.team_id, label: `Team: ${t.teams?.name ?? "my team"}` })
      const { data: mr } = await svc.from("agent_mentor_relationships").select("id, mentor_agent_id").eq("brokerage_id", s.ctx.brokerageId).eq("status", "active").or(`mentor_agent_id.eq.${agentId},mentee_agent_id.eq.${agentId}`)
      for (const m of (mr ?? []) as Array<{ id: string; mentor_agent_id: string }>) circles.push({ kind: "mentorship", id: m.id, label: m.mentor_agent_id === agentId ? "My mentee" : "My mentor" })
    }
    return {
      success: true, events: ev.rows as unknown as Array<Record<string, unknown>>,
      sources: src.sources.map((x) => { const a = authorizeEventSource(x); return { id: x.id, label: x.label, sourceClass: x.sourceClass, access: x.access, authorized: a.ok, reason: a.ok ? null : a.reason } }),
      tactics: ct.visible as unknown as Array<Record<string, unknown>>, mine: ct.mine as unknown as Array<Record<string, unknown>>, circles, notes,
    }
  } catch (e) {
    return fail("Local events and shared methods could not be loaded", e)
  }
}

// ── Local events (G8) ──────────────────────────────────────────────────────────────────────────────────────────

/** Record ONE typed event source with its access right (a publisher's own calendar feed, or a licensed feed with its LICENSE
 *  reference). The rights are recorded per source, by the session person, with the terms they rest on. */
export async function registerEventSourceAction(input: { label: string; sourceClass: string; access: string; url: string | null; termsNote: string; licenseRef?: string | null; city?: string | null; state?: string | null; zip?: string | null }): Promise<{ success: true; id: string; authorized: boolean; reason: string | null } | Fail> {
  const s = await session({ admin: true })
  if ("error" in s) return s.error!
  try {
    const { authorizeEventSource } = await import("@/lib/newsletter/local-events")
    const now = new Date().toISOString()
    const cfg = { class: input.sourceClass, access: input.access, terms_note: (input.termsNote ?? "").slice(0, 500) || null, rights_recorded_by: s.ctx.userId, rights_recorded_at: now, license_ref: input.licenseRef ?? null, territory: input.city || input.zip ? { city: input.city ?? null, state: input.state ?? null, zip: input.zip ?? null } : null }
    const probe = authorizeEventSource({ id: "probe", brokerageId: s.ctx.brokerageId, label: input.label, sourceClass: input.sourceClass, access: input.access, url: input.url, rights: { termsNote: cfg.terms_note, recordedBy: s.ctx.userId, recordedAt: now, licenseRef: cfg.license_ref }, territory: cfg.territory, lastRunAt: null })
    if (!probe.ok && /unknown_source_class|access_not_authorized/.test(probe.reason)) return fail("That kind of source cannot be read for events — only a publisher's own calendar feed, a licensed feed, or your own events")
    const svc = createServiceClient()
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    const res = await withActionLedger(
      { brokerageId: s.ctx.brokerageId, action: "marketing.local_event_source.register", actor: { type: "user", userId: s.ctx.userId }, subject: { type: "content_topic_source", ref: input.url ?? input.label }, riskClass: "LOW_RISK_WRITE", systemSource: "local_events", reasonCode: "HUMAN_REQUESTED", idempotencyKey: `event_source:${s.ctx.brokerageId}:${input.url ?? input.label}`, detail: { sourceClass: input.sourceClass, access: input.access } },
      async (): Promise<{ id: string | null; error: string | null }> => {
        const { data, error } = await svc.from("content_topic_sources").insert({ brokerage_id: s.ctx.brokerageId, source_type: input.access === "licensed_api" ? "manual" : "rss", label: input.label.slice(0, 120), is_active: true, source_config: { feed_url: input.url, local_event_source: cfg } }).select("id")
        return { id: ((data ?? []) as Array<{ id: string }>)[0]?.id ?? null, error: error ? error.message : null }
      },
      { settle: (r) => ({ status: r.error ? "failed" as const : "executed" as const, outcome: r.error ? "refused" : "recorded" }), replay: (claim) => ({ id: null, error: claim.kind === "refused" ? "ledger refused" : "already recorded" }) },
      { client: svc as never },
    )
    if (res.error || !res.id) return fail("The event source was not saved", res.error)
    return { success: true, id: res.id, authorized: probe.ok, reason: probe.ok ? null : probe.reason }
  } catch (e) {
    return fail("The event source was not saved", e)
  }
}

/** Create or update ONE of the brokerage's own events (hosted or sponsored). Updating its date or status runs the correction
 *  through the same lineage (stale drafts held). No RSVP and no attendee is collected here. */
export async function saveTenantEventAction(input: { eventKey?: string | null; title: string; url: string; date: string; time?: string | null; timeZone?: string | null; endDate?: string | null; locationKind: "physical" | "virtual"; venue?: string | null; city?: string | null; state?: string | null; zip?: string | null; virtualUrl?: string | null; relation: "hosted" | "sponsored"; status?: "scheduled" | "canceled" }): Promise<{ success: true; eventKey: string; inserted: number; corrections: number; dropped: Record<string, number>; decision: string | null } | Fail> {
  const s = await session({ admin: true })
  if ("error" in s) return s.error!
  try {
    const svc = createServiceClient()
    const { runLocalEventsPass, tenantEventSource } = await import("@/lib/newsletter/local-events")
    const { data: b } = await svc.from("brokerages").select("name").eq("id", s.ctx.brokerageId).maybeSingle()
    const now = new Date()
    const eventKey = input.eventKey && /^[a-z0-9-]{8,64}$/i.test(input.eventKey) ? input.eventKey : crypto.randomUUID()
    const src = tenantEventSource(s.ctx.brokerageId, (b as { name?: string } | null)?.name ?? "our brokerage", s.ctx.userId, now)
    const r = await runLocalEventsPass(svc, s.ctx.brokerageId, {
      onlyExtra: true,
      extraEvents: [{ source: src, events: [{ sourceEventKey: eventKey, url: input.url, title: input.title, location: { kind: input.locationKind, venue: input.venue ?? null, city: input.city ?? null, state: input.state ?? null, zip: input.zip ?? null, virtualUrl: input.virtualUrl ?? null }, start: { date: input.date, time: input.time ?? null, timeZone: input.timeZone ?? null }, end: input.endDate ? { date: input.endDate, time: null, timeZone: input.timeZone ?? null } : null, status: input.status ?? "scheduled", hostedByTenant: input.relation === "hosted", sponsoredByTenant: input.relation === "sponsored" }] }],
    })
    if (r.errors.length && r.inserted + r.merged + r.corrections === 0) return fail("The event was not saved", r.errors[0])
    return { success: true, eventKey, inserted: r.inserted, corrections: r.corrections, dropped: r.dropped, decision: r.decisions[0]?.optionId ?? null }
  } catch (e) {
    return fail("The event was not saved", e)
  }
}

/** Read every typed event source now (an unconfigured source says so and returns nothing). */
export async function refreshEventSourcesAction(): Promise<{ success: true; verified: number; inserted: number; corrections: number; unconfigured: Array<{ sourceId: string; reason: string }>; dropped: Record<string, number> } | Fail> {
  const s = await session({ admin: true })
  if ("error" in s) return s.error!
  try {
    const svc = createServiceClient()
    const { runLocalEventsPass } = await import("@/lib/newsletter/local-events")
    const r = await runLocalEventsPass(svc, s.ctx.brokerageId, { markRun: true })
    if (r.errors.length && r.verified === 0 && r.corrections === 0) return fail("Event sources could not be read", r.errors[0])
    return { success: true, verified: r.verified, inserted: r.inserted, corrections: r.corrections, unconfigured: r.unconfigured, dropped: r.dropped }
  } catch (e) {
    return fail("Event sources could not be read", e)
  }
}

// ── Circle tactics (G9) ────────────────────────────────────────────────────────────────────────────────────────

export async function shareCircleTacticAction(input: { circleKind: "team" | "mentorship" | "brokerage" | "office"; circleId?: string | null; method: string; components: string[]; explanation: string; caption?: string | null; sourceKind: "producer_outcome" | "competitor_public_idea"; tacticCampaignIds?: string[]; claimedTitle?: string | null }): Promise<{ success: true; shareId: string; quality: string; sourceLabel: string; offered: number; evaluated: number } | Fail> {
  const s = await session({ ownAct: true })
  if ("error" in s) return s.error!
  try {
    const { shareCircleTactic } = await import("@/lib/marketing/circle-tactics")
    const r = await shareCircleTactic(createServiceClient(), s.ctx, {
      circle: { kind: input.circleKind, teamId: input.circleKind === "team" ? input.circleId ?? null : null, mentorshipId: input.circleKind === "mentorship" ? input.circleId ?? null : null, locationId: input.circleKind === "office" ? input.circleId ?? null : null },
      method: input.method, components: input.components, explanation: input.explanation, caption: input.caption ?? null, sourceKind: input.sourceKind, tacticCampaignIds: input.tacticCampaignIds ?? [], claimedTitle: input.claimedTitle ?? null,
    })
    if (!r.ok) return fail(r.reason.startsWith("brief_refused") ? "The method still carries something that cannot be shared (a link, a figure, a handle, contact details or your caption) — describe the method in general words" : r.reason === "producer_not_a_member_of_circle" ? "You can only share with a circle you belong to" : "The method was not shared", r.reason.startsWith("brief_refused") || r.reason === "producer_not_a_member_of_circle" ? undefined : r.reason)
    return { success: true, shareId: r.shareId, quality: r.quality, sourceLabel: r.sourceLabel, offered: r.offered, evaluated: r.evaluated }
  } catch (e) {
    return fail("The method was not shared", e)
  }
}

export async function revokeCircleTacticAction(shareId: string): Promise<{ success: true } | Fail> {
  const s = await session({ ownAct: true })
  if ("error" in s) return s.error!
  try {
    const { revokeCircleTactic } = await import("@/lib/marketing/circle-tactics")
    const r = await revokeCircleTactic(createServiceClient(), s.ctx, String(shareId ?? ""))
    return r.ok ? { success: true } : fail("Sharing was not stopped", r.reason === "not_your_active_share" ? undefined : r.reason)
  } catch (e) {
    return fail("Sharing was not stopped", e)
  }
}

export async function evaluateCircleTacticAction(shareId: string): Promise<{ success: true; decision: string | null } | Fail> {
  const s = await session()
  if ("error" in s) return s.error!
  try {
    const { evaluateCircleTacticForMe } = await import("@/lib/marketing/circle-tactics")
    const r = await evaluateCircleTacticForMe(createServiceClient(), s.ctx, String(shareId ?? ""))
    return r.ok ? { success: true, decision: r.decision } : fail("This method could not be evaluated for you", r.reason === "not_visible_to_you" ? undefined : r.reason)
  } catch (e) {
    return fail("This method could not be evaluated for you", e)
  }
}

export async function adaptCircleTacticAction(shareId: string): Promise<{ success: true; topicId: string | null } | Fail> {
  const s = await session()
  if ("error" in s) return s.error!
  try {
    const { adaptCircleTactic } = await import("@/lib/marketing/circle-tactics")
    const r = await adaptCircleTactic(createServiceClient(), s.ctx, String(shareId ?? ""))
    return r.ok ? { success: true, topicId: r.topicId } : fail("The method was not added to your topics", r.reason && /^(not_visible|arbiter_decided|no_decision)/.test(r.reason) ? undefined : r.reason)
  } catch (e) {
    return fail("The method was not added to your topics", e)
  }
}
