/**
 * lib/assistant/smart-suggestion.ts — THE smart_assistant_suggestions writer,
 * callable with no session (lane 86F, wave 86).
 *
 * THE DEFECT. Every local handler in lib/orchestrator/internal.ts (lead
 * created / tagged hot, listing appointment / signed / live, milestone overdue,
 * credit target, video + image generated) wrote its card through
 * app/actions/assistant.ts::generateSmartSuggestion — a "use server" export whose
 * first line built the COOKIE client. The orchestrator runs from
 * app/api/cron/poll-did-videos, app/api/internal/remotion/render-composition and
 * the image generators on a service credential with no cookie, so the agents
 * lookup came back empty under RLS and the function RETURNED — no card, no error.
 * "New Video Ready for Review" never reached an agent from the unattended render
 * path. Found by scripts/sessionless-use-server-census.ts (OPEN since 86E).
 *
 * THE SHAPE (LANE_RULES wave 86 — template lib/transactions/dotloop-document-sync.ts):
 * the body moved here UNCHANGED in what it writes; what changed is where the
 * tenant comes from and which client carries it:
 *   · the orchestrator passes the SERVICE client and the event row's brokerage_id
 *     (a lifecycle_events row this system wrote — emitEvent stamps the session's
 *     tenant, emitEventFromCron the caller's verified one);
 *   · the session door (assistant.ts generateAssistantSuggestions) passes its
 *     own RLS-bound client and the SESSION brokerage.
 * Either way the agents row is resolved INSIDE that tenant (agents.user_id +
 * brokerage_id — users.id and agents.id are disjoint, §3, never substituted) and
 * the insert carries brokerage_id.
 *
 * Server-only, never "use server" — this trusts the brokerageId it is handed.
 */
import "server-only"

/** smart_assistant_suggestions.priority — the live CHECK vocabulary
 *  (scripts/check-vocabularies.ts). "critical" is NOT a member; callers carrying
 *  it map to "high" (lib/intelligence/multi-agent-router.ts makes the same map). */
export type SuggestionPriority = "low" | "medium" | "high"

export interface SmartSuggestionInput {
  /** users.id of the agent the card is for — resolved to agents.id in the tenant. */
  userId: string | null | undefined
  contextType: string
  contextId: string | null | undefined
  suggestionType: string
  title: string
  description: string
  actionPayload: Record<string, unknown>
  /** Optional — the readers ORDER BY this column (app/actions/contact-details.ts,
   *  app/dashboard/coaching/page.tsx); unset sorts as NULL. */
  priority?: SuggestionPriority
}

export type SmartSuggestionResult =
  | { written: true; id: string | null }
  | { written: false; reason: string }

/**
 * Write one pending suggestion card. A refused insert THROWS (the session door's
 * callers count it); an unresolvable recipient is a REPORTED skip, never a
 * silent return — "nobody to show it to" is not "shown".
 */
export async function writeSmartSuggestion(
  client: any,
  brokerageId: string,
  input: SmartSuggestionInput,
): Promise<SmartSuggestionResult> {
  if (!brokerageId) return { written: false, reason: "no brokerageId — a suggestion is never written untenanted" }
  if (!input.userId) return { written: false, reason: "no recipient user on the event — no agent to show the card to" }

  const { data: agentRow, error: agentError } = await client
    .from("agents")
    .select("id")
    .eq("user_id", input.userId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  // A refused read is not "this user has no agent profile" (§3).
  if (agentError) throw new Error(`Suggestion recipient lookup refused: ${agentError.message}`)
  const agentId = (agentRow as { id?: string } | null)?.id ?? null
  if (!agentId) return { written: false, reason: `user ${input.userId} holds no agents row in brokerage ${brokerageId}` }

  // THE METADATA KEY (§6): `<context_type>_id` — contact_id / listing_id /
  // transaction_id / video_id / image_id — the spelling the one metadata reader
  // (app/actions/contact-details.ts, `metadata->>contact_id`) filters on.
  const { data: inserted, error } = await client
    .from("smart_assistant_suggestions")
    .insert({
      brokerage_id: brokerageId,
      // IDENTITY CLASS (m365): agents-class column, agents.id resolved above.
      agent_id: agentId,
      context_type: input.contextType,
      suggestion_type: input.suggestionType,
      title: input.title,
      description: input.description,
      action_payload_json: input.actionPayload,
      metadata: { [`${input.contextType}_id`]: input.contextId ?? null },
      status: "pending",
      ...(input.priority ? { priority: input.priority } : {}),
    })
    .select("id")
    .maybeSingle()
  if (error) throw new Error(`Suggestion insert refused: ${error.message}`)
  return { written: true, id: (inserted as { id?: string } | null)?.id ?? null }
}
