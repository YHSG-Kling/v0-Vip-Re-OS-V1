"use server"

import { createServerClient } from "@/lib/supabase/server"
import { generateTextRouted as generateText } from "@/lib/ai/models"
// THE SPEND ACTOR. Every export in this "use server" file is a public HTTP
// endpoint, so the AI cost ledger's tenant can only come from the SESSION
// (CLAUDE.md §4) — never from an id the caller supplied.
import { getAgentContext, type AgentContext } from "@/lib/identity/get-agent-context"
// The buyer_behavior_log signal families — imported from the vocabulary owner (§6),
// never re-spelled locally.
import { VIEW_SIGNALS } from "@/lib/behavior-learning/signal-mapping"

// =====================================================
// EVENT HANDLERS — exposed as server actions but no UI currently invokes them.
// They originally had zero auth and would accept arbitrary payloads (any
// authenticated user could delegate any task to anyone, log queries as any
// user, etc.). Hardened: caller must own the relevant user_id, OR be admin.
//
// ORPHAN BURN-DOWN — SETTLED, AS AN OWNER DECISION. They are NOT event handlers,
// and the earlier note that they were "a build line blocked on the orchestrator
// lane" rested on a premise that does not survive reading the orchestrator.
//
// THE DISPROOF, in checks anyone can repeat:
//   1. RETIRED (2026-09-02). This check used to say `EVENT_HANDLERS` "IS NOT A
//      DISPATCH PATH" and that orchestrateEvent never read it. That stopped being
//      true last wave: internal.ts:40 now heads the map "CONSULTED BY
//      orchestrateEvent()", the switch dispatches THROUGH it (dispatchRegistered),
//      and internal.ts:97-100 names this very note as stale. Struck rather than
//      left to mislead the next reader. It was never the decisive reason.
//   2. THERE IS NO EVENT — and that alone is decisive. `lib/events/types.ts:29-54`
//      is the whole EVENT_TYPES vocabulary. It has no member for an assistant
//      query, a task delegation or an automation firing — and no member for the
//      copilot three either. The closest, `AI_SUGGESTION_ACTIONED`, has ZERO
//      emitters repo-wide. Registering a handler for an event nothing writes
//      cannot make it fire.
//   3. So the recorded blocker (a service-credentialed dispatcher versus a session
//      gate) is real but MOOT: an internal-caller seam would gate a dispatch that
//      never occurs. Building it would put a door on a wall and make six functions
//      look wired while firing exactly as often as they do now, which is never.
//
// WHAT THEY ARE INSTEAD — each is user-initiated, not event-driven:
//   · handleAssistantQuery / handleAutomationTriggered — TELEMETRY. Each was the SOLE
//     writer of its table (`assistant_queries`, `automation_logs`) and NEITHER table
//     had a reader anywhere in the repo; scripts/orphan-write-sweep.ts:38 already
//     classifies assistant_queries as "assistant usage telemetry". They were kept as
//     the write half of a telemetry pair whose read half was never built. Not
//     deleted (no duplicate, and deleting the only writer of a live table loses the
//     column), not registered (nothing emits an event for them).
//
//     ── THAT STALEMATE IS NOW BROKEN, AND THE TWO WENT DIFFERENT WAYS ────────
//     "Kept as the write half of a pair whose read half was never built" is a
//     description of a deadlock, not a verdict, and the opposite-missing census
//     (scripts/opposite-missing-census.ts) put both ends of each pair on one page
//     so the deadlock could actually be broken.
//
//     handleAutomationTriggered — BUILT, both halves. Neither end had to be
//     invented: the entity exists (`workflow_automations`), the executor exists
//     (app/actions/multi-persona.ts:executeWorkflow) and wrote back only
//     `execution_count + 1`, and the surface exists
//     (app/dashboard/admin/automations). It now has a caller and a reader. See
//     its own header below.
//
//     handleAssistantQuery — STILL UNWIRED, and now with a NAMED DUPLICATE
//     rather than an open question. `assistant_queries` is
//     ["context","created_at","id","query","timestamp","user_id"] and HAS NO
//     brokerage_id COLUMN AT ALL, so a row written here is untenanted by
//     construction and can never appear on any tenant-scoped surface — which is
//     most of why no reader was ever built for it. Two live, tenanted ledgers
//     already record the same event more completely, both with writers that RUN
//     and at least one reader:
//       · `ai_tool_usage` — written by app/actions/ai-tools-hub.ts:executeAITool
//         and by lib/kernel/ai-tools.ts:runAiTool, read by lib/kernel/ai-tools.ts
//         :172. Carries brokerage_id, the input context, the OUTPUT, timing,
//         success and token cost. `assistant_queries` carries none of those.
//       · `agent_assistant_sessions` / `agent_assistant_tool_calls` — written by
//         app/api/agent-assistant/session and .../tool-call, both tenanted.
//     RECOMMENDED VERDICT, handed back rather than executed: delete
//     handleAssistantQuery onto lib/kernel/ai-tools.ts:runAiTool with a tombstone,
//     and in the same change drop the now-false `assistant_queries` exemption in
//     scripts/orphan-write-baseline's AUDIT_EXEMPT list (an exemption that names
//     an out-of-band consumer for a table nothing writes is worse than none — the
//     writerless sweep's own header makes that argument about prohibited_phrases).
//     Not done here because it deletes the only writer of a live table AND
//     requires editing a committed baseline this lane does not own.
//   · handleTaskDelegated — MERGED, THEN DELETED. It was a TASK REASSIGNMENT, and
//     app/actions/tasks.ts:updateTask (`params.assignedTo` → `assigned_to_agent_id`)
//     is the wired survivor of that write. The cross-lane merge this note named is
//     now done: the survivor carries BOTH items this copy held and it did not — the
//     ownership test before a reassignment (current assignee, creator, or
//     broker/admin) and the notice to the new assignee, tenant-stamped through
//     lib/notifications/recipient-tenant.ts. It carries them WITH the tenant
//     predicate this copy never had: handleTaskDelegated read and updated `tasks` by
//     id with NO brokerage scope, so a delegator could probe and reassign a task in
//     another brokerage as long as they happened to be its assignee there.
// =====================================================

