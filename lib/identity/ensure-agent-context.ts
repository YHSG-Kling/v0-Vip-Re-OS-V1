import { getAgentContext } from "@/lib/identity/get-agent-context"
import { ensureAgentBrokerage } from "@/app/actions/onboarding/ensure-agent-brokerage"

/**
 * Resolve the agent context, self-healing an incomplete (brokerage-less /
 * agent-record-less) account IN PLACE instead of bouncing to /dashboard.
 *
 * The whole OS gates on brokerage_id + an agents row. A signed-in agent who lands
 * on a WORK page without them shouldn't be yanked off that page to the dashboard
 * (losing their place) — we provision the records right here and re-resolve so the
 * page just renders its real content. Only an account that genuinely can't
 * self-provision (a pending brokerage invite, or a non-agent user type whose
 * brokerage comes from their org) returns still-incomplete, and the caller shows an
 * honest in-place notice rather than a redirect.
 *
 * Idempotent + cheap: ensureAgentBrokerage is a no-op for an already-anchored user,
 * so this only does work on the first incomplete load.
 */
export async function ensureAgentContextInPlace(): Promise<Awaited<ReturnType<typeof getAgentContext>>> {
  let ctx = await getAgentContext()
  if (ctx.isAuthenticated && (!ctx.brokerageId || !ctx.agentId)) {
    await ensureAgentBrokerage()
    ctx = await getAgentContext()
  }
  return ctx
}
