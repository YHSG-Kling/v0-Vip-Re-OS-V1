/**
 * lib/property-alerts/inventory-friction.ts — THE LOCAL INVENTORY FRICTION PLAY (wave 152, lane 152J; directive 152J
 * creative opportunity 1: "verified buyer demand for precise criteria vs available inventory → suggest helpful alternative
 * neighborhoods, alerts, agent sourcing tasks and education; close outcome to ROI").
 *
 * THE SHIP TEST, met in code (each piece is an existing survivor; nothing here is a second engine):
 *   · REAL SOURCE — the buyer's OWN saved search (property_alerts, a Contact's consented criteria) and the alert engine's
 *     own run log (property_alert_delivery_log, written by lib/property-alerts/alert-engine.ts on every run). Demand is
 *     VERIFIED (the buyer saved it); inventory is MEASURED (the provider answered with N homes for the searched area).
 *   · THE EVIDENCE RULE (pure, module-private): the last FRICTION_MIN_RUNS runs of the alert all ANSWERED (no refusal —
 *     a refusal is not a zero, the engine says so) with homes in the area (properties_checked > 0) and NONE qualifying
 *     (properties_matched = 0), spanning at least FRICTION_MIN_SPAN_DAYS, on an alert that has NEVER produced a result row
 *     (property_alert_results). "Nothing new since the last send" is not friction — an alert that ever matched is excluded.
 *   · ACTUAL WRITER — ONE agent task (tasks, source `inventory_friction`) for the Contact's ASSIGNED agent, ledgered
 *     (`property_alert.inventory_friction.open`, idempotent per alert per FRICTION_TASK_WINDOW_DAYS window), carrying the
 *     criteria and the measured inventory so the agent can review the price ceiling / bedrooms / area with the buyer, add a
 *     nearby ZIP, or source an off-market match.
 *   · SAFE ACTION — an internal task only. The play sends the BUYER nothing: any buyer-facing education the agent chooses
 *     goes through the existing arbiter doors. No provider is called, nothing is bought, no score is invented.
 *   · OUTCOME METRIC — measured from evidence, not counted from activity: for every friction task the ledger records, did a
 *     property_alert_results row for that alert land AFTER the task was opened (the friction RESOLVED — the criteria or
 *     the market moved)? Reported per sweep as `outcomes.tracked` / `outcomes.resolvedAfterTask`.
 *   · POSITIVE / NEGATIVE TEST — scripts/saved-home-alerts-guard.ts §L.
 *
 * Runs on the property-alerts cron's DAILY tick (app/api/property-alerts/run/route.ts — reached by the cron alone, never
 * on a page graph), beside the saved-home watch. Never throws.
 */
import { applyTenantScope, type TenantScope } from "@/lib/kernel/tenant-scope"
import { withActionLedger } from "@/lib/kernel/action-ledger"

type Db = { from: (t: string) => any }

/** Consecutive answered runs with inventory and no qualifying home before a task opens. */
const FRICTION_MIN_RUNS = 5
/** Those runs must span at least this many days (five runs in one afternoon are not a pattern). */
const FRICTION_MIN_SPAN_DAYS = 7
/** At most one task per alert per window (the ledger key carries the window index). */
const FRICTION_TASK_WINDOW_DAYS = 30
/** Alerts one sweep reads at most (the next sweep continues). */
const FRICTION_MAX_ALERTS = 500
const FRICTION_ACTION = "property_alert.inventory_friction.open"
const FRICTION_TASK_SOURCE = "inventory_friction"

interface AlertRow {
  id: string
  brokerage_id: string | null
  contact_id: string | null
  alert_name: string | null
  cities: string[] | null
  zip_codes: string[] | null
  min_price: number | string | null
  max_price: number | string | null
  bedrooms_min: number | null
  bathrooms_min: number | null
  created_at: string | null
}
interface RunRow { properties_checked: number | null; properties_matched: number | null; error_message: string | null; created_at: string }