// The gate this file grew privately now lives in ONE place and is shared with
// app/actions/copilot.ts, whose identical event handlers had no gate at all. Two behaviours
// moved WITH it rather than being lost:
//   · it destructures `error` on both reads (supabase-js RESOLVES a refused query, so a
//     refusal used to be indistinguishable from "no such user" — in a gate those must differ);
//   · a missing `targetUserId` no longer falls through to the role check by accident — an
//     unstated target now requires the act-for-others role explicitly.
// See lib/auth/authorize-for-user.ts for why it is a plain module (server-only would break
// any plain-tsx guard that transitively imports it).
import { authorizeForUser } from "@/lib/auth/authorize-for-user"

/**
 * TOMBSTONE. `handleAssistantQuery` LIVED HERE AND IS GONE. Its survivors are
 * app/api/agent-assistant/tool-call/route.ts:161 (`agent_assistant_tool_calls`)
 * and app/api/agent-assistant/session/route.ts:153 (`agent_assistant_sessions`).
 *
 * The stalemate the note above describes — "the write half of a telemetry pair
 * whose read half was never built" — was never going to be broken by building
 * the reader, because THE TABLE CANNOT SUPPORT ONE. `assistant_queries` is
 * ["context","created_at","id","query","timestamp","user_id"] and has NO
 * brokerage_id column at all, so every row it has ever held is untenanted by
 * construction and cannot be shown on any tenant-scoped surface in this app.
 * That is the reason no reader was ever built, and it is a property of the
 * schema rather than of anyone's backlog.
 *
 * WHAT THE SURVIVORS CARRY THAT THIS DID NOT: the tenant (taken from the
 * session row, never from the caller), the tool input AND its output, success,
 * latency and token cost, and an actual reader — lib/recruiting/retention-radar
 * .ts:25 reads agent_assistant_sessions, and tool-call/route.ts:19 states the
 * audit purpose in its own header. This function wrote four fields and read
 * back nothing.
 *
 * WHAT WAS MERGED FORWARD: nothing, and that is a finding rather than an
 * omission. Its one distinctive behaviour was the authorizeForUser(user_id)
 * act-for-others gate — which guarded an endpoint no caller in the tree ever
 * reached. Its INSERT did not destructure `error`, so the single thing it did
 * do, it did blind: supabase-js RESOLVES a refused write, so a row rejected by
 * RLS and a row accepted looked identical from here.
 *
 * `assistant_queries` keeps its rows and its m-numbered history; it simply stops
 * gaining new ones. Its AUDIT_EXEMPT entry in scripts/orphan-write-sweep.ts is
 * removed in the same change: an exemption that names an out-of-band consumer
 * for a table nothing writes is worse than no exemption, because it reads as a
 * deliberate design where the truth is a dead end — the same argument that
 * file's own header makes about prohibited_phrases.
 *
 * This file is `"use server"`, so deleting this also removes a public HTTP
 * endpoint that accepted a `user_id` from its payload and had no caller.
 */

/**
 * THE PER-RUN LEDGER FOR A SAVED AUTOMATION. NOW WIRED, BOTH HALVES.
 *
 * This was category C — exported, called by nobody, writing a table nobody read.
 * The note above used to file it under "telemetry kept as the write half of a pair
 * whose read half was never built", which was an accurate description of a
 * stalemate and not a verdict. Both halves exist now, and neither needed inventing:
 *
 *   THE CALLER — app/actions/multi-persona.ts:executeWorkflow. That function runs a
 *   saved `workflow_automations` row and, on finishing, wrote back exactly two
 *   facts: `execution_count + 1` and `last_executed_at`. So the admin automations
 *   page could say a rule had fired 43 times and nothing whatever about what any of
 *   the 43 runs DID — including the runs that took the `update_milestone` branch,
 *   refused an operator-authored status, and logged to the server console before
 *   incrementing the counter anyway. `automation_logs` is the table that answers
 *   that question, and this is its writer.
 *
 *   THE READER — app/dashboard/admin/automations/page.tsx, beside the existing
 *   automation_errors panel, through the same service-client-after-gate pattern
 *   lib/kernel/manager-registry.ts:463 named as the destination for this table.
 *
 * `automation_id` is a `workflow_automations.id`. `brokerage_id` is NOT stamped
 * here and that is deliberate, not an omission: migration 052 puts a BEFORE INSERT
 * trigger (`automation_logs_set_brokerage`) on the table that denormalises it from
 * `user_id`, and a second app-side write of the same value would be a second
 * opinion about the tenant.
 */
