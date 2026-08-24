"use server"

import { revalidatePath } from "next/cache"
import { createServerClient, createClient } from "@/lib/supabase/server"
import { agentIdForUser } from "@/lib/agents/agent-for-user"
import { logMilestoneOverdue } from "@/lib/events"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { incrementUsage } from "@/lib/usage"
import { isValidUUID } from "@/lib/validations"
import { authorizeForUser } from "@/lib/auth/authorize-for-user"
// Writers resolve their own identity and their own client here — never from the payload.
import { resolveWriteContext } from "@/lib/platform/acting-context"

// =====================================================
// THE "EVENT HANDLERS" IN THIS FILE ARE NOT EVENT HANDLERS. Owner decision, settled.
// =====================================================
// They were named for a dispatcher that was never going to call them, and the earlier
// note here recorded that as "a build line blocked on the orchestrator lane". That
// premise does not survive reading the orchestrator. Three checks, all repeatable:
//
//   1. `lib/orchestrator/internal.ts:EVENT_HANDLERS` IS NOT A DISPATCH PATH.
//      `orchestrateEvent` routes through `switch (event.event_type)` (internal.ts
//      :158-202). The map is never read at runtime — its own header says so — and it
//      exists to keep unwired feature modules referenced. Adding a name to it wires
//      nothing.
//   2. THERE IS NO EVENT TO HANDLE. `lib/events/types.ts:29-54` is the entire
//      EVENT_TYPES vocabulary: no coaching-booked, and the one near-match for
//      suggestion acceptance (`AI_SUGGESTION_ACTIONED`) has ZERO emitters repo-wide.
//      (It had no morning-kickoff either; that one is now deleted onto its survivor
//      — see the tombstone below.)
//   3. The recorded blocker — `emitEventFromCron` carries a service credential and no
//      session, so `authorizeForUser` refuses every unattended dispatch — is TRUE and
//      MOOT. An internal-caller seam would gate a dispatch that never happens. It
//      would make these look wired while they fire exactly as often as today: never.
//      That is strictly worse than leaving them plainly unwired.
//
// SO THEY ARE USER ACTIONS, and the two below are treated as such: the caller must
// be the user named in the payload, or hold the act-for-others role
// (`authorizeForUser`, lib/auth/authorize-for-user.ts) — and where the payload need
// not name a user at all, it does not get to (see handleSuggestionAccepted). Verified
// before those gates were added: `grep -rn` over `app/api/cron/`, `app/api/webhooks/`
// and the orchestrator found NO unattended caller, so nothing is turned away by them.

/**
 * KEPT AND HARDENED — considered for a merge into the suggestion-status family in
 * app/actions/assistant.ts (dismissSuggestion / completeSuggestion) and deliberately
 * not merged.
 *
 * WHY IT IS NOT A DUPLICATE: `accepted` is a distinct point of the lifecycle, not a
 * synonym for `actioned`. scripts/1082-broaden-smart-assistant-suggestions-status-
 * check.sql:9-14 defines them apart — accepted is "agent agreed but hasn't completed
 * the action yet", actioned is "agent took the action". Nothing else in the tree
 * writes `accepted`, so folding this away removes the middle of that lifecycle.
 *
 * WHY IT WAS NOT MOVED THERE EITHER: moving it means exporting a fourth `"use server"`
 * action that nothing calls. That is a RENAME of an orphan, not a burn-down — the
 * wired-surface ratchet says so in as many words, and it is right: the capability
 * would be no more reachable under a new name than it is under this one.
 *
 * THE HOLE THAT IS FIXED HERE. It read `user_id` out of the caller's payload and wrote
 * it into `metadata.acted_by` as the record of who accepted. This is a `"use server"`
 * export — a public HTTP endpoint — so that field recorded whatever the caller typed,
 * on a row the caller had to be authorized for but could then attribute to anyone. The
 * actor is now resolved server-side from the session and the payload's claim about who
 * acted is ignored; `authorizeForUser` still decides WHETHER the call is allowed.
 *
 * WIRED (this wave). The missing accept control now exists:
 * app/dashboard/coaching/sessions/coaching-sessions-client.tsx calls this for each
 * pending suggestion, on the route app/dashboard/coaching/sessions/page.tsx. It is a
 * SIBLING of /dashboard/coaching rather than a card on it because
 * coaching-dashboard-client.tsx belongs to another lane this wave — the same reason
 * the previous note gave for not building it, resolved by building beside the page
 * instead of inside it. /dashboard/coaching/practice is the existing precedent for a
 * coaching sub-route. The one line still owed on the parent — a link to the sibling
 * beside its suggestions card — is reported to the wave, not written here.
 */
