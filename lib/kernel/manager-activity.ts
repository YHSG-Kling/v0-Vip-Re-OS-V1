/**
 * lib/kernel/manager-activity.ts
 *
 * THE UNIFIED MANAGER ACTIVITY LEDGER (read-model).
 *
 * The Command Center already shows two of the three manager stories: the PENDING
 * queue (`loadCommandCenter` — what's waiting on a human) and the inter-manager
 * CONVERSATION (`loadRecentManagerTalk` — who told whom what). The missing third
 * story is the chronological ledger of what each manager actually DID: the
 * completed / executed / sent work, attributed per manager, with the rationale
 * and the outcome on each row.
 *
 * That story is scattered today across five stores (a manager's footprint is not
 * kept in one table). This is a pure READ-MODEL that composes them into one
 * chronological, manager-attributed feed — it introduces NO new write path and NO
 * new table, so it can never fork the queue's or the standup's source of truth:
 *
 *   1. manager_signals (status='consumed')  — a manager acted on another's signal
 *   2. marketing_agent_actions (resolved)   — Marketing Manager executed/skipped
 *   3. asset_manager_actions   (resolved)   — Asset Manager executed/skipped
 *   4. ad_manager_actions      (resolved)   — Ads Manager executed/skipped
 *   5. agent_client_messages   (released)   — a manager's client message went out
 *   6. reaper_runs             (swept)      — a manager's reaper caught stuck work
 *
 * Attribution resolves to a canonical ManagerKey (registry-owned label/accent), so
 * the visual identity can't drift from the governed roster.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { MANAGERS, type ManagerKey } from "./manager-registry"

type Svc = ReturnType<typeof createServiceClient>

export type ManagerActivitySource =
  | "signal"
  | "marketing"
  | "asset"
  | "ads"
  | "client_message"
  | "reaper"

export interface ManagerActivityEntry {
  id: string
  /** Canonical registry key when known (UI resolves label + accent from MANAGERS). */
  managerKey: string
  managerLabel: string
  source: ManagerActivitySource
  /** One-line "what the manager did". */
  action: string
  /** The rationale / supporting detail, when the store carries one. */
  detail: string | null
  /** Normalized outcome for the status pill. */
  status: "done" | "executed" | "sent" | "skipped" | "escalated" | "failed"
  whenISO: string
}

function labelFor(key: string): string {
  return key in MANAGERS ? MANAGERS[key as ManagerKey].label : key
}

/** Present-tense verb for a manager `*_actions.action_type` (e.g. "schedule_post"). */
function humanizeActionType(actionType: string | null): string {
  if (!actionType) return "took an action"
  return actionType.replace(/_/g, " ")
}

/**
 * Load the recent cross-manager activity ledger for a brokerage — the completed
 * work each AI manager did, newest first. Brokerage-wide aggregate (the whole
 * team's footprint), so callers gate it to a brokerage-wide viewer.
 */