export async function handleAutomationTriggered(payload: any) {
  const { automation_id, trigger_type, user_id, result } = payload
  const auth = await authorizeForUser(user_id)
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createServerClient()
  const { error } = await supabase.from("automation_logs").insert({
    automation_id,
    user_id,
    trigger_type,
    result,
    executed_at: new Date().toISOString(),
  })
  // supabase-js RESOLVES a refused insert, so an unread error here is a run that
  // the ledger silently never recorded — and a ledger with holes in it is worse
  // than no ledger, because the page above now presents it as the record.
  if (error) {
    console.error("[assistant] automation_logs insert refused:", error.message)
    return { success: false, error: error.message }
  }

  return { success: true }
}

// =====================================================
// SMART ASSISTANT SUGGESTIONS
// =====================================================
//
// TOMBSTONE (§1.3/§6, lane N3a 2026-09-01): app/api/ai/content-suggestions/route.ts
// DELETED. It was a hard-coded rule table (no model, wrote nothing) posing as a
// second per-contact suggestion lane beside this one — the §6 defect. Nothing
// was carried across, on evidence: its rules keyed on lifecycle_stage / stage /
// buyer_type / price_range / preferred_locations, NONE of which are live
// contacts columns (scripts/schema-snapshot.ts:239), so on real rows every
// branch but its "awareness" default was dead and the two suggestions that
// could ever fire were generic boilerplate. SURVIVOR lane:
// smart_assistant_suggestions — writer generateSmartSuggestion below, reader
// app/actions/contact-details.ts.

/** smart_assistant_suggestions.priority — the live CHECK vocabulary
 *  (scripts/check-vocabularies.ts:1371). "critical" is NOT a member; callers
 *  carrying it map to "high" (lib/intelligence/multi-agent-router.ts:349 makes
 *  the same mapping). */
type SuggestionPriority = "low" | "medium" | "high"

interface SuggestionInput {
  brokerage_id: string
  user_id: string
  context_type: string
  context_id: string
  suggestion_type: string
  title: string
  description: string
  action_payload: Record<string, any>
  /** Optional — the readers ORDER BY this column (app/actions/contact-details.ts
   *  :199, app/dashboard/coaching/page.tsx:75), and this writer never set it, so
   *  every row it wrote sorted as NULL. */
  priority?: SuggestionPriority
}

export async function generateSmartSuggestion(input: SuggestionInput): Promise<void> {
  const supabase = await createServerClient()

  const { data: sugAgentRow } = await supabase
    .from("agents").select("id").eq("user_id", input.user_id).eq("brokerage_id", input.brokerage_id).maybeSingle()
  const suggestionAgentId = (sugAgentRow as { id?: string } | null)?.id ?? null
  if (!suggestionAgentId) return

  // pass 14 (array-literal sweep): the live columns are agent_id /
  // action_payload_json, and context_id rides metadata (no such column) —
  // the old user_id/context_id/action_payload keys errored every insert.
  //
  // THE METADATA KEY (§6, 2026-09-02). This wrote `metadata.context_id`, a key
  // NO reader in the tree consults. The one reader that keys on metadata at all
  // — app/actions/contact-details.ts:192, the /crm "Suggestions for this
  // contact" card — filters `metadata->>contact_id`, the spelling every OTHER
  // writer uses (lib/intelligence/intent-classifier.ts:126, ai-reply-coach,
  // fatigue-calculator, alert-notifier). So the nine orchestrator call sites
  // routed through here with context_type "contact" (internal.ts:404,:440,…)
  // wrote rows the contact card could never show. SURVIVOR spelling:
  // `<context_type>_id` — contact_id / listing_id / transaction_id / video_id /
  // image_id, which is every context_type the tree passes here. `context_id`
  // is no longer written.
  const { error } = await supabase.from("smart_assistant_suggestions").insert([
    {
      brokerage_id: input.brokerage_id,
      // IDENTITY CLASS (m365). pass 14 fixed the COLUMN NAMES here — its
      // comment above records that the old user_id/context_id keys "errored
      // every insert" — and left the users id in the renamed agents-class
      // column. So the insert still errored, just for a different reason: a
      // rename that moved the bug rather than removing it.
      agent_id: suggestionAgentId,
      context_type: input.context_type,
      suggestion_type: input.suggestion_type,
      title: input.title,
      description: input.description,
      action_payload_json: input.action_payload,
      metadata: { [`${input.context_type}_id`]: input.context_id },
      status: "pending",
      ...(input.priority ? { priority: input.priority } : {}),
    },
  ])

  if (error) {
    console.error("[v0] Error creating suggestion:", error)
    throw error
  }
}

/**
 * Both of these used to return void and DROP the supabase error. supabase-js
 * resolves a rejected update rather than throwing, so a suggestion that failed
 * to move disappeared from the coaching list anyway and reappeared on the next
 * load with no explanation. The card is the agent's to-do; silently failing to
 * action it is the worst outcome. Return the real result and let the caller say
 * so.
 */
type SuggestionResult = { success: true } | { success: false; error: string }