export async function handleSuggestionAccepted(payload: any) {
  const { suggestion_id, action_type } = payload
  // The actor is the SESSION's accountable human — the staff member when acting-as,
  // the user otherwise — never a name lifted out of the request body. This replaces
  // the `authorizeForUser(payload.user_id)` gate the other handler still needs:
  // there is no one to act FOR here, so the payload names nobody and the question
  // collapses to "are you signed in", which resolveWriteContext already answers.
  const write = await resolveWriteContext()
  if (!write.ok) return { success: false, error: write.error }
  if (!write.brokerageId) {
    return { success: false, error: "Your account has no brokerage, so no suggestion can be scoped to you" }
  }

  // GATE-THEN-SERVICE. Under an active full act-as grant this `db` is the SERVICE
  // client, which RLS does not confine — so the tenant predicate is applied here, on
  // BOTH statements, rather than relied on from the client.
  const supabase = write.db

  // ONE write, not two, and the result is read.
  //
  // The pair of updates below used to be separate — and the second REPLACED
  // metadata wholesale rather than merging, so whatever else the suggestion
  // carried was destroyed on acceptance. Both were awaited with the result
  // thrown away, then `{ success: true }` was returned unconditionally: an id
  // that does not exist, or a row RLS hides, reported as accepted.
  const { data: current, error: readError } = await supabase
    .from("smart_assistant_suggestions")
    .select("metadata")
    .eq("id", suggestion_id)
    .eq("brokerage_id", write.brokerageId)
    .maybeSingle()
  if (readError) {
    return { success: false, error: `Could not read the suggestion before accepting it: ${readError.message}` }
  }

  const { data: updated, error } = await supabase
    .from("smart_assistant_suggestions")
    .update({
      status: "accepted",
      metadata: {
        ...((current?.metadata as Record<string, unknown> | null) ?? {}),
        outcome: "accepted",
        action_taken: action_type,
        acted_by: write.actorUserId,
      },
    })
    .eq("id", suggestion_id)
    .eq("brokerage_id", write.brokerageId)
    .select("id")

  if (error) return { success: false, error: error.message }
  if (!updated?.length) {
    return { success: false, error: `No suggestion ${suggestion_id} exists in your brokerage to accept` }
  }

  // The accept surface renders its pending list on the server, so an accepted
  // suggestion stays on screen until this cache entry is dropped.
  revalidatePath("/dashboard/coaching/sessions")

  return { success: true }
}

/**
 * KEPT — no duplicate, and it is the only writer of a coaching booking. `grep -rn` for a
 * second `event_type: "coaching"` calendar_events insert finds exactly this one, and the
 * coaching surface (app/dashboard/coaching) reads suggestions and reports but books
 * nothing. So deleting it would remove the capability outright.
 *
 * WIRED (this wave). The caller the previous note named — "a 'book a session' control on
 * the coaching dashboard" — is app/dashboard/coaching/sessions/coaching-sessions-client.tsx,
 * on the route app/dashboard/coaching/sessions/page.tsx. Coaches are offered from the
 * tenant's own staff roster (broker, broker_admin, broker_owner, team_lead, admin) read
 * server-side, so `coach_id` is chosen from a scoped list rather than typed in.
 *
 * THE PARTIAL OUTCOME IS RENDERED AS A PARTIAL OUTCOME. This returns
 * `{success:true, warning}` when the session lands on the calendar but the prep
 * reminder is refused, and the client shows that warning in its own colour. That
 * distinction only exists because a previous pass stopped discarding these errors —
 * a surface that collapsed it back into a green checkmark would put the old bug
 * ("a coaching session that was never booked looked booked") back on the screen.
 */
export async function handleCoachingSessionBooked(payload: any) {
  const { user_id, session_date, coach_id, topic } = payload
  // Books a real calendar event and a task for `user_id`. Without this gate any caller could
  // put an entry on any agent's calendar and name an arbitrary `coach_id` as the attendee.
  const auth = await authorizeForUser(user_id)
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createServerClient()

  // calendar_events requires brokerage_id + entity_type/entity_id (NOT NULL,
  // pass 5 live catch — this insert ALWAYS failed without them) and tasks
  // requires brokerage_id. Resolve both from the agent row once.
  const { data: agentRow } = await supabase
    .from("agents")
    .select("id, brokerage_id")
    .eq("user_id", user_id)
    .maybeSingle()
  if (!agentRow?.brokerage_id) {
    return { success: false, error: "No agent profile for this user — cannot book the session" }
  }

  // Both writes are CHECKED. The file's own note above records that this insert
  // "ALWAYS failed" before brokerage_id was added — and nobody noticed for
  // exactly this reason: the error was discarded and the function returned
  // success regardless, so a coaching session that was never booked looked
  // booked.
  const { error: eventError } = await supabase.from("calendar_events").insert({
    brokerage_id: agentRow.brokerage_id,
    entity_type: "agent",
    entity_id: agentRow.id,
    agent_user_id: user_id,
    title: `Coaching Session: ${topic}`,
    start_at: session_date,
    end_at: new Date(new Date(session_date).getTime() + 60 * 60 * 1000).toISOString(),
    event_type: "coaching",
    attendees: [coach_id],
  })
  if (eventError) {
    return { success: false, error: `Coaching session not booked: ${eventError.message}` }
  }

  // Create reminder task (assignment keys on agents.id, payload carries users.id)
  const { error: taskError } = await supabase.from("tasks").insert({
    brokerage_id: agentRow.brokerage_id,
    assigned_to_agent_id: agentRow.id,
    title: `Prepare for coaching session: ${topic}`,
    due_date: new Date(new Date(session_date).getTime() - 24 * 60 * 60 * 1000).toISOString(),
    priority: "medium",
  })
  // The session IS on the calendar at this point — report the missing reminder
  // rather than implying the booking failed.
  if (taskError) {
    // Still revalidated: the session IS on the calendar, so the booked list is stale
    // either way. Only the reminder failed.
    revalidatePath("/dashboard/coaching/sessions")
    return { success: true, warning: `Session booked, but the prep reminder was not created: ${taskError.message}` }
  }

  // The booking surface renders the coaching calendar on the server.
  revalidatePath("/dashboard/coaching/sessions")

  return { success: true }
}

