// lib/kernel/second-opinion-runner.ts
//
// Live side of CROSS-MANAGER SECOND OPINION — for a strategic play, ask the complementary manager
// to weigh in via the inter-manager bus. Idempotent per (contact, play). Never throws. The consulted
// manager's response comes back as its own signal (handled by its inbox), so the huddle is visible
// on the coordination feed.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { secondOpinionFor } from "./second-opinion"

type Svc = ReturnType<typeof createServiceClient>

export async function requestSecondOpinion(
  input: { brokerageId: string; fromManager: string; playType: string; contactId?: string | null; entityType?: string; entityId?: string | null; context?: string },
  client?: Svc,
): Promise<{ requested: boolean; consult: string | null }> {
  const svc = client ?? createServiceClient()
  const verdict = secondOpinionFor(input.playType)
  if (!verdict.needed || !verdict.consult) return { requested: false, consult: null }

  // Idempotent: don't re-ask the same manager about the same contact+play recently.
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
  if (input.contactId) {
    const { data: prior } = await svc
      .from("manager_signals")
      .select("id")
      .eq("brokerage_id", input.brokerageId)
      .eq("signal_type", "second_opinion_requested")
      .eq("to_manager", verdict.consult)
      .eq("contact_id", input.contactId)
      .gte("created_at", since)
      .ilike("message", `%${input.playType}%`)
      .limit(1)
      .maybeSingle()
    if (prior) return { requested: false, consult: verdict.consult }
  }

  try {
    const { publishManagerSignal } = await import("./manager-signals")
    const r = await publishManagerSignal({
      brokerageId: input.brokerageId,
      fromManager: input.fromManager as any,
      toManager: verdict.consult as any,
      signalType: "second_opinion_requested",
      message: `Before the ${input.playType} play: ${verdict.reason}.${input.context ? ` Context: ${input.context}` : ""}`,
      entityType: input.entityType ?? (input.contactId ? "contact" : "brokerage"),
      entityId: input.entityId ?? input.contactId ?? input.brokerageId,
      contactId: input.contactId ?? null,
      payload: { playType: input.playType, requestedBy: input.fromManager },
    }, svc)
    return { requested: !!(r as any).ok, consult: verdict.consult }
  } catch {
    return { requested: false, consult: verdict.consult }
  }
}