/** PURE. Is this alert's recent history friction? Returns the evidence or null (with why, for the sweep's stats). */
function frictionEvidence(runs: RunRow[], everMatched: boolean): { runs: number; firstAt: string; lastAt: string; maxChecked: number } | { none: string } {
  if (everMatched) return { none: "the alert has matched before (no friction — only nothing new)" }
  const recent = [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, FRICTION_MIN_RUNS)
  if (recent.length < FRICTION_MIN_RUNS) return { none: `fewer than ${FRICTION_MIN_RUNS} runs` }
  if (recent.some((r) => r.error_message)) return { none: "a recent run was refused or degraded (a refusal is not a zero)" }
  if (recent.some((r) => !(Number(r.properties_checked) > 0))) return { none: "a recent run found no homes in the area at all (thin inventory is a different problem)" }
  if (recent.some((r) => Number(r.properties_matched) > 0)) return { none: "a recent run qualified a home" }
  const lastAt = recent[0].created_at, firstAt = recent[recent.length - 1].created_at
  if ((Date.parse(lastAt) - Date.parse(firstAt)) / 86_400_000 < FRICTION_MIN_SPAN_DAYS) return { none: `the runs span under ${FRICTION_MIN_SPAN_DAYS} days` }
  return { runs: recent.length, firstAt, lastAt, maxChecked: Math.max(...recent.map((r) => Number(r.properties_checked) || 0)) }
}

/** PURE. The buyer's criteria in plain words (what the agent reviews with them). */
function criteriaSummary(a: AlertRow): string {
  const money = (v: number | string | null) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? `$${Math.round(n).toLocaleString("en-US")}` : null }
  const area = [...(a.cities ?? []), ...(a.zip_codes ?? [])].filter(Boolean).slice(0, 4).join(", ")
  const lo = money(a.min_price), hi = money(a.max_price)
  const price = lo && hi ? `${lo}–${hi}` : hi ? `up to ${hi}` : lo ? `from ${lo}` : null
  const rooms = [a.bedrooms_min ? `${a.bedrooms_min}+ bed` : null, a.bathrooms_min ? `${a.bathrooms_min}+ bath` : null].filter(Boolean).join(", ")
  return [area || null, price, rooms || null].filter(Boolean).join(" · ") || "their saved criteria"
}

export interface InventoryFrictionStats {
  scope: string
  scanned: number
  frictionFound: number
  tasksOpened: number
  /** A task already open for this alert in this window (the ledger replayed). */
  replayed: number
  skipped: { noAgent: number; notFriction: number }
  /** THE OUTCOME METRIC: friction tasks on record → how many alerts matched a home AFTER their task was opened. */
  outcomes: { tracked: number; resolvedAfterTask: number }
  errors: string[]
}