// ─── REMOVED in the orphan burn-down ─────────────────────────────────────────
//
// `handleMorningKickoff(payload)` — DELETED. The merge it was waiting on has landed.
//
// SURVIVOR: lib/intelligence/daily-briefing-generator.ts:generateDailyBriefing,
// driven by app/api/cron/daily-briefing/route.ts. It was always the real morning
// briefing — unattended on a service credential for every active agent, seven
// sources read (tasks, transactions, leads, showings, calendar, contacts, plus the
// ISA overnight section), persisted to `ai_daily_briefings` — against this copy's
// ONE source and its single sentence, "You have N tasks today."
//
// The previous note here recorded the one thing the survivor lacked: it wrote the
// briefing row and never DELIVERED it, so nothing rang the bell when a briefing was
// ready. That was the only reason this duplicate was kept. THE DELIVERY IS NOW ON
// THE SURVIVOR — lib/intelligence/daily-briefing-generator.ts:875-888, a
// `notifications` insert keyed on the users.id (NOT the agents.id resolved beside
// it; the spaces are disjoint), tenant-stamped, entity-linked to the briefing row,
// and with its refusal LOGGED as "saved but NOT delivered" rather than swallowed —
// which is the defect this copy had before it was repaired and is the one thing that
// must not be lost in a merge. Its comment names this function as the source.
//
// So there is nothing left here to lose: reading one task list is strictly less than
// reading seven, and the delivery half is gone to a caller that actually runs. Both
// halves of the doctrine are satisfied — merge first, then delete.

export async function generate7DayPlan(payload: any) {
  const supabase = await createServerClient()
  const { contact_id, user_id, lead_source, contact_name } = payload

  // Create 7-day nurture sequence tasks
  const tasks = [
    { day: 0, title: `Welcome call to ${contact_name || "new lead"}`, priority: "urgent" },
    { day: 1, title: "Send personalized property recommendations", priority: "high" },
    { day: 2, title: "Follow up on property interest", priority: "high" },
    { day: 3, title: "Send market update", priority: "medium" },
    { day: 4, title: "Check in - any questions?", priority: "medium" },
    { day: 5, title: "Share neighborhood guide", priority: "medium" },
    { day: 6, title: "Schedule next steps call", priority: "high" },
  ]

  // tasks.brokerage_id is NOT NULL (pass 5) — resolve it with the assignee.
  const { data: nurtureAgent } = await supabase
    .from("agents").select("id, brokerage_id").eq("user_id", user_id).maybeSingle()
  if (!nurtureAgent?.id || !nurtureAgent?.brokerage_id) {
    return { success: false, error: "No agent profile for this user — nurture plan not created" }
  }
  // ONE INSERT, AND THE RESULT IS READ. Both writes below used to be awaited
  // with the result thrown away, and the function then returned
  // `tasksCreated: tasks.length` — the length of the hardcoded template array
  // above. That is 7 whether seven rows landed or zero did. It matters here
  // more than most: the orchestrator fires this on lead.created, and a leads.id
  // is not a contacts.id — tasks.contact_id FKs contacts, so a lead id makes
  // every insert FK-reject and the contacts update match nothing, while the
  // caller is told a seven-touch nurture plan is running.
  const { data: created, error: taskErr } = await supabase
    .from("tasks")
    .insert(
      tasks.map((task) => ({
        brokerage_id: nurtureAgent.brokerage_id,
        contact_id,
        assigned_to_agent_id: nurtureAgent.id, // agents.id — tasks.assigned_to_agent_id FKs agents
        title: task.title,
        due_date: new Date(Date.now() + task.day * 24 * 60 * 60 * 1000).toISOString(),
        priority: task.priority,
        auto_generated: true,
        source: "lead_nurture",
      })),
    )
    .select("id")

  if (taskErr) {
    return { success: false, error: `Nurture plan not created: ${taskErr.message}` }
  }

  const { data: marked, error: statusErr } = await supabase
    .from("contacts")
    .update({ nurture_status: "7_day_plan_active" })
    .eq("id", contact_id)
    .select("id")

  if (statusErr) {
    return { success: false, error: `Tasks created, but the contact was not marked: ${statusErr.message}` }
  }
  if (!marked?.length) {
    return { success: false, error: "No contact matched that id — the nurture plan has no owner" }
  }

  // The number of rows that actually landed.
  return { success: true, tasksCreated: created?.length ?? 0 }
}

// =====================================================
// COPILOT SERVER ACTIONS
// Transaction milestone tracking and automation
// =====================================================

/**
 * Create a milestone on the transaction behind a listing.
 *
 * 🚨 THIS REPORTED SUCCESS WITHOUT DOING THE THING.
 *
 * The insert below never set `transaction_id`, and `params.listing_id` — the only thing tying
 * the request to anything — was **accepted and then never read**. There is no `listing_id`
 * column on `transaction_milestones`, and `transaction_id` is NULLABLE in the live schema, so
 * Postgres accepted the row happily. The result was an orphan milestone attached to no
 * transaction: invisible to the transaction detail page, to `getTransactionMilestones`, to the
 * portal journey and to `checkOverdueMilestones` — while the action returned
 * `{ success: true, milestone: data }` and the caller saw a milestone created.
 *
 * `responsible_party` was likewise accepted and silently dropped (no such column). It is now
 * declared as unsupported rather than pretending, because a caller who passes it today
 * believes an owner was recorded.
 *
 * Finished: the listing is resolved to its transaction IN THE CALLER'S BROKERAGE, and the
 * milestone is attached to it. A listing with no transaction is a refusal, not a silent
 * orphan — you cannot put a milestone on a deal that does not exist yet.
 *
 * ORPHAN BURN-DOWN (lane O) — RECORDED AS A BUILD LINE. It has no caller and, checked
 * against every other milestone writer in the tree, no duplicate: lib/transactions/
 * milestone-service.ts SEEDS a template set, lib/application/transactions.ts:1422 writes
 * an AI-generated client timeline, and app/actions/lender-portal-actions.ts:203 stamps a
 * lender event. This is the only lane for an agent to add ONE ad-hoc milestone by hand.
 *
 * WIRED (this wave). The affordance the previous note said did not exist is
 * app/dashboard/transactions/[id]/milestones/add-milestone-form.tsx, on the deal
 * sub-route app/dashboard/transactions/[id]/milestones/page.tsx — a sibling of the
 * existing /health sub-route, chosen because transaction-detail-client.tsx belongs to
 * another lane this wave. The page reads the deal only to find its `listing_id` (this
 * action takes a LISTING and resolves the transaction itself) and to render what is
 * already there; the write path re-derives both the tenant and the transaction, so the
 * page is not load-bearing for either. The link from the deal header to that sub-route
 * is reported to the wave, not written here.
 *
 * THE TYPE FIELD IS FREE TEXT ON PURPOSE. lib/transactions/milestone-catalog.ts is the
 * canonical set and it is SEEDED — offering it in this form would either duplicate a
 * seeded row or imply the catalog is hand-editable. This lane is for the milestone that
 * is NOT in the catalog.
 */