/**
 * The suggestion-status writer for the two points THIS file's exports move a card to.
 * `accepted` is a third, distinct point — scripts/1082-broaden-smart-assistant-
 * suggestions-status-check.sql:9-14 defines it as "agent agreed but hasn't completed
 * the action yet" — and its writer is app/actions/copilot.ts:handleSuggestionAccepted.
 * It is deliberately NOT folded in here: doing so meant adding a fourth exported
 * server action with no caller, which is a rename of an orphan and not a burn-down.
 */
async function setSuggestionStatus(
  suggestionId: string,
  status: "dismissed" | "actioned",
): Promise<SuggestionResult> {
  const supabase = await createServerClient()

  const { data: updated, error } = await supabase
    .from("smart_assistant_suggestions")
    // no actioned_at column — status is the canonical action record
    .update({ status })
    .eq("id", suggestionId)
    .select("id")

  if (error) {
    console.error(`[assistant] suggestion ${suggestionId} → ${status} failed:`, error.message)
    return { success: false, error: error.message }
  }
  if (!updated?.length) {
    // supabase-js resolves an update that matched nothing exactly like one that
    // matched a row. Without this the card silently reappears on the next load.
    return { success: false, error: `No suggestion ${suggestionId} is visible to you to mark ${status}` }
  }
  return { success: true }
}

export async function dismissSuggestion(suggestionId: string): Promise<SuggestionResult> {
  return setSuggestionStatus(suggestionId, "dismissed")
}

export async function completeSuggestion(suggestionId: string): Promise<SuggestionResult> {
  return setSuggestionStatus(suggestionId, "actioned")
}

/** One rule-engine suggestion, as the four per-page helpers below produce it. */
interface RuleSuggestion {
  type: string
  priority: "low" | "medium" | "high" | "critical"
  icon: string
  title: string
  description: string
  action: string | null
  action_params?: Record<string, any>
}

/** Which surface a page's suggestions are FOR, in the table's own
 *  `context_type` vocabulary (the values the orchestrator already writes —
 *  lib/orchestrator/internal.ts:407,:486,:644). */
const PAGE_CONTEXT_TYPE: Record<string, string> = {
  contact_detail: "contact",
  listing_detail: "listing",
  transaction_detail: "transaction",
  dashboard: "dashboard",
}

/**
 * THE PAGE-LEVEL RULE ENGINE — NOW PERSISTED THROUGH THE SURVIVOR (§1.2 BUILD,
 * 2026-09-02).
 *
 * This was the ONE remaining category-C orphan export: four real rule sets
 * (getContactSuggestions, getListingSuggestions, getTransactionSuggestions,
 * getDashboardSuggestions) that returned an in-memory array to a caller that
 * did not exist. It could not be deleted — `generateSmartSuggestion` above is
 * an INSERT API, not a rule engine, so there was no duplicate to merge onto,
 * and deleting four rule sets to move a number is forbidden. It could not be
 * wired to the orchestrator — lib/orchestrator/internal.ts:125-130 REFUSES its
 * three mapped events (lead.tagged_hot, lead.engaged,
 * transaction.milestone_overdue) explicitly, because none of them carries a
 * `page`, and nothing emits two of them anyway.
 *
 * WHAT IT DOES NOW: every suggestion the rules produce is written to
 * `smart_assistant_suggestions` THROUGH generateSmartSuggestion, so it lands on
 * the three readers that already exist —
 *   · app/actions/contact-details.ts:getContactCopilotSuggestions
 *     (metadata->>contact_id, pending, this agent + brokerage) → the
 *     "Suggestions for this contact" card on /crm (app/crm/page.tsx:2265);
 *   · app/dashboard/coaching/page.tsx:71 (this agent, pending, top 5);
 *   · app/dashboard/coaching/sessions/page.tsx:98 (this agent, pending, 25).
 * The array is still returned so a caller can render immediately.
 *
 * THE TRIGGER, decided: THE PAGE THAT KNOWS ITS PAGE. The natural call site is
 * the /crm contact-detail load — app/crm/page.tsx:507 already awaits
 * getContactCopilotSuggestions(contactId) in the same Promise.all; a
 * generate-then-read there (or inside that action) is one line, and the
 * dedupe below makes a repeat open free. A CADENCE was rejected on three
 * counts: (a) the contact rules reach a model — a sweep over every contact is
 * unbounded AI spend on the platform-covered ledger (§5: a wrong number there
 * is a wrong invoice); (b) getAgentContext() is a SESSION gate, so an
 * unattended cron would fail closed by construction (§4) and a service-client
 * variant would be exactly the seam internal.ts:105-111 declines to build;
 * (c) the rules are per-entity facts ("3 showings without feedback") that are
 * only worth writing when someone is about to look. The one-line wire in
 * contact-details.ts / crm/page.tsx belongs to those files' owner.
 *
 * DEDUPE, so the page trigger is idempotent: a suggestion whose title is
 * already PENDING for this agent + brokerage + context is not written again,
 * and when a pending "AI Recommendation" already exists for a contact the
 * model is NOT called — the existing card is the recommendation. A rule whose
 * title carries a changed count ("4 showings…" after "3 showings…") is a new
 * fact and is written.
 *
 * AUTH — nothing here widens the gate: the tenant and the agent come from the
 * SESSION (getAgentContext, §4 — the `agentId` parameter this used to take is
 * GONE; it named which agent's dashboard to read and was caller-supplied,
 * i.e. a same-tenant peer could be probed by id), every read is RLS-bound
 * through createServerClient, and an unauthenticated or untenanted caller is
 * refused before any read or model call (fail closed).
 */
