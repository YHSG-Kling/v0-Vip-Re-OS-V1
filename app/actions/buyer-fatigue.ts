"use server"

import { createServiceClient }      from "@/lib/supabase/service"
import { createClient }              from "@/lib/supabase/server"
import { calculateFatigue, runFatigueSweep, type FatigueSweepResult } from "@/lib/fatigue/fatigue-calculator"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { requireCaller, requireTenantAdminOrSoloOwner } from "@/lib/auth/require-caller"
import { tenantScope } from "@/lib/kernel/tenant-scope"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { mergeBrokerageSettings } from "@/lib/settings/brokerage-settings-merge"
import {
  CONTACT_FATIGUE_WEIGHTS_KEY, DEFAULT_CONTACT_FATIGUE_WEIGHTS, resolveContactFatigueWeights, validateContactFatigueWeights,
  type ContactFatigueWeights,
} from "@/lib/fatigue/fatigue-display"

// Every read in this file used to be unauthenticated and accepted
// caller-supplied contactId / brokerageId. Any signed-in user could read
// any brokerage's buyer fatigue scores and active alerts simply by
// passing the brokerage's UUID. Now: session is required and brokerage
// is resolved from the session.

// TOMBSTONE (§1.1, 2026-09-08): local `requireCaller` lived here; survivor
// lib/auth/require-caller.ts:requireCaller (this lane's fold-in of the
// 2026-09-03 wave-26 survivor)

// ─── ONE CONTACT — THE AGENT'S OWN BOOK (wave 88, lane 88A) ───────────────────
// Owner: "Need fatigue also for agents." The per-contact doors below (the contact card's fatigue
// guard / widget / panel, on-demand calculate, dismiss, AI suggestions) checked the contact's
// BROKERAGE only — any seat could read any contact's fatigue in the tenant, and the contact read's
// refusal was swallowed into "Forbidden". Now the SAME viewer the list readers use decides: the
// tenant admin roster sees the whole brokerage; an agent sees the contacts on THEIR OWN book
// (contacts.agent_id = their agents.id); a seat with no agents row is refused (§4 fail closed).
// Every fatigue row is a contacts row, so no lead can surface (§5).
async function verifyContactAccess(
  contactId: string,
  auth: { userId: string; brokerageId: string; userType: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const viewer = await resolveFatigueViewer(auth)
  if (!viewer.ok) return viewer
  const { data: contact, error } = await createServiceClient()
    .from("contacts")
    .select("agent_id")
    .eq("id", contactId)
    .eq("brokerage_id", auth.brokerageId)
    .is("deleted_at", null)
    .maybeSingle()
  if (error) return { ok: false, error: `Could not load that contact: ${error.message}` }
  if (!contact) return { ok: false, error: "Forbidden" }
  if (viewer.bookAgentId !== null && (contact as { agent_id: string | null }).agent_id !== viewer.bookAgentId) {
    return { ok: false, error: "Forbidden — fatigue is shown for the contacts on your own book" }
  }
  return { ok: true }
}

// ─── WHO SEES WHICH FATIGUE ROWS (wave 87, lane 87A) ──────────────────────────
// CLAUDE.md §5: leads belong to the brokerage; agents never see leads and see
// CONTACTS only. Every fatigue row is a contacts row by construction (all four
// inputs and buyer_fatigue_scores / fatigue_alerts FK contacts.id), so no lead
// can surface here. The list readers below were open to ANY seat brokerage-wide;
// an agent now sees only the contacts on THEIR OWN book (contacts.agent_id = the
// caller's agents.id, crossed via agents.user_id — §3, disjoint ids). The tenant
// admin roster (TENANT_ADMIN_USER_TYPES) keeps the brokerage-wide view. A seat
// with no agents row in this brokerage is REFUSED, never widened (§4).
type FatigueViewer =
  | { ok: true; bookAgentId: string | null /* null = whole brokerage (tenant admin) */ }
  | { ok: false; error: string }

async function resolveFatigueViewer(auth: { userId: string; brokerageId: string; userType: string | null }): Promise<FatigueViewer> {
  if (auth.userType && TENANT_ADMIN_USER_TYPES.has(auth.userType)) return { ok: true, bookAgentId: null }
  const { data, error } = await createServiceClient()
    .from("agents")
    .select("id")
    .eq("user_id", auth.userId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()
  if (error) return { ok: false, error: `Could not resolve your agent record: ${error.message}` }
  if (!data) return { ok: false, error: "Fatigue lists show an agent's own contacts — no agent record for this seat" }
  return { ok: true, bookAgentId: (data as { id: string }).id }
}

// ─── GET FATIGUE SCORE FOR ONE BUYER ─────────────────────────────────────────

export async function getBuyerFatigueScore(contactId: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false as const, error: auth.error }
  const access = await verifyContactAccess(contactId, auth)
  if (!access.ok) return { success: false as const, error: access.error }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("buyer_fatigue_scores")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()

  if (error) return { success: false as const, error: error.message }
  return { success: true as const, data }
}

// ─── GET ACTIVE FATIGUE ALERTS FOR ONE BUYER ─────────────────────────────────

export async function getBuyerFatigueAlerts(contactId: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false as const, error: auth.error }
  const access = await verifyContactAccess(contactId, auth)
  if (!access.ok) return { success: false as const, error: access.error }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("fatigue_alerts")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", auth.brokerageId)
    .eq("dismissed", false)
    .order("created_at", { ascending: false })

  if (error) return { success: false as const, error: error.message }
  return { success: true as const, data: data ?? [] }
}