export async function createTransactionMilestone(params: {
  listing_id: string
  milestone_type: string
  title: string
  due_date: string
  /** Not persisted — `transaction_milestones` has no such column. Ignored. */
  responsible_party?: string
  description?: string
}) {
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()
  if (!profile?.brokerage_id) throw new Error("No brokerage found")

  if (!isValidUUID(params.listing_id)) {
    return { success: false as const, error: "Invalid listing ID" }
  }

  // Resolve the listing's transaction, scoped to the caller's brokerage. `error` is
  // destructured: supabase-js RESOLVES a refused query, so without this an RLS refusal and
  // "this listing has no transaction" would be indistinguishable — and the refusal would be
  // reported to the user as the latter.
  const { data: tx, error: txError } = await supabase
    .from("transactions")
    .select("id")
    .eq("listing_id", params.listing_id)
    .eq("brokerage_id", profile.brokerage_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (txError) {
    return { success: false as const, error: `Could not resolve the transaction: ${txError.message}` }
  }
  if (!tx) {
    return {
      success: false as const,
      error: "No transaction exists for this listing yet — a milestone needs a deal to hang on.",
    }
  }

  // Create milestone
  const { data, error } = await supabase
    .from("transaction_milestones")
    .insert({
      // THE ATTACHMENT. Without this the row is an orphan — see the header comment.
      transaction_id: tx.id,
      brokerage_id: profile.brokerage_id,
      milestone_name: params.milestone_type, // NOT NULL on transaction_milestones
      milestone_type: params.milestone_type,
      title: params.title,
      target_date: params.due_date, // real column is target_date (not due_date)
      description: params.description,
      status: "pending",
    })
    .select()
    .single()

  if (error) throw error

  // The deal's milestone sub-route lists these server-side.
  revalidatePath(`/dashboard/transactions/${tx.id}/milestones`)

  return { success: true as const, milestone: data }
}

export async function checkOverdueMilestones() {
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()
  if (!profile?.brokerage_id) throw new Error("No brokerage found")

  // Find overdue milestones
  const { data: overdueMilestones } = await supabase
    .from("transaction_milestones")
    .select("*")
    .eq("brokerage_id", profile.brokerage_id)
    .eq("status", "pending")
    .lt("target_date", new Date().toISOString())

  if (!overdueMilestones || overdueMilestones.length === 0) {
    return { success: true, count: 0 }
  }

  for (const milestone of overdueMilestones) {
    const daysOverdue = Math.floor((Date.now() - new Date(milestone.target_date).getTime()) / (1000 * 60 * 60 * 24))

    await logMilestoneOverdue({
      brokerage_id: profile.brokerage_id,
      user_id: user.id,
      milestone_id: milestone.id,
      milestone_title: milestone.title,
      days_overdue: daysOverdue,
      listing_id: null, // transaction_milestones links via transaction_id, not listing_id
    })
  }

  return { success: true, count: overdueMilestones.length }
}

export async function completeMilestone(params: { milestone_id: string; completion_notes?: string }) {
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  // Mark milestone as complete
  const { data, error } = await supabase
    .from("transaction_milestones")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      notes: params.completion_notes, // real column is notes (not completion_notes)
    })
    .eq("id", params.milestone_id)
    .select()
    .single()

  if (error) throw error

  return { success: true, milestone: data }
}

