"use client"

import { useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  UserCheck,
  Phone,
  ArrowRight,
  Star,
  Clock,
  CheckCircle2,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { KernelEvent } from "@/lib/kernel/events"
import { BookAppointmentDialog } from "./book-appointment-dialog"

interface QualifiedContact {
  id: string
  contact_id: string | null
  qualification_score: number | null
  qualification_result: string | null
  notes: string | null
  qualified_at: string | null
  contacts: {
    id: string
    first_name: string | null
    last_name: string | null
    phone: string | null
    buyer_stage: string | null
  } | null
}

// ─── THE PROP CONTRACT, AND WHY IT IS ONE ID AND NOT TWO ─────────────────────
//
// This panel took an `agentId` prop that one caller filled with an `agents.id`
// (`app/dashboard/voice/isa/page.tsx`, from `getAgentContext().agentId`) and the
// other with a `users.id` (`app/dashboard/isa/page.tsx`, from `user.id`) — and it
// then used that single value for THREE different columns. It was wrong in one
// caller either way, and `agents.id` / `users.id` are DISJOINT id spaces
// (measured live: 5 agents, 23 users, ZERO overlap), so "wrong" here does not
// mean "a slightly wrong person". It means the write is REFUSED.
//
// The owner's ruling settles the semantics: this is the AI handing a live caller
// off to a HUMAN, because the caller asked for a person. So the queue assigns a
// human and must notify that human.
//
// The three columns this component writes were then read off the live catalogue
// rather than off their names — and ALL THREE want a `users.id`:
//
//   ai_isa_qualifications.assigned_to_agent_id
//       → FOREIGN KEY … REFERENCES public.users(id)      ← despite the NAME
//   lifecycle_events.actor_user_id
//       → FOREIGN KEY … REFERENCES public.users(id)
//   notifications.user_id
//       → FOREIGN KEY … REFERENCES public.users(id)
//
// `assigned_to_agent_id` is the trap. `tasks.assigned_to_agent_id` — the SAME
// COLUMN NAME on another table — really does FK `agents(id)`, and a dozen call
// sites in this tree carry comments saying so. On `ai_isa_qualifications` it does
// not. The repo already records this: `scripts/agent-fk-columns.ts:258` lists
// this exact column under `USERS_FK_AGENTISH_COLUMNS`, "columns that FK
// public.users(id) but whose NAME reads agent-ish". And the surface that renders
// the assignee agrees — `app/actions/ai-isa.ts:528` embeds
// `assigned_agent:users!assigned_to_agent_id (first_name, last_name)`, a join
// through that FK into `users`.
//
// So the contract is ONE prop that means ONE thing, and the crossing of the id
// space happens in the caller that has an agent id, not here. Proven live in a
// rolled-back transaction, every branch:
//   agents.id → notifications.user_id ................ REFUSED 23503
//   agents.id → assigned_to_agent_id ................. REFUSED 23503
//   agents.id → lifecycle_events.actor_user_id ....... REFUSED 23503
//   resolved users.id → all three ..................... ACCEPTED, and the real
//     readers see it (badge-counts returns the row; the `users!` embed resolves).
interface HandoffQueuePanelProps {
  queue: QualifiedContact[]
  brokerageId: string
  /**
   * `users.id` of the HUMAN AGENT claiming this handoff.
   *
   * NOT an `agents.id`. Every column this component writes it into FKs
   * `users(id)`, and the two id spaces are disjoint, so an `agents.id` here is a
   * 23503 refusal on all three writes — not a mis-assignment. A caller holding
   * only an `agents.id` must cross the space first: `getAgentContext()` already
   * returns `userId` beside `agentId`, and for a caller that has nothing but an
   * agent id there is `resolveAgentRecipient` in
   * `lib/notifications/recipient-tenant.ts`, which reads `agents.user_id`.
   */
  assignedToUserId: string
}

function formatTimeAgo(dateString: string | null): string {
  if (!dateString) return "--"
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)

  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  return `${Math.floor(diffHours / 24)}d ago`
}

function getScoreBadge(score: number | null) {
  if (!score) return null
  if (score >= 80) {
    return (
      <Badge className="bg-green-500/10 text-green-600 border-green-200">
        <Star className="h-3 w-3 mr-1 fill-current" />
        {score}
      </Badge>
    )
  }
  if (score >= 60) {
    return (
      <Badge className="bg-amber-500/10 text-amber-600 border-amber-200">
        {score}
      </Badge>
    )
  }
  return <Badge variant="secondary">{score}</Badge>
}