// ─── DISMISS ALERT ────────────────────────────────────────────────────────────

export async function dismissFatigueAlert(alertId: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false as const, error: auth.error }

  const supabase = createServiceClient()

  // Verify the alert belongs to caller's brokerage before mutating — and (wave 88) that an agent
  // dismisses only an alert on a contact on their own book (the same viewer as every door here).
  const { data: alert, error: alertReadErr } = await supabase
    .from("fatigue_alerts")
    .select("brokerage_id, contact_id")
    .eq("id", alertId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()
  if (alertReadErr) return { success: false as const, error: `Could not load that fatigue alert: ${alertReadErr.message}` }
  if (!alert) return { success: false as const, error: "Alert not found" }
  const access = await verifyContactAccess((alert as { contact_id: string }).contact_id, auth)
  if (!access.ok) return { success: false as const, error: access.error }

  const { error } = await supabase
    .from("fatigue_alerts")
    .update({
      dismissed:    true,
      dismissed_at: new Date().toISOString(),
      dismissed_by: auth.userId,
    })
    .eq("id", alertId)
    .eq("brokerage_id", auth.brokerageId)

  if (error) return { success: false as const, error: error.message }
  return { success: true as const }
}

// ─── CALCULATE NOW (on-demand) ────────────────────────────────────────────────

export async function triggerFatigueCalculation(
  contactId:   string,
  _brokerageId?: string,  // ignored — derived from session
) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false as const, error: auth.error }
  const access = await verifyContactAccess(contactId, auth)
  if (!access.ok) return { success: false as const, error: access.error }

  try {
    const result = await calculateFatigue(contactId, auth.brokerageId)
    // Ported from the retired app/actions/fatigue.ts: once a buyer crosses into
    // high/critical, the alert that was just written gets an AI recovery plan
    // attached. Best-effort — a plan failure never fails the score. Lane 87A:
    // only when THIS call raised the alert (one plan per alert — the sweep's rule).
    if (result.alert_raised) {
      try {
        const { generateRecoveryPlan } = await import("@/lib/fatigue/recovery-generator")
        await generateRecoveryPlan(result)
      } catch (planErr) {
        console.warn("[buyer-fatigue] recovery plan failed:", planErr)
      }
    }
    return { success: true as const, data: result }
  } catch (err: any) {
    return { success: false as const, error: err.message }
  }
}

// ─── RECALCULATE THE WHOLE BROKERAGE (dashboard button) ───────────────────────
//
// Wave 87 (lane 87A) — THE BROKERAGE SCOPE of the one sweep. Owner: "fatigue
// sweeps run for the platform on tenants and brokerage on leads and contacts
// which is user run. should be run on how the fatigue calculation is derived."
// The same core the platform cron runs (runFatigueSweep), over THIS brokerage's
// people with fatigue inputs — its contacts, including the contacts its leads
// converted into — and a count of its leads with nothing to derive from.
//
// Lane 86G2. The Buyer Fatigue dashboard's "Recalculate" button used to POST
// /api/fatigue/calculate from a "use client" component with
// `x-cron-secret: process.env.CRON_SECRET ?? ""` — CRON_SECRET is not
// NEXT_PUBLIC_, so the browser always sent "" and every click was refused 401 —
// and a body `brokerageId` (CLAUDE.md §4: tenant never from a body). Now a
// session door: tenant admin (or a solo owner — their own broker), tenant from
// the SESSION, never a parameter; the same ONE sweep core the cron runs, scoped
// to this brokerage. It writes scores and may attach AI recovery plans across
// the whole book, which is why an agent seat does not get the brokerage run —
// since wave 88 (lane 88A) an agent seat gets the same core over THEIR OWN
// book instead (below). Returns COUNTED results so "scored nobody" is
// distinguishable from "refused".

