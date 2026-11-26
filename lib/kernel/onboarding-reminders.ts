import { createClient } from "@/lib/supabase/server"
// The ONE way a notifications row gets its tenant — the recipient's
// users.brokerage_id, the exact value badge-counts compares against.
import { resolveRecipientBrokerageIds } from "@/lib/notifications/recipient-tenant"

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000
const REMINDER_COOLDOWN_KEY = "last_onboarding_reminder_sent_at"

// ─── EXPORTED FUNCTION ────────────────────────────────────────────────────────

/**
 * findStuckAgentsAndNotify
 *
 * Finds agents whose onboarding is in_progress and who have not completed
 * a step in the last 24 hours, then inserts a single in_app reminder
 * notification per agent per day. Uses agent_onboarding.additional_settings
 * to track last reminder timestamp so we never spam more than once per day.
 *
 * Non-blocking: safe to run in a daily cron. Individual agent errors are
 * caught and logged without aborting the full run.
 */
export async function findStuckAgentsAndNotify(): Promise<void> {
  const supabase = await createClient()
  const now = new Date()

  // 1) Fetch all in_progress onboarding rows
  const { data: inProgressRows, error: fetchError } = await supabase
    .from("agent_onboarding")
    .select("id, agent_id, user_id, additional_settings")
    .eq("status", "in_progress")

  if (fetchError) {
    throw new Error(`[onboarding-reminders] Failed to fetch in_progress agents: ${fetchError.message}`)
  }

  if (!inProgressRows || inProgressRows.length === 0) {
    console.log("[onboarding-reminders] No in_progress agents found. Exiting.")
    return
  }

  console.log(`[onboarding-reminders] Processing ${inProgressRows.length} in_progress agents.`)

  // TENANT — resolved ONCE FOR THE WHOLE RUN, not once per row: one `users` read
  // for every recipient this sweep might notify.
  //
  // The value is each RECIPIENT's `users.brokerage_id`, the exact expression
  // app/api/dashboard/badge-counts/route.ts:62 compares against. Unstamped, a
  // reminder is written, the cooldown is stamped as though it were delivered,
  // and the badge never counts it — so the agent is told nothing AND is not told
  // again for 24 hours. `agent_onboarding.brokerage_id` exists and is NOT used:
  // it is not the value the reader computes, and using it would be a second
  // resolver that can silently disagree with the first.
  const reminderTenants = await resolveRecipientBrokerageIds(
    supabase,
    inProgressRows.map((r) => r.user_id as string | null),
  )
  if (!reminderTenants.ok) {
    // A refused users read is NOT "these agents have no brokerage". Fail closed
    // for the whole run rather than writing a sweep of invisible reminders and
    // burning every cooldown behind them.
    throw new Error(`[onboarding-reminders] ${reminderTenants.reason}`)
  }

  for (const row of inProgressRows) {
    try {
      const agentId = row.agent_id as string
      const userId = row.user_id as string
      const onboardingId = row.id as string
      const additionalSettings = (row.additional_settings ?? {}) as Record<string, string | null>

      // 2) Check cooldown: skip if reminder was already sent in the last 24h
      const lastSentAt = additionalSettings[REMINDER_COOLDOWN_KEY]
      if (lastSentAt) {
        const lastSentMs = new Date(lastSentAt).getTime()
        if (now.getTime() - lastSentMs < TWENTY_FOUR_HOURS_MS) {
          console.log(`[onboarding-reminders] Skipping agent ${agentId} — reminder sent within 24h.`)
          continue
        }
      }

      // 3) Check latest step completion timestamp for this agent
      const { data: latestCompletion } = await supabase
        .from("agent_step_completions")
        .select("updated_at")
        .eq("agent_id", agentId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      const lastCompletedAt = latestCompletion?.updated_at
        ? new Date(latestCompletion.updated_at).getTime()
        : null

      const isStuck =
        lastCompletedAt === null ||
        now.getTime() - lastCompletedAt >= TWENTY_FOUR_HOURS_MS

      if (!isStuck) {
        console.log(`[onboarding-reminders] Agent ${agentId} completed a step recently. Skipping.`)
        continue
      }

      // 4) Insert in_app notification for the agent
      const reminderBrokerageId = reminderTenants.brokerageIds.get(userId) ?? null
      if (!reminderBrokerageId) {
        // No tenant resolves for this recipient, so the row would be written
        // where the bell cannot count it — and the cooldown below would then
        // suppress the next 24 hours of real attempts. Skip WITHOUT stamping the
        // cooldown, and name the reason.
        console.error(
          `[onboarding-reminders] No brokerage resolves for recipient ${userId} (agent ${agentId}) — reminder NOT written and the cooldown NOT stamped.`,
        )
        continue
      }
      const { error: notifError } = await supabase
        .from("notifications")
        .insert({
          user_id: userId,
          brokerage_id: reminderBrokerageId,
          type: "onboarding_reminder",
          title: "Onboarding Reminder",
          body: "Complete your next onboarding step to unlock full access.",
          channel: "in_app",
          is_read: false,
        })

      if (notifError) {
        console.error(`[onboarding-reminders] Failed to insert notification for agent ${agentId}:`, notifError.message)
        continue
      }

      // 5) Stamp the cooldown timestamp in additional_settings
      const updatedSettings: Record<string, string | null> = {
        ...additionalSettings,
        [REMINDER_COOLDOWN_KEY]: now.toISOString(),
      }

      const { error: updateError } = await supabase
        .from("agent_onboarding")
        .update({ additional_settings: updatedSettings })
        .eq("id", onboardingId)

      if (updateError) {
        console.error(`[onboarding-reminders] Failed to stamp cooldown for agent ${agentId}:`, updateError.message)
        // Non-fatal: notification was already sent; worst case they get one extra reminder next run
      }

      console.log(`[onboarding-reminders] Reminder sent for agent ${agentId}.`)
    } catch (err) {
      // INTENTIONAL: per-agent errors must not abort the full run
      console.error(`[onboarding-reminders] Unexpected error for row ${row.id}:`, err)
    }
  }

  console.log("[onboarding-reminders] Run complete.")
}
