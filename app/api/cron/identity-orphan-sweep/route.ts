import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { reconcileOrphanedIdentities } from "@/lib/identity/orphan-reconciliation"

/**
 * IDENTITY ORPHAN SWEEP cron (daily — "0 5 * * *").
 *
 * The autonomous half of public.reconcile_orphaned_users() (m266). The
 * per-request path (lib/kernel/users.ts::mergeOrphan, invoked from
 * resolveEmailHolder on every invite/signup) only repoints a users-row/
 * auth.users collision it happens to see at invite time. A historical orphan
 * — seeded before m266, created outside the invite flow, or left behind by a
 * partial migration — never crosses that path and sat unrepointed forever,
 * because nothing else in the tree called the batch RPC that exists for
 * exactly this case (hidden-wire census (d), wave 57).
 *
 * SERVICE CLIENT, DELIBERATELY. reconcile_orphaned_users() is SECURITY
 * DEFINER and revoked from anon/authenticated (service_role only); a cron has
 * no session, so this cannot route through a session-gated "use server"
 * action.
 *
 * HONEST REPORTING. reconcileOrphanedIdentities destructures { data, error }
 * and separates a REFUSAL from a clean "found nothing" — a refused RPC call
 * is recorded as a cron failure, never silently swallowed into reconciled: 0.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "identity-orphan-sweep",
    cron_path: "/app/api/cron/identity-orphan-sweep/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  try {
    const result = await reconcileOrphanedIdentities(createServiceClient())

    if (result.outcome === "refused") {
      await recordCronFailureAction({
        context_id: contextId,
        error: new Error(`reconcile_orphaned_users() refused: ${result.error}`),
        stage: "reconcile-rpc",
      }).catch(() => {})
      return NextResponse.json({ ok: false, outcome: result.outcome, error: result.error }, { status: 500 })
    }

    await recordCronSuccessAction({
      context_id: contextId,
      metadata: { outcome: result.outcome, reconciled: result.reconciled, emails: result.detail.map((d) => d.email) },
    }).catch(() => {})

    if (result.reconciled > 0) {
      console.log(`[identity-orphan-sweep] reconciled ${result.reconciled} orphaned identity row(s)`)
    }

    return NextResponse.json({ ok: true, outcome: result.outcome, reconciled: result.reconciled, detail: result.detail })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 })
  }
}