export async function recalculateBrokerageFatigue(): Promise<
  | { success: true; data: FatigueSweepResult }
  | { success: false; error: string }
> {
  const auth = await requireTenantAdminOrSoloOwner()
  if (!auth.ok) {
    // AN AGENT'S OWN BOOK (wave 88, lane 88A — owner: "Need fatigue also for agents"). A seat that is
    // not the tenant admin no longer just gets "Forbidden": the SAME core runs over the contacts on
    // THEIR OWN book (contacts.agent_id = their agents.id, resolved from the session by the one
    // viewer), inside the session tenant. No lead is read or counted (§5).
    const caller = await requireCaller()
    if (!caller.ok) return { success: false, error: caller.error }
    const viewer = await resolveFatigueViewer(caller)
    if (!viewer.ok) return { success: false, error: viewer.error }
    if (viewer.bookAgentId === null) return { success: false, error: auth.error }
    try {
      const data = await runFatigueSweep(
        tenantScope(caller.brokerageId, "buyer-fatigue recalculate — agent's own book"),
        { bookAgentId: viewer.bookAgentId },
      )
      return { success: true, data }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }
  try {
    const data = await runFatigueSweep(tenantScope(auth.brokerageId, "buyer-fatigue recalculate"))
    return { success: true, data }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}

// ─── THE BROKERAGE'S FATIGUE WEIGHTS (wave 89, lane 89C) ──────────────────────
//
// Lane 88A's open decision, closed by the owner: keep 4 / 8 / 15 / 20 as the DEFAULTS and expose them
// as a brokerage-tunable setting. The tenant admin (or a solo owner) reads and writes them; the tenant
// comes from the SESSION; the write goes through the ONE settings writer (mergeBrokerageSettings —
// merged by key, so no other settings key is lost to a concurrent save). The calculator resolves the
// same key through the same pure resolver, so the door and the score cannot disagree.

export async function getContactFatigueWeights(): Promise<
  | { success: true; weights: ContactFatigueWeights; defaults: ContactFatigueWeights; isDefault: boolean }
  | { success: false; error: string }
> {
  const auth = await requireTenantAdminOrSoloOwner()
  if (!auth.ok) return { success: false, error: auth.error }
  const { data, error } = await createServiceClient()
    .from("brokerage_settings").select("settings").eq("brokerage_id", auth.brokerageId).maybeSingle()
  if (error) return { success: false, error: `Could not read the brokerage's fatigue weights: ${error.message}` }
  const settings = (data as { settings?: unknown } | null)?.settings
  const weights = resolveContactFatigueWeights(settings)
  const stored = settings && typeof settings === "object" ? (settings as Record<string, unknown>)[CONTACT_FATIGUE_WEIGHTS_KEY] : undefined
  return { success: true, weights, defaults: DEFAULT_CONTACT_FATIGUE_WEIGHTS, isDefault: stored == null }
}

export async function setContactFatigueWeights(input: unknown): Promise<
  | { success: true; weights: ContactFatigueWeights }
  | { success: false; error: string }
> {
  const auth = await requireTenantAdminOrSoloOwner()
  if (!auth.ok) return { success: false, error: auth.error }
  const valid = validateContactFatigueWeights(input)
  if (!valid.ok) return { success: false, error: valid.error }
  const write = await mergeBrokerageSettings(createServiceClient(), auth.brokerageId, { [CONTACT_FATIGUE_WEIGHTS_KEY]: valid.weights })
  if (!write.ok) return { success: false, error: `Could not save the fatigue weights: ${write.error}` }
  return { success: true, weights: valid.weights }
}

// ─── ACTIVE ALERT FOR ONE BUYER ───────────────────────────────────────────────
// Carried over from app/actions/fatigue.ts, the duplicate action module retired
// with the scorer. ContactFatigueGuard is its caller.

export async function getBuyerFatigueAlert(contactId: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false as const, error: auth.error }
  const access = await verifyContactAccess(contactId, auth)
  if (!access.ok) return { success: false as const, error: access.error }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("fatigue_alerts")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", auth.brokerageId)
    .eq("dismissed", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return { success: false as const, error: error.message }
  return { success: true as const, alert: data ?? null }
}

// ─── GET REINVIGORATION SUGGESTIONS (AI) ──────────────────────────────────────

export async function getReinvigorationSuggestions(
  contactId:   string,
  _brokerageId?: string,  // ignored — derived from session
) {
  // Burns paid AI inference — auth required
  const auth = await requireCaller()
  if (!auth.ok) return { success: false as const, error: auth.error }
  const access = await verifyContactAccess(contactId, auth)
  if (!access.ok) return { success: false as const, error: access.error }

  const supabase = createServiceClient()

  const [contactRes, scoreRes] = await Promise.all([
    supabase
      .from("contacts")
      .select("first_name, last_name, contact_persona, buyer_stage, timeline")
      .eq("id", contactId)
      .eq("brokerage_id", auth.brokerageId)
      .single(),
    supabase
      .from("buyer_fatigue_scores")
      .select("fatigue_score, risk_level, total_showings, total_tour_days, days_searching, offers_rejected, engagement_trend")
      .eq("contact_id", contactId)
      .eq("brokerage_id", auth.brokerageId)
      .maybeSingle(),
  ])

  if (contactRes.error) return { success: false as const, error: contactRes.error.message }

  const contact = contactRes.data
  const score   = scoreRes.data

  try {
    const { text } = await generateText({
      brokerageId: auth.brokerageId,
      userId: auth.userId,
      model: "anthropic/claude-opus-4.6" as any,
      messages: [
        {
          role: "user",
          content:
            "You are an expert real estate agent coach specializing in buyer fatigue and re-engagement. " +
            "Return a JSON array of exactly 4 reinvigoration suggestions. Each suggestion is a plain string under 20 words. " +
            "Be specific, actionable, and empathetic. Return only the JSON array, no other text.",
        },
        {
          role: "user",
          content:
            `Buyer: ${contact.first_name} ${contact.last_name}. ` +
            `Persona: ${contact.contact_persona ?? "unknown"}. ` +
            `Stage: ${contact.buyer_stage ?? "searching"}. ` +
            `Timeline: ${contact.timeline ?? "unknown"}. ` +
            `Fatigue score: ${score?.fatigue_score ?? "unknown"}/100 (${score?.risk_level ?? "high"}). ` +
            `Showings: ${score?.total_showings ?? 0}, Tour days: ${score?.total_tour_days ?? 0}, ` +
            `Days searching: ${score?.days_searching ?? 0}, Rejected offers: ${score?.offers_rejected ?? 0}. ` +
            `Engagement trend: ${score?.engagement_trend ?? "declining"}. ` +
            `Generate 4 specific reinvigoration suggestions for the agent.`,
        },
      ],
      maxTokens: 400,
    })

    const suggestions: string[] = JSON.parse(text.trim())
    return { success: true as const, suggestions }
  } catch {
    return {
      success: true as const,
      suggestions: [
        "Suggest narrowing the search criteria to reduce overwhelming options.",
        "Schedule a 2-week break from active touring to reset perspective.",
        "Revisit their top-rated properties from earlier in the search.",
        "Explore an adjacent price range or neighboring city for fresh options.",
      ],
    }
  }
}

// ─── GET HIGH FATIGUE BUYERS (watch / warning / critical) ─────────────────────

export async function getHighFatigueBuyers(_brokerageId?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false as const, error: auth.error }
  const viewer = await resolveFatigueViewer(auth)
  if (!viewer.ok) return { success: false as const, error: viewer.error }

  const supabase = createServiceClient()

  const { data: scores, error } = await supabase
    .from("buyer_fatigue_scores")
    .select("*")
    .eq("brokerage_id", auth.brokerageId)
    .in("risk_level", ["moderate", "high", "critical"])
    .order("fatigue_score", { ascending: false })

  if (error) return { success: false as const, error: error.message }

  const contactIds = (scores || []).map(s => s.contact_id).filter(Boolean)
  if (contactIds.length === 0) return { success: true as const, data: [] }

  const contactsQ = supabase
    .from("contacts")
    .select("id, first_name, last_name, agent_id, buyer_stage, deleted_at")
    .in("id", contactIds)
    .eq("brokerage_id", auth.brokerageId)
    .is("deleted_at", null)
  // An agent sees only the contacts on their own book (see resolveFatigueViewer).
  const { data: contacts, error: contactsErr } = await (viewer.bookAgentId === null ? contactsQ : contactsQ.eq("agent_id", viewer.bookAgentId))
  if (contactsErr) return { success: false as const, error: contactsErr.message }

  const contactMap = new Map((contacts || []).map(c => [c.id, c]))

  const enriched = (scores || [])
    .filter(s => contactMap.has(s.contact_id))
    .map(s => ({ ...s, contacts: contactMap.get(s.contact_id) ?? null }))

  return { success: true as const, data: enriched }
}

// ─── GET ACTIVE BROKERAGE-WIDE FATIGUE ALERTS ─────────────────────────────────

export async function getBrokerageFatigueAlerts(_brokerageId?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false as const, error: auth.error }
  const viewer = await resolveFatigueViewer(auth)
  if (!viewer.ok) return { success: false as const, error: viewer.error }

  const supabase = createServiceClient()

  const alertsQ = supabase
    .from("fatigue_alerts")
    .select("*")
    .eq("brokerage_id", auth.brokerageId)
    .eq("dismissed", false)
    .order("created_at", { ascending: false })
    .limit(50)
  // An agent sees only the alerts raised for their own contacts
  // (fatigue_alerts.agent_user_id is a users.id — the session user's own id).
  const { data, error } = await (viewer.bookAgentId === null ? alertsQ : alertsQ.eq("agent_user_id", auth.userId))

  if (error) return { success: false as const, error: error.message }
  return { success: true as const, data: data ?? [] }
}