export async function generateDailyGameplan(userId: string) {
  const supabase = await createServerClient()

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, first_name, last_name")
    .eq("id", userId)
    .single()

  if (!profile?.brokerage_id) {
    return {
      people_to_call: [],
      deals_to_protect: [],
      content_to_post: [],
      ai_summary: null,
      generated_at: new Date().toISOString(),
    }
  }

  // pass 12: contacts.agent_id and video_scripts_library.agent_id FK agents(id);
  // the dashboard calls this with users.id — resolve once (tasks below already did).
  const gameplanAgentId = (await agentIdForUser(supabase, userId)) ?? userId

  // Get hot leads (score > 70)
  // communications was a writer-less legacy table (burn-down round 6 repoint) — recent replies now read from messages (direction='inbound')
  const { data: hotLeadRows } = await supabase
    .from("contacts")
    .select("*, property_interactions(*)")
    .eq("agent_id", gameplanAgentId)
    .eq("brokerage_id", profile.brokerage_id)
    .gte("lead_score", 70)
    .order("lead_score", { ascending: false })
    .limit(10)

  const hotLeadIds = (hotLeadRows ?? []).map((l: any) => l.id)
  const { data: hotLeadReplies } = hotLeadIds.length
    ? await supabase
        .from("messages")
        .select("id, contact_id, direction, type, body, created_at")
        .in("contact_id", hotLeadIds)
        .eq("direction", "inbound")
    : { data: [] as any[] }
  const hotLeads = (hotLeadRows ?? []).map((l: any) => ({
    ...l,
    communications: (hotLeadReplies ?? []).filter((m: any) => m.contact_id === l.id),
  }))

  // Get at-risk transactions (overdue or due soon)
  //
  // THE "PROTECT DEALS" COLUMN WAS ALWAYS EMPTY. This selected `listings(*)`,
  // and transaction_milestones has NO foreign key to listings (verified live:
  // its only FKs are transaction_id→transactions, brokerage_id→brokerages and
  // the two user columns). PostgREST cannot resolve that embed, so the request
  // failed and — because the error was discarded — the gameplan rendered as
  // "no at-risk deals" forever. The address lives on transactions.
  const { data: atRiskDeals, error: atRiskError } = await supabase
    .from("transaction_milestones")
    .select("*, transactions(id, property_address)")
    .eq("brokerage_id", profile.brokerage_id)
    .eq("status", "pending")
    .lt("target_date", new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString())
    .order("target_date", { ascending: true })
    .limit(10)

  if (atRiskError) {
    console.error("[copilot] at-risk milestone read failed:", atRiskError.message)
  }

  // Get overdue tasks
  const { data: overdueTasks } = await supabase
    .from("tasks")
    .select("*, contacts(*)")
    .eq("assigned_to_agent_id", gameplanAgentId)
    .eq("status", "pending")
    .lt("due_date", new Date().toISOString())
    .order("priority", { ascending: false })
    .limit(10)

  // Get approved content ready to post
  //
  // THE "CONTENT TO POST" COLUMN WAS ALWAYS EMPTY, for two reasons in one select.
  //
  // (1) `generated_videos(*)` — there is NO public.generated_videos table in the
  //     live database, and PostgREST rejects the ENTIRE query when a select names
  //     a relation it cannot resolve. The `.is("generated_videos.published_at",
  //     null)` filter hung off the same phantom.
  // (2) `contacts(*)` — the table exists, but video_scripts_library.contact_id
  //     carries NO foreign key (verified in pg_constraint: the table's only FKs
  //     are agent_id, approved_by, brokerage_id, created_by, rejected_by,
  //     template_id), and without one PostgREST has no relationship to embed.
  //     Fixing only (1) would have left the query failing exactly as before.
  //
  // THE "NOT YET PUBLISHED" FILTER IS GONE BECAUSE NOTHING IN THE SCHEMA CAN
  // ANSWER IT. Nothing links a video_scripts_library row to a rendered video:
  // ai_video_projects.source_script_id FKs `public.scripts`, a DIFFERENT table
  // (see app/actions/video/create-video-project.ts), and generateVideoFromScript
  // deliberately records no library-script id on the project it creates. The only
  // FKs pointing INTO video_scripts_library are marketing_campaigns.source_script_id
  // and script_variations.script_library_id — neither is a video, let alone a
  // published one. So this column now answers the question it CAN answer honestly:
  // approved scripts belonging to this agent. Do not re-add a published-state
  // filter without a real column or FK to hang it on.
  const { data: contentReady, error: contentReadyError } = await supabase
    .from("video_scripts_library")
    .select("id, title, contact_id")
    .eq("agent_id", gameplanAgentId)
    .eq("brokerage_id", profile.brokerage_id)
    .eq("approval_status", "approved")
    .limit(5)

  if (contentReadyError) {
    console.error("[copilot] ready-to-post script read failed:", contentReadyError.message)
  }

  // contact_id has no FK, so the name is fetched rather than embedded — the same
  // shape the hot-lead replies above use.
  const contentContactIds = [...new Set((contentReady ?? []).map((c: any) => c.contact_id).filter(Boolean))]
  const contentContactById = new Map<string, any>()
  if (contentContactIds.length > 0) {
    const { data: contentContacts, error: contentContactsError } = await supabase
      .from("contacts")
      .select("id, first_name, last_name")
      .in("id", contentContactIds)
      .eq("brokerage_id", profile.brokerage_id)
    // A refused read is not "these scripts have no contact".
    if (contentContactsError) {
      console.error("[copilot] ready-to-post contact read failed:", contentContactsError.message)
    }
    for (const c of contentContacts ?? []) contentContactById.set(c.id as string, c)
  }
  const contentToPost = (contentReady ?? []).map((c: any) => ({
    ...c,
    contacts: c.contact_id ? contentContactById.get(c.contact_id) ?? null : null,
  }))

  // Generate AI-powered gameplan summary
  const { text: aiSummary } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt: `You are an AI real estate copilot helping agents prioritize their day.

Generate a daily gameplan for ${profile.first_name}. Organize into 3 columns:

**PEOPLE TO CALL (Priority Contacts):**
${hotLeads?.map((lead) => `- ${lead.first_name} ${lead.last_name} (Score: ${lead.lead_score}) - Stage: ${lead.stage}`).join("\n") || "No hot leads today"}

**DEALS TO PROTECT (At-Risk Transactions):**
${atRiskDeals?.map((deal) => `- ${deal.transactions?.property_address || "Property"} - ${deal.title || deal.milestone_name} (Due: ${new Date(deal.target_date).toLocaleDateString()})`).join("\n") || "No at-risk deals"}

**CONTENT TO POST (Ready to Publish):**
${contentToPost.map((content) => `- Video: ${content.title || "Untitled"} for ${content.contacts?.first_name || "social media"}`).join("\n") || "No content ready"}

**OVERDUE ITEMS:**
${overdueTasks?.map((task) => `- ${task.title} (${task.contacts?.first_name || "No contact"})`).join("\n") || "Nothing overdue"}

Format as actionable priorities with time estimates and recommended order of execution.`,
    temperature: 0.7,
  })

  // Track usage
  await incrementUsage(profile.brokerage_id, "llm_calls", 1)

  return {
    people_to_call: hotLeads || [],
    deals_to_protect: atRiskDeals || [],
    content_to_post: contentToPost,
    overdue_tasks: overdueTasks || [],
    ai_summary: aiSummary,
    generated_at: new Date().toISOString(),
  }
}