export async function generateAssistantSuggestions(
  context: {
    page: string
    entity_id?: string
    entity_type?: string
  },
): Promise<{ suggestions: RuleSuggestion[]; persisted: number; skipped: number; error?: string }> {
  // Tenant for the AI cost ledger AND for the rows — SESSION, never a
  // parameter (§4). Threaded into the per-page helpers below, which reach a
  // model.
  const spendActor = await getAgentContext()
  if (!spendActor.isAuthenticated || !spendActor.brokerageId) {
    return { suggestions: [], persisted: 0, skipped: 0, error: "Not authenticated" }
  }
  const contextType = PAGE_CONTEXT_TYPE[context.page]
  if (!contextType) {
    return { suggestions: [], persisted: 0, skipped: 0, error: `Unknown page: ${context.page}` }
  }
  // The dashboard's context is the agent themselves; the other three need an
  // entity. No entity → nothing to suggest about, honestly.
  const contextId = context.page === "dashboard" ? spendActor.agentId : (context.entity_id ?? null)
  if (!contextId) {
    return { suggestions: [], persisted: 0, skipped: 0, error: "No entity for this page" }
  }

  // ── DEDUPE READ — what is already pending for this page ──────────────────
  // RLS-bound; scoped the way the readers scope (agent + brokerage + the
  // metadata link generateSmartSuggestion writes).
  const supabase = await createServerClient()
  const pendingTitles = new Set<string>()
  if (spendActor.agentId) {
    const { data: pendingRows, error: pendingError } = await supabase
      .from("smart_assistant_suggestions")
      .select("title")
      .eq("brokerage_id", spendActor.brokerageId)
      .eq("agent_id", spendActor.agentId)
      .eq("context_type", contextType)
      .eq(`metadata->>${contextType}_id`, contextId)
      .eq("status", "pending")
    if (pendingError) {
      // A refused dedupe read must not become "nothing is pending" and a
      // duplicate card — nor a model call that already has an answer. Refuse.
      console.error("[assistant] pending-suggestion read refused — nothing generated:", pendingError.message)
      return { suggestions: [], persisted: 0, skipped: 0, error: pendingError.message }
    }
    for (const r of pendingRows ?? []) if (r.title) pendingTitles.add(r.title as string)
  }

  const suggestions: RuleSuggestion[] = []

  switch (context.page) {
    case "contact_detail":
      suggestions.push(...(await getContactSuggestions(contextId, spendActor, {
        skipAi: pendingTitles.has(AI_RECOMMENDATION_TITLE),
      })))
      break

    case "listing_detail":
      suggestions.push(...(await getListingSuggestions(contextId)))
      break

    case "dashboard":
      suggestions.push(...(await getDashboardSuggestions(contextId)))
      break

    case "transaction_detail":
      suggestions.push(...(await getTransactionSuggestions(contextId)))
      break
  }

  // ── PERSIST THROUGH THE SURVIVOR ─────────────────────────────────────────
  let persisted = 0
  let skipped = 0
  let firstError: string | undefined
  for (const s of suggestions) {
    if (pendingTitles.has(s.title)) { skipped++; continue }
    try {
      await generateSmartSuggestion({
        brokerage_id: spendActor.brokerageId,
        user_id: spendActor.userId,
        context_type: contextType,
        context_id: contextId,
        suggestion_type: s.type,
        title: s.title,
        description: s.description,
        action_payload: { action: s.action, icon: s.icon, ...(s.action_params ?? {}) },
        priority: s.priority === "critical" ? "high" : s.priority,
      })
      persisted++
      pendingTitles.add(s.title) // two rules with one title in a single run write once
    } catch (err) {
      // generateSmartSuggestion THROWS on a refused insert (it reads its error).
      // Counted and reported, not swallowed: the array below still renders, but
      // the caller is told the queue is short.
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[assistant] suggestion persist refused:", msg)
      firstError ??= msg
    }
  }

  return { suggestions, persisted, skipped, ...(firstError ? { error: firstError } : {}) }
}

/** ONE spelling of the model-authored card's title — the dedupe key that keeps
 *  a repeat page open from re-spending on a recommendation already pending. */
const AI_RECOMMENDATION_TITLE = "AI Recommendation"

/** `spendActor` is the SESSION context resolved by the caller — the AI ledger's
 *  tenant, threaded rather than re-derived so its provenance stays visible.
 *  `skipAi` — the caller found a pending "AI Recommendation" for this contact
 *  already; the rules still run (they are free), the model is not called. */