export async function loadManagerActivity(
  brokerageId: string,
  limit = 40,
  client?: Svc,
): Promise<ManagerActivityEntry[]> {
  if (!brokerageId) return []
  const supabase = client ?? createServiceClient()

  const actionSelect = "id, action_type, rationale, status, proposed_at, approved_at, executed_at"
  // A manager's COMPLETED work (past the 'proposed'/'approved'/'executing' in-flight
  // states the pending queue already shows): it ran, it was skipped, or it failed.
  const resolvedStatuses = ["succeeded", "failed", "skipped"]

  const [signalsRes, marketingRes, assetRes, adsRes, clientMsgRes, reaperRes] = await Promise.all([
    supabase
      .from("manager_signals")
      .select("id, to_manager, from_manager, signal_type, message, consumed_action, consumed_at, created_at")
      .eq("brokerage_id", brokerageId)
      .eq("status", "consumed")
      .order("consumed_at", { ascending: false })
      .limit(limit),
    supabase
      .from("marketing_agent_actions")
      .select(actionSelect)
      .eq("brokerage_id", brokerageId)
      .in("status", resolvedStatuses)
      .order("proposed_at", { ascending: false })
      .limit(limit),
    supabase
      .from("asset_manager_actions")
      .select(actionSelect)
      .eq("brokerage_id", brokerageId)
      .in("status", resolvedStatuses)
      .order("proposed_at", { ascending: false })
      .limit(limit),
    supabase
      .from("ad_manager_actions")
      .select(actionSelect)
      .eq("brokerage_id", brokerageId)
      .in("status", resolvedStatuses)
      .order("proposed_at", { ascending: false })
      .limit(limit),
    supabase
      .from("agent_client_messages")
      .select("id, agent_kind, channel, subject, outreach_reason, rationale, status, approved_at, sent_at")
      .eq("brokerage_id", brokerageId)
      .in("status", ["sent", "failed"])
      .order("proposed_at", { ascending: false })
      .limit(limit),
    supabase
      .from("reaper_runs")
      .select("id, manager, domain, scanned, escalated, reaped, detail, ran_at")
      .eq("brokerage_id", brokerageId)
      .order("ran_at", { ascending: false })
      .limit(limit),
  ])

  const entries: ManagerActivityEntry[] = []

  for (const r of (signalsRes.data ?? []) as any[]) {
    entries.push({
      id: `sig:${r.id}`,
      managerKey: r.to_manager,
      managerLabel: labelFor(r.to_manager),
      source: "signal",
      action: r.consumed_action ?? `acted on a ${String(r.signal_type ?? "signal").replace(/_/g, " ")} from ${labelFor(r.from_manager)}`,
      detail: r.message ?? null,
      status: "done",
      whenISO: r.consumed_at ?? r.created_at,
    })
  }

  const pushActions = (rows: any[], key: ManagerKey, source: ManagerActivitySource) => {
    for (const r of rows) {
      const status: ManagerActivityEntry["status"] =
        r.status === "skipped" ? "skipped" : r.status === "failed" ? "failed" : "executed"
      const verb = status === "skipped" ? "skipped" : status === "failed" ? "failed to run" : "ran"
      entries.push({
        id: `${source}:${r.id}`,
        managerKey: key,
        managerLabel: labelFor(key),
        source,
        action: `${verb} ${humanizeActionType(r.action_type)}`,
        detail: r.rationale ?? null,
        status,
        whenISO: r.executed_at ?? r.approved_at ?? r.proposed_at,
      })
    }
  }
  pushActions((marketingRes.data ?? []) as any[], "marketing_agent", "marketing")
  pushActions((assetRes.data ?? []) as any[], "asset_manager", "asset")
  pushActions((adsRes.data ?? []) as any[], "ads_manager", "ads")

  for (const r of (clientMsgRes.data ?? []) as any[]) {
    const failed = r.status === "failed"
    const what = r.subject?.trim() || r.outreach_reason?.replace(/_/g, " ") || "a client message"
    entries.push({
      id: `msg:${r.id}`,
      managerKey: r.agent_kind,
      managerLabel: labelFor(r.agent_kind),
      source: "client_message",
      action: `${failed ? "failed to send" : "sent"} ${r.channel ?? "message"} — ${what}`,
      detail: r.rationale ?? null,
      status: failed ? "failed" : "sent",
      whenISO: r.sent_at ?? r.approved_at,
    })
  }

  for (const r of (reaperRes.data ?? []) as any[]) {
    const escalated = Number(r.escalated ?? 0)
    const reaped = Number(r.reaped ?? 0)
    // Only surface reaper runs that actually did something (caught or escalated work).
    if (escalated === 0 && reaped === 0) continue
    entries.push({
      id: `reap:${r.id}`,
      managerKey: r.manager,
      managerLabel: labelFor(r.manager),
      source: "reaper",
      action: `swept ${String(r.domain ?? "").replace(/_/g, " ")} — reaped ${reaped}, escalated ${escalated} of ${Number(r.scanned ?? 0)}`,
      detail: r.detail ?? null,
      status: escalated > 0 ? "escalated" : "done",
      whenISO: r.ran_at,
    })
  }

  return entries
    .filter((e) => !!e.whenISO)
    .sort((a, b) => new Date(b.whenISO).getTime() - new Date(a.whenISO).getTime())
    .slice(0, limit)
}