/**
 * `taskId` — the gameplan ROW the agent tapped — WAS ACCEPTED HERE AND READ BY
 * NOTHING until 2026-08-24, which left this dispatcher unable to say which row it
 * had refused. Every export of a "use server" file is a public HTTP endpoint
 * (CLAUDE.md §4), so `taskType` and every field of `params` arrive from the client:
 * an unknown type, or a known type with its id missing, reached the delegated lane as
 * `undefined` and came back as an anonymous "that action did not run" toast with no
 * way to tell WHICH row failed or WHY.
 *
 * The required parameter for each lane is now checked before dispatch, and both the
 * refusal and the server log NAME THE ROW.
 */
export async function executeCopilotTask(taskId: string, taskType: string, params: any) {
  const supabase = await createServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  /** Refuse by NAME — the row, the lane, and the field that was missing. */
  const missing = (field: string) => {
    console.warn(`[copilot] task ${taskId} (${taskType}) refused — "${field}" was not supplied`)
    return { success: false, error: `That action is missing its ${field} and did not run (row ${taskId}).` }
  }

  switch (taskType) {
    case "call_hot_lead":
      // No agent id passed: the canonical calling lane derives the agent from
      // the session, which is where user.id came from anyway.
      if (!params?.contactId) return missing("contactId")
      return await initiateCall(params.contactId)

    case "send_property_alert":
      if (!params?.contactId) return missing("contactId")
      return await sendPropertyMatches(params.contactId)

    case "follow_up_showing":
      if (!params?.showingId) return missing("showingId")
      return await requestShowingFeedback(params.showingId)

    case "check_transaction_status":
      if (!params?.transactionId) return missing("transactionId")
      return await checkTransactionDeadlines(params.transactionId)

    case "post_content":
      if (!params?.videoId) return missing("videoId")
      return await postVideoContent(params.videoId, params.platforms)

    default:
      console.warn(`[copilot] task ${taskId} named an unknown task type "${taskType}"`)
      return { success: false, error: `Unknown task type "${taskType}" (row ${taskId}).` }
  }
}

export async function analyzeContactPriority(contactId: string) {
  const supabase = await createServerClient()

  const { data: contact } = await supabase
    .from("contacts")
    .select("*, property_interactions(*)")
    .eq("id", contactId)
    .single()

  if (!contact) return { priority: "low", score: 0, factors: [], recommended_action: "Continue nurture" }

  // communications was a writer-less legacy table (burn-down round 6 repoint) — recent replies now read from messages (direction='inbound')
  const { data: inboundMessages } = await supabase
    .from("messages")
    .select("id, direction, created_at")
    .eq("contact_id", contactId)
    .eq("direction", "inbound")

  let score = contact.lead_score || 0
  const factors = []

  // Recent engagement (last 7 days)
  const last7Days = contact.property_interactions?.filter(
    (i: any) => new Date(i.created_at) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  )

  if (last7Days && last7Days.length >= 5) {
    score += 20
    factors.push("High recent activity")
  }

  // Responded to agent recently
  const recentReplies = inboundMessages?.filter(
    (c: any) => new Date(c.created_at) > new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
  )

  if (recentReplies && recentReplies.length > 0) {
    score += 15
    factors.push("Recently engaged with agent")
  }

  // Timeline urgency
  //
  // REPOINTED to the one timeline vocabulary (constants/crm-standards.ts:
  // STANDARD_TIMELINES). This tested "asap" and "urgent" — a private
  // two-token spelling of `contacts.timeline` that NO writer of that column has
  // ever produced. `contacts.timeline` is written by
  // lib/contact-promotion/contact-creator.ts:137, which copies `leads.timeline`
  // across verbatim, so the two columns share one vocabulary and this test now
  // uses it. `12+_months` and `researching` are deliberately NOT urgent.
  if (
    contact.timeline === "immediate" ||
    contact.timeline === "1-3_months"
  ) {
    score += 25
    factors.push("Urgent timeline")
  }

  // Financial readiness
  if (contact.pre_approved) {
    score += 20
    factors.push("Pre-approved")
  }

  const priority = score >= 80 ? "critical" : score >= 60 ? "high" : score >= 40 ? "medium" : "low"

  return {
    priority,
    score,
    factors,
    recommended_action:
      score >= 80
        ? "Call immediately"
        : score >= 60
          ? "Send property matches today"
          : score >= 40
            ? "Check in this week"
            : "Continue nurture sequence",
  }
}

/**
 * NOTE (m343): this export currently has NO callers anywhere in the repo. It is
 * fixed rather than deleted because an exported server action can be reached by
 * a path a static search does not see, and a broken-but-unreachable action is a
 * trap for whoever wires it up next. If it is still unused when the surface is
 * reviewed, delete it — do not leave it half-alive.
 *
 * IDENTITY CLASS: the parameter is a USERS id (the brokerage lookup below reads
 * `users` by it), but messages, showings, contacts and activities are ALL
 * agents-class. Every one of the four queries below was keyed with the wrong
 * class and would have returned nothing.
 */
