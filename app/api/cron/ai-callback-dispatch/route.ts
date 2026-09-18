import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { decodeCallbackNote, encodeCallbackNote, bumpCallbackAttempt, MAX_CALLBACK_ATTEMPTS } from "@/lib/ai-isa/callback-task"

/**
 * AI CALLBACK DISPATCH — the EXECUTOR half of the owner's ruling (wave 55):
 * "the ai assistant or receptionist needs to be able to make a task to call a
 * person back and then do the call back when it is time." The WRITER
 * (lib/ai-isa/callback-task.ts::createCallbackTask, wired into the reception
 * turn/relay routes and the post-call-outcome backstop) files a `tasks` row
 * with source='ai_callback'; this sweep finds the ones now DUE and places the
 * call.
 *
 * TENANCY: a platform cron reading across tenants ON PURPOSE (CLAUDE.md §4) —
 * gated by the cron secret, every row scoped to its own brokerage_id and every
 * dial routed through the tenant's own Twilio creds inside placeOutboundAiCall.
 *
 * TWO ASSIGNEE_TYPE LANES (owner ruling, verbatim): "agent-assigned callbacks
 * instead get a due notification + the existing click-to-call surface" — that
 * lane is ALREADY LIVE and is NOT re-implemented here: `tasks.due_date` past-due
 * is exactly what /api/cron/task-due (KernelEvent.TASK_DUE → deal_coordinator,
 * lib/kernel/event-reactor.ts:1345) already notifies on for EVERY task
 * regardless of source, and every dashboard tasks surface already renders a
 * `tel:` click-to-call next to a contact's phone (e.g. app/crm/components/
 * contact-header-card.tsx) — so an assignee_type:'agent' callback task rides
 * that survivor untouched. This sweep claims and dials ONLY assignee_type:
 * 'ai_isa' tasks — the autonomous lane the ruling asks for.
 *
 * IDEMPOTENCY: a compare-and-swap claim (`status='pending' → 'in_progress'`,
 * `.eq("status","pending")` on the UPDATE, `.select()`ed and COUNTED per
 * CLAUDE.md §3) before any dial — two overlapping runs cannot both place the
 * same call. The claimed/attempted stamp itself lives in the callback note's
 * `attempts` field (tasks carries no attempts column — see the schema-audit
 * note in callback-task.ts), bumped on every non-terminal outcome and capped
 * at MAX_CALLBACK_ATTEMPTS before the task is given up as 'cancelled' rather
 * than retried forever.
 *
 * THE DOOR: placeOutboundAiCall (lib/voice/twilio-outbound.ts) — the SAME
 * gated door every other autonomous ISA dial uses (app/actions/ai-isa/
 * initiate-engagement.ts's phone lane). `systemSource: "ai_isa"` arms the
 * autonomy gate (SYSTEM_SOURCE_TO_MANAGER maps it to the ai_isa manager) and
 * every consumer-protection gate in lib/voice/outbound-call-gates.ts
 * (autonomy → conversion finality → suppression → TCPA → de-conflict → vendor
 * budget) runs before anything dials — a suppressed/DNC/quiet-hours contact is
 * refused exactly as it would be for any other ISA-initiated call. No new dial
 * path is added, so scripts/outbound-call-gates-simulator.ts needs no change.
 *
 * SIGNAL ROUTING (lib/kernel/signal-routing.ts, owner wave-51 ruling: never a
 * self-route, branch per contact side): on a successful dial this publishes
 * `ai_callback_dispatched` FROM ai_isa TO shopping_agent (buyer-side contact)
 * or listing_concierge (seller-side contact) — an UNRESOLVED contact_type (no
 * contact row, a bare lead) publishes nothing rather than guessing, matching
 * the BRANCHING_EVENTS precedent (isa_outreach_paused etc.).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 300

const BATCH = 100

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "ai-callback-dispatch",
    cron_path: "/app/api/cron/ai-callback-dispatch/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[AiCallbackDispatch] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const svc = createServiceClient()
    const nowIso = new Date().toISOString()

    // Due, pending, AI-executed callback tasks — tenant-scoped rows read across
    // every tenant (platform cron), each one acted on and written back under its
    // OWN brokerage_id only.
    const { data: due, error } = await svc
      .from("tasks")
      .select("id, brokerage_id, contact_id, description, due_date")
      .eq("source", "ai_callback")
      .eq("assignee_type", "ai_isa")
      .eq("status", "pending")
      .lte("due_date", nowIso)
      .order("due_date", { ascending: true })
      .limit(BATCH)
    if (error) throw new Error(`tasks read refused: ${error.message}`)

    let dialed = 0, blocked = 0, cancelled = 0, alreadyClaimed = 0, malformed = 0, dialFailed = 0
    const refusals: Array<{ task_id: string; error: string }> = []

    for (const t of due ?? []) {
      const taskId = (t as any).id as string
      const brokerageId = (t as any).brokerage_id as string | null
      if (!brokerageId) { malformed++; continue }

      const note = decodeCallbackNote((t as any).description as string | null)
      if (!note) {
        malformed++
        // A callback task this sweep cannot even parse can never be dialed —
        // cancel rather than spin on it forever every tick.
        await svc.from("tasks").update({ status: "cancelled", updated_at: nowIso }).eq("id", taskId).eq("status", "pending").then(undefined, () => {})
        continue
      }

      // ── CLAIM (compare-and-swap) — the idempotency stamp. A concurrent run
      // (or a manual re-trigger) that lost the race gets zero rows back and
      // moves on rather than dialing twice.
      const { data: claimed } = await svc
        .from("tasks")
        .update({ status: "in_progress", updated_at: nowIso })
        .eq("id", taskId).eq("status", "pending")
        .select("id")
        .maybeSingle()
      if (!claimed) { alreadyClaimed++; continue }

      if ((note.attempts ?? 0) >= MAX_CALLBACK_ATTEMPTS) {
        cancelled++
        await svc.from("tasks").update({
          status: "cancelled", updated_at: nowIso,
          description: `${(t as any).description}\n[GAVE UP after ${note.attempts} attempts — needs a human callback]`.slice(0, 2000),
        }).eq("id", taskId).then(undefined, () => {})
        continue
      }

      const contactId = (t as any).contact_id as string | null
      let agentUserId: string | null = null
      let contactType: string | null = null
      let leadId: string | null = null
      if (contactId) {
        const { data: c } = await svc.from("contacts").select("agent_id, contact_type").eq("id", contactId).maybeSingle()
        contactType = (c as any)?.contact_type ?? null
        const agentRowId = (c as any)?.agent_id ?? null
        if (agentRowId) {
          const { data: a } = await svc.from("agents").select("user_id").eq("id", agentRowId).maybeSingle()
          agentUserId = (a as any)?.user_id ?? null
        }
      } else {
        // No contact yet — this callback came off a raw caller. Best-effort
        // match to an open lead by phone so the de-conflict/suppression gates
        // (which accept a leadId) see the same over-touch protection a
        // promoted contact would get.
        const { data: leadRow } = await svc.from("leads").select("id")
          .eq("brokerage_id", brokerageId).eq("phone", note.phone).limit(1).maybeSingle()
        leadId = (leadRow as any)?.id ?? null
      }

      const { placeOutboundAiCall } = await import("@/lib/voice/twilio-outbound")
      const placed = await placeOutboundAiCall(svc, {
        toNumber: note.phone,
        contactId,
        brokerageId,
        agentUserId,
        initiatedBy: agentUserId,
        objective: `Return the caller's requested callback${note.reason ? `: ${note.reason}` : ""}. They asked to be called back around "${note.rawPhrase}".`,
        systemSource: "ai_isa",
        leadId,
      })

      if (!placed.ok) {
        const gateBlocked = (placed as any).blocked === true
        if (gateBlocked) {
          blocked++
          // A gate refusal (DNC / suppressed / quiet hours / autonomy held) is
          // not a transient dial failure — retrying next tick would just refuse
          // again. Cancel with the reason on record rather than spin.
          await svc.from("tasks").update({
            status: "cancelled", updated_at: nowIso,
            description: `${(t as any).description}\n[BLOCKED: ${placed.error}]`.slice(0, 2000),
          }).eq("id", taskId).then(undefined, () => {})
        } else {
          dialFailed++
          refusals.push({ task_id: taskId, error: placed.error })
          // Transient (no active number / Twilio API error) — bump the attempt
          // stamp and release the claim back to 'pending' so the NEXT tick (or
          // a due_date the caller can still make) retries.
          const bumped = bumpCallbackAttempt(note)
          await svc.from("tasks").update({
            status: "pending", updated_at: nowIso,
            description: encodeCallbackNote(bumped),
          }).eq("id", taskId).then(undefined, () => {})
        }
        continue
      }

      dialed++
      await svc.from("tasks").update({
        status: "completed", completed_at: nowIso, updated_at: nowIso,
      }).eq("id", taskId).then(undefined, () => {})

      // Signal routing (lib/kernel/signal-routing.ts) — FROM ai_isa, branch by
      // contact side, never self-route. Best-effort: the call already placed
      // successfully; a signal failure must not undo that.
      if (contactType) {
        try {
          const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
          const side = contactType.toLowerCase().includes("seller") ? "listing_concierge" : "shopping_agent"
          await publishManagerSignal({
            brokerageId,
            fromManager: "ai_isa",
            toManager: side,
            signalType: "ai_callback_dispatched",
            message: `The AI ISA placed the callback the contact asked for${note.reason ? ` (${note.reason})` : ""}.`,
            entityType: "voice_call",
            entityId: placed.voiceCallId ?? taskId,
            contactId,
          }, svc)
        } catch { /* best-effort visibility line */ }
      }
    }

    const payload = {
      scanned: due?.length ?? 0,
      batch_cap: BATCH,
      capped: (due?.length ?? 0) >= BATCH,
      dialed, blocked, cancelled, alreadyClaimed, malformed, dialFailed,
      refusals: refusals.slice(0, 20),
    }
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: payload.scanned,
      output_count: dialed,
      metadata: payload,
    })
    return NextResponse.json({ success: true, ...payload })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[AiCallbackDispatch] failed:", message)
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