// ─── BROKERAGE FATIGUE DASHBOARD DATA ────────────────────────────────────────

export async function getBrokerageFatigueData(_brokerageId?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false as const, error: auth.error }
  const viewer = await resolveFatigueViewer(auth)
  if (!viewer.ok) return { success: false as const, error: viewer.error }

  const supabase = createServiceClient()

  const { data: scores, error } = await supabase
    .from("buyer_fatigue_scores")
    .select("*")
    .eq("brokerage_id", auth.brokerageId)
    .order("fatigue_score", { ascending: false })

  if (error) return { success: false as const, error: error.message }

  const contactIds = (scores || []).map(s => s.contact_id).filter(Boolean)
  if (contactIds.length === 0) return { success: true as const, data: [] }

  const contactsQ = supabase
    .from("contacts")
    .select("id, first_name, last_name, agent_id, buyer_stage, deleted_at")
    .in("id", contactIds)
    .eq("brokerage_id", auth.brokerageId)
    .is("deleted_at", null)
  // An agent sees only the contacts on their own book (see resolveFatigueViewer).
  const { data: contacts, error: contactsErr } = await (viewer.bookAgentId === null ? contactsQ : contactsQ.eq("agent_id", viewer.bookAgentId))
  if (contactsErr) return { success: false as const, error: contactsErr.message }

  // Fetch the agent's USER (name) for each contact. contacts.agent_id is an
  // agents.id, and agents.id / users.id are DISJOINT (§3) — the old
  // `.from("users").in("id", agentIds)` matched nobody, so every row showed no
  // agent. Cross via agents.user_id, inside this brokerage.
  const agentIds = [...new Set((contacts || []).map(c => c.agent_id).filter(Boolean))] as string[]
  let agentMap = new Map<string, { first_name: string; last_name: string }>()
  if (agentIds.length > 0) {
    const { data: agentRows } = await supabase
      .from("agents")
      .select("id, user_id")
      .in("id", agentIds)
      .eq("brokerage_id", auth.brokerageId)
    const userIdByAgent = new Map(((agentRows ?? []) as Array<{ id: string; user_id: string | null }>).filter(a => a.user_id).map(a => [a.id, a.user_id as string]))
    const userIds = [...new Set(userIdByAgent.values())]
    if (userIds.length > 0) {
      const { data: users } = await supabase
        .from("users")
        .select("id, first_name, last_name")
        .in("id", userIds)
      const userMap = new Map(((users ?? []) as Array<{ id: string; first_name: string; last_name: string }>).map(u => [u.id, u]))
      agentMap = new Map([...userIdByAgent].flatMap(([agentId, userId]) => userMap.has(userId) ? [[agentId, userMap.get(userId)!] as const] : []))
    }
  }

  const contactMap = new Map((contacts || []).map(c => [c.id, {
    ...c,
    users: (c.agent_id ? agentMap.get(c.agent_id) : undefined) || null,
  }]))

  const enrichedData = (scores || [])
    .filter(s => contactMap.has(s.contact_id))
    .map(s => ({
      ...s,
      contacts: contactMap.get(s.contact_id),
    }))

  return { success: true as const, data: enrichedData }
}