export async function suggestNextActions(agentId: string) {
  const supabase = await createServerClient()

  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", agentId).single()

  if (!profile?.brokerage_id) return { suggestions: [] }

  // The agents-class id for the four queries below. Without it they filter an
  // agents column by a users id and return nothing, which reads as "this agent
  // has had no activity" rather than as a bug.
  const agentsId = await agentIdForUser(supabase, agentId)
  if (!agentsId) return { suggestions: [] }

  // Get agent's recent activity
  const { data: recentActivity } = await supabase
    .from("messages")
    .select("*, contacts(*)")
    .eq("agent_id", agentsId)
    .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })

  const suggestions = []

  // Check for unanswered messages
  const unansweredMessages = recentActivity?.filter((comm: any) => comm.direction === "inbound" && !comm.replied_at)

  if (unansweredMessages && unansweredMessages.length > 0) {
    suggestions.push({
      type: "reply_to_client",
      priority: "high",
      action: `Reply to ${unansweredMessages.length} unanswered messages`,
      contact_ids: unansweredMessages.map((m: any) => m.contact_id),
    })
  }

  // Check for showings without feedback
  const { data: showingsNoFeedback } = await supabase
    .from("showings")
    .select("*, contacts(*)")
    .eq("agent_id", agentsId)
    .eq("status", "completed")
    .is("feedback", null)
    .gte("scheduled_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())

  if (showingsNoFeedback && showingsNoFeedback.length > 0) {
    suggestions.push({
      type: "collect_feedback",
      priority: "medium",
      action: `Get feedback on ${showingsNoFeedback.length} recent showings`,
      showing_ids: showingsNoFeedback.map((s: any) => s.id),
    })
  }

  // Check for stale contacts (no contact in 14+ days)
  const { data: staleContacts } = await supabase
    .from("contacts")
    .select("*")
    .eq("agent_id", agentsId)
    .eq("brokerage_id", profile.brokerage_id)
    .in("status", ["active_client", "hot_lead"])
    .lt("last_contacted_at", new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString())
    .limit(5)

  if (staleContacts && staleContacts.length > 0) {
    suggestions.push({
      type: "check_in",
      priority: "medium",
      action: `Check in with ${staleContacts.length} contacts (no contact in 14+ days)`,
      contact_ids: staleContacts.map((c: any) => c.id),
    })
  }

  return { suggestions }
}

// Helper functions for task execution
async function initiateCall(contactId: string) {
  // NOTHING HERE EVER DIALLED A PHONE. This function used to insert a
  // voice_calls row with status "initiated" and started_at = now(), plus an
  // activities row titled "Outbound call initiated" with status "completed",
  // and return { success: true, message: "Call initiated" } — with no provider
  // call anywhere in it. The agent was told the call was placed, the contact's
  // timeline said they had been rung, and the kernel's conversation memory read
  // that activities row as fact and suppressed the real follow-up.
  //
  // The OS already has exactly one agent→contact calling lane that works:
  // initiateWhisperBridge places the call through Twilio, checks the provider
  // result, and only then writes voice_calls with the real vendor_call_id.
  // Delegating rather than re-implementing also satisfies the standing rule
  // that a provider gets one caller, not two. It derives the agent from the
  // session, which is the same actor `agentId` came from (executeCopilotTask
  // passes the authenticated user's own id).
  const { initiateWhisperBridge } = await import("@/app/actions/voice-call-bridge")
  const bridge = await initiateWhisperBridge({
    contactId,
    context: "call requested from the copilot",
  })

  if (!bridge.success) {
    return { success: false, error: bridge.error ?? "The call was not placed" }
  }

  return {
    success: true,
    message: "Calling you now — we'll connect the contact when you pick up",
    callSid: bridge.callSid,
  }
}