/** THE SWEEP. Declared scope (never an optional id); each alert pinned to its own tenant on every read. Never throws. */
export async function detectInventoryFriction(db: Db, scope: TenantScope, deps: { now?: Date } = {}): Promise<InventoryFrictionStats> {
  const now = deps.now ?? new Date()
  const stats: InventoryFrictionStats = {
    scope: scope.kind === "tenant" ? `tenant ${scope.brokerageId}` : `platform (${scope.reason})`,
    scanned: 0, frictionFound: 0, tasksOpened: 0, replayed: 0, skipped: { noAgent: 0, notFriction: 0 },
    outcomes: { tracked: 0, resolvedAfterTask: 0 }, errors: [],
  }
  const q = db.from("property_alerts").select("id, brokerage_id, contact_id, alert_name, cities, zip_codes, min_price, max_price, bedrooms_min, bathrooms_min, created_at").eq("is_active", true).limit(FRICTION_MAX_ALERTS)
  applyTenantScope(q, scope)
  const { data, error } = await q
  if (error) { stats.errors.push(`property_alerts read refused: ${error.message} — nothing evaluated`); return stats }
  const alerts = ((data ?? []) as AlertRow[]).filter((a) => a.brokerage_id && a.contact_id)
  stats.scanned = alerts.length

  for (const alert of alerts) {
    const brokerageId = alert.brokerage_id as string
    try {
      const [{ data: runs, error: runsErr }, { data: results, error: resErr }] = await Promise.all([
        db.from("property_alert_delivery_log").select("properties_checked, properties_matched, error_message, created_at").eq("alert_id", alert.id).eq("brokerage_id", brokerageId).order("created_at", { ascending: false }).limit(FRICTION_MIN_RUNS),
        db.from("property_alert_results").select("id, created_at").eq("alert_id", alert.id).eq("brokerage_id", brokerageId).order("created_at", { ascending: false }).limit(1),
      ])
      if (runsErr || resErr) { stats.errors.push(`${alert.id}: history unreadable (${(runsErr ?? resErr)!.message}) — not evaluated`); continue }
      const latestResultAt = ((results ?? []) as Array<{ created_at: string }>)[0]?.created_at ?? null

      // THE OUTCOME, measured: a friction task on record for this alert → did a result land after it?
      const { data: opened, error: ledErr } = await db.from("agent_action_ledger").select("created_at, status").eq("brokerage_id", brokerageId).eq("action", FRICTION_ACTION).eq("subject_id", alert.id).eq("status", "executed").order("created_at", { ascending: true }).limit(1)
      if (ledErr) stats.errors.push(`${alert.id}: friction outcome unreadable (${ledErr.message})`)
      const firstTaskAt = ((opened ?? []) as Array<{ created_at: string }>)[0]?.created_at ?? null
      if (firstTaskAt) {
        stats.outcomes.tracked += 1
        if (latestResultAt && Date.parse(latestResultAt) > Date.parse(firstTaskAt)) stats.outcomes.resolvedAfterTask += 1
      }

      const ev = frictionEvidence((runs ?? []) as RunRow[], latestResultAt !== null)
      if ("none" in ev) { stats.skipped.notFriction += 1; continue }
      stats.frictionFound += 1

      const { data: who, error: whoErr } = await db.from("contacts").select("agent_id, first_name, last_name").eq("id", alert.contact_id).eq("brokerage_id", brokerageId).maybeSingle()
      if (whoErr) { stats.errors.push(`${alert.id}: contact read refused (${whoErr.message})`); continue }
      const person = (who ?? null) as { agent_id?: string | null; first_name?: string | null; last_name?: string | null } | null
      if (!person?.agent_id) { stats.skipped.noAgent += 1; continue }
      const buyer = [person.first_name, person.last_name].filter(Boolean).join(" ").trim() || "Your buyer"
      const windowIndex = Math.floor(now.getTime() / (FRICTION_TASK_WINDOW_DAYS * 86_400_000))
      const summary = criteriaSummary(alert)
      const out = await withActionLedger<{ taskId: string | null; note: string | null }>(
        {
          brokerageId, action: FRICTION_ACTION,
          actor: { type: "manager", managerKey: "shopping_agent" },
          subject: { type: "property_alert", id: alert.id, ref: `window:${windowIndex}` },
          reasonCode: "SERVICE_NOTICE",
          reasonDetail: `saved search answered ${ev.runs} times with homes in the area (up to ${ev.maxChecked} a run) and none fit, ${ev.firstAt.slice(0, 10)} → ${ev.lastAt.slice(0, 10)}; the agent reviews it with the buyer`,
          idempotencyKey: `${FRICTION_ACTION}:${alert.id}:${windowIndex}`, riskClass: "LOW_RISK_WRITE", channel: "in_app", systemSource: "property_alert_friction",
          detail: { contact_id: alert.contact_id, runs: ev.runs, first_run_at: ev.firstAt, last_run_at: ev.lastAt, max_homes_checked: ev.maxChecked, criteria: summary },
        },
        async () => {
          const { data: task, error: taskErr } = await db.from("tasks").insert({
            brokerage_id: brokerageId, contact_id: alert.contact_id, assigned_to_agent_id: person.agent_id, listing_id: null, transaction_id: null,
            title: `No home has fit ${buyer}'s search yet`,
            description: `${buyer}'s saved search "${(alert.alert_name ?? "Saved search").slice(0, 80)}" (${summary}) ran ${ev.runs} times between ${ev.firstAt.slice(0, 10)} and ${ev.lastAt.slice(0, 10)}. Each time the area had homes for sale (up to ${ev.maxChecked} per run), and none fit. Review the price ceiling, bedrooms and area with them, suggest a nearby ZIP, or source an off-market match.`,
            due_date: new Date(now.getTime() + 2 * 86_400_000).toISOString().slice(0, 10),
            priority: "medium", status: "pending", assignee_type: "agent", source: FRICTION_TASK_SOURCE, auto_generated: true,
          }).select("id").single()
          if (taskErr || !task) return { taskId: null, note: `task not written: ${taskErr?.message ?? "no row"}` }
          return { taskId: String((task as { id: string }).id), note: null }
        },
        {
          settle: (r) => (r.taskId ? { status: "executed", outcome: "task_opened", providerRef: r.taskId } : { status: "failed", outcome: "task_not_written", error: r.note }),
          replay: (claim) => ({ taskId: null, note: claim.kind === "replay" ? "already opened in this window" : `not opened: ${claim.kind}` }),
        },
        { client: db as never },
      )
      if (out.taskId) stats.tasksOpened += 1
      else if (out.note === "already opened in this window") stats.replayed += 1
      else if (out.note) stats.errors.push(`${alert.id}: ${out.note}`)
    } catch (e) {
      stats.errors.push(`${alert.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return stats
}