export function HandoffQueuePanel({ queue: initialQueue, brokerageId, assignedToUserId }: HandoffQueuePanelProps) {
  const router = useRouter()
  const [claiming, setClaiming] = useState<string | null>(null)
  // Optimistic removal: maintain local copy of the queue
  const [localQueue, setLocalQueue] = useState<QualifiedContact[]>(initialQueue)
  // A handoff that fails must SAY SO. It used to remove the row from the queue
  // and navigate away regardless — see the comment on `handleTakeCall`.
  const [claimError, setClaimError] = useState<string | null>(null)

  // ─── WHY EVERY WRITE BELOW DESTRUCTURES `error` ────────────────────────────
  //
  // supabase-js RESOLVES a refused query. It does not throw. So the `try/catch`
  // that used to wrap this whole function caught NOTHING — a 23503 on any of the
  // three writes arrived as a settled promise, the queue row was removed
  // optimistically, and the router navigated to the contact page. The user saw a
  // completed handoff. Nothing had been assigned, no kernel event was emitted,
  // and NOBODY WAS NOTIFIED.
  //
  // That is not hypothetical here: it is exactly what the `voice/isa` caller did
  // on every click, because it passed an `agents.id`. So the errors are read, the
  // assignment FAILS CLOSED (the row stays in the queue and nothing navigates,
  // because the handoff did not happen), and the two follow-on writes report
  // themselves rather than disappearing.
  const handleTakeCall = async (qualificationId: string, contactId: string | null) => {
    if (!contactId || claiming) return
    setClaiming(qualificationId)
    setClaimError(null)

    const supabase = createClient()

    // 1. Persist: assign the qualification to the HUMAN AGENT taking the call.
    //    `assigned_to_agent_id` FKs users(id) despite its name — see the contract
    //    note above.
    const { error: assignErr } = await supabase
      .from("ai_isa_qualifications")
      .update({
        assigned_to_agent_id: assignedToUserId,
        assigned_at: new Date().toISOString(),
      })
      .eq("id", qualificationId)

    if (assignErr) {
      // FAIL CLOSED. The claim did not happen, so the row stays in the queue and
      // this does not navigate — another agent must still be able to take it.
      console.error("[HandoffQueue] Failed to assign qualification:", assignErr.message)
      setClaimError(`Could not claim this handoff: ${assignErr.message}`)
      setClaiming(null)
      return
    }

    // 2. Emit Kernel handoff event. `actor_user_id` FKs users(id).
    const { error: eventErr } = await supabase
      .from("lifecycle_events")
      .insert({
        brokerage_id: brokerageId,
        entity_type: "contact",
        entity_id: contactId,
        event_type: KernelEvent.AI_ISA_HANDOFF_TO_AGENT,
        actor_user_id: assignedToUserId,
        metadata: {
          qualification_id: qualificationId,
          handoff_type: "manual_claim",
        },
      })
    if (eventErr) {
      console.error("[HandoffQueue] Failed to emit handoff event:", eventErr.message)
    }

    // 3. Notify the human who now owns the call. `notifications.user_id` FKs
    //    users(id), and the reader that lights the bell
    //    (`app/api/dashboard/badge-counts/route.ts`) filters
    //    `.eq("brokerage_id", <the RECIPIENT's users.brokerage_id>)
    //     .eq("user_id", user.id)`, so a row carrying the wrong id space is not a
    //    dim notification — it is no row at all.
    const { error: notifyErr } = await supabase.from("notifications").insert({
      brokerage_id: brokerageId,
      user_id: assignedToUserId,
      type: "handoff_claimed",
      title: "Handoff claimed",
      body: `You claimed a qualified lead from the AI-ISA handoff queue.`,
      entity_type: "qualification",
      entity_id: qualificationId,
      created_at: new Date().toISOString(),
      is_read: false,
    })
    if (notifyErr) {
      // The assignment DID land, so this does not roll the claim back — but a
      // handoff nobody was told about is the failure mode this panel exists to
      // avoid, so it is surfaced rather than logged into the void.
      console.error("[HandoffQueue] Failed to notify the assigned agent:", notifyErr.message)
      setClaimError(`Claimed, but the assigned agent was not notified: ${notifyErr.message}`)
    }

    // 4. Optimistic removal — the claim is persisted, so the row can go.
    setLocalQueue((prev) => prev.filter((item) => item.id !== qualificationId))
    setClaiming(null)

    // 5. Navigate to the contact detail page
    router.push(`/crm/contacts/${contactId}`)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserCheck className="h-5 w-5" />
          Human Handoff Required
          {localQueue.length > 0 && (
            <Badge variant="secondary" className="ml-auto">
              {localQueue.length} ready
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {claimError && (
          <div
            role="alert"
            className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {claimError}
          </div>
        )}
        {localQueue.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <CheckCircle2 className="h-10 w-10 text-green-500/50 mb-3" />
            <p className="text-sm text-muted-foreground">Queue is clear</p>
            <p className="text-xs text-muted-foreground mt-1">
              AI-qualified contacts will appear here for agent follow-up
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {localQueue.map((item) => (
              <div
                key={item.id}
                className="flex items-start justify-between gap-3 p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
              >
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium">
                      {item.contacts?.first_name} {item.contacts?.last_name}
                    </p>
                    {getScoreBadge(item.qualification_score)}
                    {item.qualification_result && (
                      <Badge
                        variant="outline"
                        className="text-xs capitalize"
                      >
                        {item.qualification_result.replace(/_/g, " ")}
                      </Badge>
                    )}
                  </div>

                  {item.contacts?.phone && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Phone className="h-3 w-3" />
                      {item.contacts.phone}
                    </p>
                  )}

                  {item.notes && (
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {item.notes}
                    </p>
                  )}

                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    Qualified {formatTimeAgo(item.qualified_at)}
                  </p>
                </div>

                <div className="flex flex-col items-stretch gap-2 shrink-0">
                  {item.contact_id && (
                    <BookAppointmentDialog
                      contactId={item.contact_id}
                      contactName={`${item.contacts?.first_name ?? ""} ${item.contacts?.last_name ?? ""}`.trim()}
                      onBooked={() =>
                        setLocalQueue((prev) =>
                          prev.filter((q) => q.id !== item.id),
                        )
                      }
                    />
                  )}
                  <Button
                    size="sm"
                    disabled={claiming === item.id}
                    onClick={() => handleTakeCall(item.id, item.contact_id)}
                  >
                    {claiming === item.id ? (
                      <span className="text-xs">Claiming...</span>
                    ) : (
                      <>
                        <ArrowRight className="h-3 w-3 mr-1" />
                        <span className="text-xs">Hand Off to Human Agent</span>
                      </>
                    )}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