async function sendPropertyMatches(contactId: string) {
  const supabase = await createClient()
  
  // Criteria live in property_preferences (NOT contacts) — read via the single normalized
  // reader. The old code selected preferred_* columns off contacts (non-existent) and
  // filtered listings by `price` (the column is list_price), so it matched nothing.
  // `error` is destructured because this row is the TENANT ANCHOR for the
  // notification written at the end of this function: supabase-js RESOLVES a
  // refused read, so `const { data }` alone reports a refusal as "Contact not
  // found" and the two must not be the same answer when one of them decides
  // whose brokerage a row belongs to.
  const { data: contact, error: matchContactError } = await supabase
    .from("contacts")
    .select("id, agent_id, brokerage_id")
    .eq("id", contactId)
    .maybeSingle()

  if (matchContactError) {
    console.error("[copilot] sendPropertyMatches: contacts lookup refused:", matchContactError.message)
    return { success: false, error: "Contact not found" }
  }
  if (!contact) {
    return { success: false, error: "Contact not found" }
  }

  const { loadBuyerCriteria } = await import("@/lib/buyer-search/buyer-criteria")
  const criteria = await loadBuyerCriteria(supabase as unknown as Parameters<typeof loadBuyerCriteria>[0], contactId)

  // Find matching properties based on preferences
  // tenant anchor (scope burn-down): matches come from the contact's own brokerage
  let query = supabase
    .from("listings")
    .select("*")
    .eq("brokerage_id", contact.brokerage_id)
    .eq("status", "active")

  if (criteria?.minPrice) {
    query = query.gte("list_price", criteria.minPrice)
  }
  if (criteria?.maxPrice) {
    query = query.lte("list_price", criteria.maxPrice)
  }
  if (criteria?.minBeds) {
    query = query.gte("bedrooms", criteria.minBeds)
  }
  
  const { data: matches } = await query.limit(10)
  
  // Create property match notification.
  //
  // TENANT — this row is addressed to a CONTACT (`contact_id`), not a user, so
  // the recipient resolver does not apply: the record it is filed against is the
  // contact, whose `brokerage_id` was already read above for the listings query
  // and is reused rather than re-resolved. That is the same one question — "whose
  // brokerage is this row for?" — asked of the record that carries the answer.
  //
  // Unstamped it is invisible to every brokerage-scoped reader of this table
  // while the escape (`brokerage_id IS NULL`) simultaneously admits it to every
  // OTHER tenant's RLS — the exact inversion wave 22 measured.
  if (matches && matches.length > 0) {
    if (!contact.brokerage_id) {
      console.error(
        `[copilot] sendPropertyMatches: contact ${contactId} carries no brokerage_id — property-match notification NOT written rather than written untenanted`,
      )
    } else {
      const { error: matchNotifyError } = await supabase.from("notifications").insert({
        contact_id: contactId,
        brokerage_id: contact.brokerage_id,
        type: "property_matches",
        title: `${matches.length} New Property Matches`,
        body: `We found ${matches.length} properties matching your preferences.`,
        entity_type: "property_match",
      })
      if (matchNotifyError) {
        console.error("[copilot] property_matches notification insert refused:", matchNotifyError.message)
      }
    }
  }
  
  return { success: true, message: `Sent ${matches?.length || 0} property matches`, matchCount: matches?.length || 0 }
}

async function requestShowingFeedback(showingId: string) {
  const supabase = await createClient()

  // Get showing details — need brokerage_id since showing_feedback_requests
  // is brokerage-scoped (NOT NULL).
  const { data: showing } = await supabase
    .from("showing_requests")
    .select("id, brokerage_id, contact_id, property_address")
    .eq("id", showingId)
    .single()

  if (!showing) {
    return { success: false, error: "Showing not found" }
  }

  if (!showing.brokerage_id) {
    return { success: false, error: "Showing missing brokerage scope" }
  }

  // Resolve the contact's email so we can dispatch the feedback request.
  // Without an email there is no recipient; fail explicitly rather than
  // writing a row that can never be delivered.
  const { data: contact } = await supabase
    .from("contacts")
    .select("email")
    .eq("id", showing.contact_id)
    .maybeSingle()

  if (!contact?.email) {
    return { success: false, error: "Contact has no email on file" }
  }

  const feedbackToken = crypto.randomUUID()
  const { error } = await supabase.from("showing_feedback_requests").insert({
    brokerage_id: showing.brokerage_id,
    showing_id: showingId,
    feedback_token: feedbackToken,
    sent_to_email: contact.email,
    sent_at: new Date().toISOString(),
  })

  if (error) {
    console.error("[copilot] Failed to create feedback request:", error)
    return { success: false, error: "Failed to request feedback" }
  }

  return { success: true, message: "Feedback requested" }
}

async function checkTransactionDeadlines(transactionId: string) {
  const supabase = await createClient()
  
  // Get transaction with milestones
  const { data: transaction } = await supabase
    .from("transactions")
    .select("*, milestones:transaction_milestones(*)")
    .eq("id", transactionId)
    .single()
  
  if (!transaction) {
    return { success: false, error: "Transaction not found" }
  }
  
  const now = new Date()
  const upcomingDeadlines = []
  const overdueDeadlines = []
  
  // Check milestone deadlines
  for (const milestone of (transaction.milestones || [])) {
    if (milestone.status !== "completed" && milestone.due_date) {
      const dueDate = new Date(milestone.due_date)
      const daysUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      
      if (daysUntilDue < 0) {
        overdueDeadlines.push({ ...milestone, daysOverdue: Math.abs(daysUntilDue) })
      } else if (daysUntilDue <= 7) {
        upcomingDeadlines.push({ ...milestone, daysUntilDue })
      }
    }
  }
  
  return { 
    success: true, 
    message: `${overdueDeadlines.length} overdue, ${upcomingDeadlines.length} upcoming deadlines`,
    overdueDeadlines,
    upcomingDeadlines,
  }
}

async function postVideoContent(videoId: string, platforms: string[]) {
  const supabase = await createClient()
  
  // video_assets is the canonical video store (video_content was a writer-less
  // legacy twin — burn-down round 3 repoint; same column names).
  const { data: video } = await supabase
    .from("video_assets")
    .select("id, agent_id, brokerage_id, title, video_url, thumbnail_url")
    .eq("id", videoId)
    .single()
  
  if (!video) {
    return { success: false, error: "Video not found" }
  }
  
  // Create scheduled posts for each platform
  const posts = []
  for (const platform of platforms) {
    // social_posts has no video_id/thumbnail_url columns; the video is linked via
    // post_brief (the pattern used by distribute-video.ts / lib/kernel/video.ts).
    const { data: post } = await supabase.from("social_posts").insert({
      brokerage_id: video.brokerage_id,
      agent_id: video.agent_id,
      platform,
      post_type: "custom",
      content: video.title,
      media_urls: [video.video_url],
      post_brief: `video:${videoId}`,
      status: "scheduled",
      scheduled_for: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 mins from now
    }).select().single()
    
    if (post) posts.push(post)
  }
  
  return { success: true, message: `Content scheduled for ${posts.length} platforms`, posts }
}