async function getContactSuggestions(
  contactId: string,
  spendActor: AgentContext,
  opts: { skipAi?: boolean } = {},
): Promise<RuleSuggestion[]> {
  const supabase = await createServerClient()

  // The error is checked: supabase-js RESOLVES a failed query, so an unchecked read hands
  // back an absence indistinguishable from a contact with nothing to suggest.
  //
  // TOMBSTONE — the `, communications(*)` embed was REMOVED here. Per-contact message
  // history is read at app/actions/copilot.ts:537 and app/actions/copilot.ts:742
  // (`.from("messages")`, direction-filtered to inbound); that is the survivor, and this
  // embed had no reader at all — `contact.communications` was dereferenced nowhere in
  // this file.
  //
  // CORRECTING A STALE PREMISE that stood here and still stands at copilot.ts:740:
  // `communications` is NOT a writer-less legacy table. It is LIVE and narrowly scoped —
  // lib/connections/zoom-transcripts.ts:147 inserts a platform-hosted Zoom meeting
  // transcript into it (error read at :164) and the DB trigger
  // `communications_set_brokerage_trg` (supabase/migrations/062-long-tail-batch-3.sql:506-517)
  // stamps brokerage_id on insert. What makes a CONTACT-keyed embed against it structurally
  // empty is the shape of that sole writer, not an absent one: it writes `contact_id: null`
  // deliberately, because a tenant Zoom transcript attaches to the TENANT, not to a contact.
  // So the embed's join on communications_contact_id_fkey could only ever return [].
  // Anyone chasing a missing writer here will not find one — there is nothing to build.
  //
  // `property_interactions(*)` was likewise removed in the m598 retirement; the recent-views
  // suggestion below reads the live twin, buyer_behavior_log.
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .single()

  if (contactError) {
    console.error("[assistant] contact suggestions read failed:", contactError)
    return []
  }
  if (!contact) return []

  const suggestions: RuleSuggestion[] = []

  // Check last contact date
  const daysSinceContact = contact.last_contact_date
    ? Math.floor((Date.now() - new Date(contact.last_contact_date).getTime()) / (1000 * 60 * 60 * 24))
    : 999

  if (daysSinceContact > 7) {
    suggestions.push({
      type: "action",
      priority: "high",
      icon: "📞",
      title: "Time for a check-in",
      description: `It's been ${daysSinceContact} days since you last connected`,
      action: "send_message",
      action_params: { contact_id: contactId },
    })
  }

  // Check for recent property views — REPOINTED onto buyer_behavior_log (m598).
  //
  // THIS SUGGESTION HAS NEVER FIRED. It counted `property_interactions`, a table
  // with ZERO writers anywhere in the tree (its only trigger is BEFORE INSERT,
  // which never fires because nothing inserts) — so the count was structurally 0
  // forever and no "Hot lead alert!" was ever raised. buyer_behavior_log is the
  // live twin; the copy says VIEWED, so the filter is VIEW_SIGNALS ALONE — the
  // honest family from the vocabulary owner (lib/behavior-learning/
  // signal-mapping.ts). Counting saves or dismissals here would put words in the
  // suggestion's mouth. Same 24h window, same ≥3 threshold.
  //
  // Separate query with the {error} READ (§3). §4 fail closed: it runs anchored
  // to the contact's own brokerage_id or not at all.
  let recentViewCount = 0
  if (contact.brokerage_id) {
    const { data: recentViewRows, error: recentViewsError } = await supabase
      .from("buyer_behavior_log")
      .select("id")
      .eq("contact_id", contactId)
      .eq("brokerage_id", contact.brokerage_id)
      .in("signal_type", [...VIEW_SIGNALS])
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    if (recentViewsError) {
      console.error("[assistant] buyer_behavior_log read failed — recent-views suggestion skipped:", recentViewsError.message)
    }
    recentViewCount = (recentViewRows ?? []).length
  }

  if (recentViewCount >= 3) {
    suggestions.push({
      type: "insight",
      priority: "high",
      icon: "🔥",
      title: "Hot lead alert!",
      description: `${contact.first_name} viewed ${recentViewCount} properties in last 24 hours`,
      action: "call_contact",
      action_params: { contact_id: contactId },
    })
  }

  // Check for missing info.
  //
  // THIS BRANCH HAS NEVER RUN. Both operands were phantom columns, not renames:
  // `contacts.stage` and `contacts.pre_approved` do not exist and never have. They
  // are property reads off an already-fetched row, so they evaluated to `undefined`
  // instead of throwing — `undefined === "searching"` is false, so the suggestion was
  // silently unreachable for the entire life of the file.
  //
  // Repointed to the real columns, and to values those columns actually take:
  //   • `contacts.buyer_stage` — NOT lifecycle_state. lifecycle_state is real but its
  //     vocabulary is the lead-funnel one (raw, unconsented, consented, isa_qualifying,
  //     assigned, appointment, representation, long_term_nurture); it has no
  //     "searching" value, so pointing here would have left the branch just as dead.
  //     buyer_stage carries BUYER_SEARCHING ("actively searching" —
  //     lib/buyer-lifecycle/lifecycle-definitions.ts), which is the state this
  //     pre-approval nudge is actually about.
  //   • `contacts.lender_status` — vocabulary ["cash","needs_pre_approval",
  //     "pre_approved","unknown"]. "Not pre-approved" is anything that is not already
  //     pre_approved or paying cash, which also covers the null/unknown case the
  //     suggestion's own copy ("Pre-approval status unknown") describes.
  if (
    contact.lender_status !== "pre_approved" &&
    contact.lender_status !== "cash" &&
    contact.buyer_stage === "BUYER_SEARCHING"
  ) {
    suggestions.push({
      type: "reminder",
      priority: "medium",
      icon: "📋",
      title: "Pre-approval status unknown",
      description: "Ask about pre-approval to qualify better",
      action: "update_contact",
      action_params: { contact_id: contactId, field: "pre_approved" },
    })
  }

  // AI-generated suggestion — skipped when one is already pending for this
  // contact (see generateAssistantSuggestions: the pending card IS the answer,
  // and a second model call would be a second charge for the same sentence).
  if (opts.skipAi) return suggestions
  try {
    const { text } = await generateText({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
      model: "openai/gpt-4o-mini",
      prompt: `Based on this contact data, suggest ONE specific action the agent should take:
- Name: ${contact.first_name} ${contact.last_name}
- Buyer Stage: ${contact.buyer_stage || "unknown"}
- Lifecycle: ${contact.lifecycle_state || "unknown"}
- Pre-approval: ${contact.lender_status || "unknown"}
- Lead Score: ${contact.lead_score || "unknown"}
- Timeline: ${contact.timeline || "unknown"}
- Last Contact: ${daysSinceContact} days ago
- Recent Activity: ${recentViewCount} property views in 24hrs

Suggest a specific, actionable next step in 1-2 sentences.`,
      temperature: 0.7,
      maxTokens: 400,
    })

    suggestions.push({
      type: "ai_suggestion",
      priority: "medium",
      icon: "💡",
      title: AI_RECOMMENDATION_TITLE,
      description: text,
      action: null,
    })
  } catch (error) {
    console.error("[v0] Error generating AI suggestion:", error)
  }

  return suggestions
}

