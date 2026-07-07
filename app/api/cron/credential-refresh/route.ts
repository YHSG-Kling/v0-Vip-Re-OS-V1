import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { runCredentialRefresh } from "@/lib/security/oauth-refresh"
import { runSocialTokenSweep } from "@/lib/social/token-refresh"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"

/**
 * Credential Refresh Cron — the automation the refresh runner was missing
 * (it was staff-button-only) + the vendor audit's worst gap (social tokens in
 * social_media_accounts were never scanned and silently expired):
 *   1. runCredentialRefresh — Google/Microsoft/QBO refresh-token exchange
 *      (provider-gated, encrypted-on-write).
 *   2. runSocialTokenSweep — Meta long-lived exchange + LinkedIn refresh +
 *      honest reconnect nudges for what can't be renewed automatically.
 */
export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "credential-refresh",
    cron_path: "/app/api/cron/credential-refresh/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const svc = createServiceClient()
    const creds = await runCredentialRefresh(svc as any)
    const social = await runSocialTokenSweep(svc)
    const summary = { credentials: { attempted: creds.attempted, refreshed: creds.refreshed, skipped: creds.skipped, failed: creds.failed }, social }
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: creds.refreshed + social.exchanged + social.refreshed,
      metadata: summary as any,
    })
    return NextResponse.json({ message: "Credential refresh sweep complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Refresh sweep failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