async function getListingSuggestions(listingId: string): Promise<RuleSuggestion[]> {
  const supabase = await createServerClient()

  // Errors READ (§3) — these three reads discarded theirs, so a refused read
  // was "nothing to suggest". RLS-bound: a listing outside the caller's tenant
  // reads as absent here, which is the refusal we want.
  const { data: listing, error: listingError } = await supabase.from("listings").select("*").eq("id", listingId).maybeSingle()
  if (listingError) {
    console.error("[assistant] listing suggestions read failed:", listingError.message)
    return []
  }
  if (!listing) return []

  const suggestions: RuleSuggestion[] = []

  // Check days on market
  const daysOnMarket = listing.listing_date
    ? Math.floor((Date.now() - new Date(listing.listing_date).getTime()) / (1000 * 60 * 60 * 24))
    : 0

  if (daysOnMarket > 30 && listing.status === "active") {
    suggestions.push({
      type: "alert",
      priority: "high",
      icon: "⚠️",
      title: "30+ days on market",
      description: "Consider price adjustment or enhanced marketing",
      action: "review_pricing",
      action_params: { listing_id: listingId },
    })
  }

  // Check showing activity
  const { data: recentShowings, error: recentShowingsError } = await supabase
    .from("showings")
    .select("id")
    .eq("listing_id", listingId)
    .gte("scheduled_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
  if (recentShowingsError) {
    // A refused read is NOT "no showings" — that would raise the low-activity
    // nudge about a listing that may be busy. Skip this rule only.
    console.error("[assistant] showings read failed — low-activity rule skipped:", recentShowingsError.message)
  }

  if (!recentShowingsError && (!recentShowings || recentShowings.length === 0) && listing.status === "active") {
    suggestions.push({
      type: "action",
      priority: "medium",
      icon: "📸",
      title: "Low showing activity",
      description: "Refresh photos or create new video tour",
      action: "schedule_photos",
      action_params: { listing_id: listingId },
    })
  }

  // Check for missing feedback
  const { data: showingsNoFeedback, error: noFeedbackError } = await supabase
    .from("showings")
    .select("id")
    .eq("listing_id", listingId)
    .eq("status", "completed")
    .is("feedback", null)
  if (noFeedbackError) {
    console.error("[assistant] showings feedback read failed — feedback rule skipped:", noFeedbackError.message)
  }

  if (showingsNoFeedback && showingsNoFeedback.length > 0) {
    suggestions.push({
      type: "reminder",
      priority: "high",
      icon: "💬",
      title: `${showingsNoFeedback.length} showings without feedback`,
      description: "Collect feedback to improve showing results",
      action: "request_feedback",
      action_params: { showing_ids: showingsNoFeedback.map((s: any) => s.id) },
    })
  }

  return suggestions
}

async function getTransactionSuggestions(transactionId: string): Promise<RuleSuggestion[]> {
  const supabase = await createServerClient()

  const { data: transaction, error: transactionError } = await supabase.from("transactions").select("*").eq("id", transactionId).maybeSingle()
  if (transactionError) {
    console.error("[assistant] transaction suggestions read failed:", transactionError.message)
    return []
  }
  if (!transaction) return []

  const suggestions: RuleSuggestion[] = []

  // Check for overdue documents
  const { data: overdueDocuments, error: overdueError } = await supabase
    .from("document_requests")
    .select("id")
    .eq("transaction_id", transactionId)
    .eq("status", "pending")
    .lt("due_date", new Date().toISOString())
  if (overdueError) {
    console.error("[assistant] document_requests read failed — overdue rule skipped:", overdueError.message)
  }

  if (overdueDocuments && overdueDocuments.length > 0) {
    suggestions.push({
      type: "alert",
      priority: "critical",
      icon: "🚨",
      title: `${overdueDocuments.length} documents overdue`,
      description: "Follow up with client immediately",
      action: "send_document_reminder",
      action_params: { transaction_id: transactionId },
    })
  }

  // Check closing date proximity
  const daysToClose = transaction.estimated_close_date
    ? Math.floor((new Date(transaction.estimated_close_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : 999

  if (daysToClose <= 7 && daysToClose > 0) {
    suggestions.push({
      type: "reminder",
      priority: "high",
      icon: "📅",
      title: `Closing in ${daysToClose} days`,
      description: "Verify all contingencies removed and final walkthrough scheduled",
      action: "review_checklist",
      action_params: { transaction_id: transactionId },
    })
  }

  return suggestions
}

/** `agentId` is the SESSION's agents.id (getAgentContext), never a parameter
 *  of the public export — see generateAssistantSuggestions. */
async function getDashboardSuggestions(agentId: string): Promise<RuleSuggestion[]> {
  const supabase = await createServerClient()
  const suggestions: RuleSuggestion[] = []

  // Check for pending video approvals. HEAD-only counts: the rows were fetched
  // with `*` and only the count was read.
  const { count: videoCount, error: videoCountError } = await supabase
    .from("video_scripts_library")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agentId)
    .eq("approval_status", "pending_review")  // the column has no bare 'pending'
  if (videoCountError) {
    console.error("[assistant] video_scripts_library count refused — rule skipped:", videoCountError.message)
  }

  if (videoCount && videoCount > 0) {
    suggestions.push({
      type: "action",
      priority: "medium",
      icon: "🎥",
      title: `${videoCount} videos awaiting approval`,
      description: "Review and approve to send to clients",
      action: "review_videos",
      action_params: { agent_id: agentId },
    })
  }

  // Check for unapproved auto-tasks
  const { count: taskCount, error: taskCountError } = await supabase
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("assigned_to_agent_id", agentId)
    .eq("auto_generated", true)
    .eq("status", "pending")
  if (taskCountError) {
    console.error("[assistant] tasks count refused — rule skipped:", taskCountError.message)
  }

  if (taskCount && taskCount > 0) {
    suggestions.push({
      type: "action",
      priority: "medium",
      icon: "✅",
      title: `${taskCount} AI-suggested tasks to review`,
      description: "Approve or dismiss AI recommendations",
      action: "review_tasks",
      action_params: { agent_id: agentId },
    })
  }

  return suggestions
}

/**
 * The last 7 days of call coaching, as tips for /dashboard/coaching.
 *
 * TWO DEFECTS CLOSED HERE, and they compounded:
 *
 *  1. `call_coaching_insights` had no writer at all (census 1b — every column),
 *     so this read was always empty and the coaching card always said nothing.
 *     The writer now exists: lib/voice/call-coaching.ts, called the moment a
 *     call analysis completes on both analyser lanes.
 *
 *  2. Even with rows, this function could never have produced a tip. It scored
 *     `c.them_first_score` and `c.talk_listen_ratio` — NEITHER IS A COLUMN ON
 *     THIS TABLE. The live shape is agent_id / brokerage_id / call_analysis_id /
 *     content / created_at / dismissed / id / insight_type / priority
 *     (scripts/schema-snapshot.ts:171). `undefined || 0` made the them-first
 *     average exactly 0, which passed `< 0.6`, so the empathy tip was the one
 *     branch that would have fired — a hardcoded sentence dressed as a
 *     measurement — and `undefined || 0.5` made the talk-ratio average exactly
 *     0.5, which fails `> 0.6`, so the listening tip could never fire at all.
 *
 * The insight rows carry their own agent-facing sentence, type and priority, so
 * nothing needs re-deriving here: the tips ARE the undismissed insights.
 *
 * `agentId` is AGENTS-class — the caller states it at
 * app/dashboard/coaching/page.tsx:78 and the column FKs agents(id).
 */
export async function getCoachingTips(agentId: string) {
  const supabase = await createServerClient()

  // Only the columns that exist, and only insights the agent has not dismissed —
  // a dismissed insight reappearing as a "tip" is the same note twice.
  const { data: recentInsights, error } = await supabase
    .from("call_coaching_insights")
    .select("id, insight_type, priority, content, created_at")
    .eq("agent_id", agentId)
    .eq("dismissed", false)
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(5)

  // supabase-js RESOLVES a refused read, so without this an RLS refusal and a
  // genuinely quiet week are the same empty card. The card has no error surface,
  // so the refusal is logged rather than rendered as "nothing to improve".
  if (error) {
    console.error("[assistant] call coaching insights read refused:", error.message)
    return { tips: [] }
  }

  const tips = (recentInsights ?? []).map((i: any) => ({
    category: i.insight_type ?? "communication",
    priority: i.priority ?? "medium",
    tip: i.content as string,
    improvement_area: COACHING_AREA_LABEL[i.insight_type as string] ?? "Call performance",
  }))

  return { tips }
}

/** insight_type → the "improvement area" label the coaching card shows beside
 *  the tip. Keys are the live CHECK vocabulary (scripts/check-vocabularies.ts:386);
 *  an unlisted type falls back rather than rendering a raw enum at an agent. */
const COACHING_AREA_LABEL: Record<string, string> = {
  objection_handling: "Handling objections",
  improvement: "Conversation quality",
  rapport: "Rapport and empathy",
  closing: "Securing the next step",
  strength: "What is working",
}
