import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { isTenancyPrincipal, PRINCIPAL_ROLES } from "@/lib/kernel/tenancy-principal"
import { loadQuarterlyReview } from "@/lib/intelligence/quarterly-review-loader"
import {
  QBR_INVITATION_TYPE,
  composeQbrInvitation,
  isQbrInvitationWindow,
  pickHeadlineFacts,
  quarterStartIso,
  quarterTag,
} from "@/lib/intelligence/qbr-invitation"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * QBR INVITATIONS cron — the Quarterly Business Review was fully built but
 * PULL-ONLY: the principal had to know to visit the Command Center. This
 * sweep makes it push: early in the first month of each quarter, every
 * tenancy principal (tier-parity rule — broker/admin, the solo agent, the
 * team lead) who hasn't been invited THIS quarter gets one in-app
 * invitation naming 2–3 earned headline facts from the ONE QBR loader,
 * deep-linking to the Command Center QBR card.
 *
 * Idempotent per (principal, quarter): the notifications ledger itself is
 * the dedupe — a type='qbr_invitation' row for that user with created_at
 * inside the current quarter means done (the notifications table carries no
 * metadata column, so the quarter is keyed by the created_at window rather
 * than a metadata contains-check — same ledger, same guarantee, no new
 * table). Self-gates to UTC days 1–10 of Jan/Apr/Jul/Oct, so any schedule
 * from daily to quarter-precise no-ops cleanly outside the window (the
 * quarterly-tax-concierge idiom).
 *
 * Delivery mirrors board_packet_ready exactly (lib/kernel/board-packet.ts):
 * an in-app notifications insert per principal, priority medium, deep link
 * carried in the body — that row IS the bell/push rail this OS uses.
 *
 * NOT registered in lib/kernel/cron-dispatch.ts by this file's author —
 * suggested registration (dispatcher fields support lists, not ranges):
 *   { path: "/api/cron/qbr-invitations", schedule: "0 14 1,2,3,4,5,6,7 1,4,7,10 *" }
 */
export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "qbr-invitations",
    cron_path: "/app/api/cron/qbr-invitations/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const now = new Date()
  const quarter = quarterTag(now)

  try {
    // Outside the invitation window (first ~10 days of a quarter) — clean no-op.
    if (!isQbrInvitationWindow(now)) {
      await recordCronSuccessAction({
        context_id: contextId, records_processed: 0,
        metadata: { skipped: "outside_quarter_window", quarter },
      }).catch(() => {})
      return NextResponse.json({ ok: true, skipped: "outside_quarter_window", quarter })
    }

    const svc = createServiceClient()
    const sinceIso = quarterStartIso(now)
    const summary = { brokerages: 0, invited: 0, alreadyInvited: 0, errors: 0 }
    const errors: string[] = []

    const { data: brokerages, error: bErr } = await svc
      .from("brokerages").select("id").is("deleted_at", null).limit(2000)
    if (bErr) throw bErr

    for (const b of (brokerages ?? []) as Array<{ id: string }>) {
      summary.brokerages += 1
      try {
        // WHO GOVERNS THIS TENANCY — the one tier-parity rule, reused (never
        // re-derived): pre-check user_type against PRINCIPAL_ROLES, then
        // isTenancyPrincipal for the solo/team shapes (the exact
        // intelligence-report gate idiom).
        const { data: members } = await svc.from("users")
          .select("id, role, user_type").eq("brokerage_id", b.id).is("deleted_at", null).limit(25)

        // Dedupe against the notifications ledger: this quarter's invitations.
        const { data: sent } = await svc.from("notifications")
          .select("user_id").eq("brokerage_id", b.id)
          .eq("type", QBR_INVITATION_TYPE).gte("created_at", sinceIso).limit(100)
        const invitedIds = new Set(((sent ?? []) as Array<{ user_id: string | null }>).map((n) => n.user_id).filter(Boolean))

        const principals: string[] = []
        for (const u of (members ?? []) as Array<{ id: string; role: string | null; user_type: string | null }>) {
          if (invitedIds.has(u.id)) { summary.alreadyInvited += 1; continue }
          if (principals.length >= 5) break
          const isPrincipal =
            PRINCIPAL_ROLES.has(String(u.user_type ?? "")) ||
            (await isTenancyPrincipal(svc, { userId: u.id, brokerageId: b.id, role: String(u.role ?? "") }))
          if (isPrincipal) principals.push(u.id)
        }
        if (principals.length === 0) continue

        // Compose ONCE per brokerage from the ONE QBR loader — the same
        // numbers the Command Center card and the spoken verb read.
        const { review } = await loadQuarterlyReview(svc, b.id)
        const { title, body } = composeQbrInvitation({ facts: pickHeadlineFacts(review) })

        for (const userId of principals) {
          // Delivery mirrors board_packet_ready (lib/kernel/board-packet.ts):
          // in-app notifications row, deep link in the body.
          const { error: nErr } = await svc.from("notifications").insert({
            user_id: userId, brokerage_id: b.id, type: QBR_INVITATION_TYPE,
            title, body, priority: "medium", channel: "in_app", is_read: false,
          })
          if (nErr) { summary.errors += 1; errors.push(`${b.id}: ${nErr.message}`) }
          else summary.invited += 1
        }
      } catch (e: any) {
        summary.errors += 1
        errors.push(`${b.id}: ${e?.message ?? String(e)}`)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId, records_processed: summary.invited,
      metadata: { ...summary, quarter, errors: errors.slice(0, 10) } as any,
    }).catch(() => {})
    return NextResponse.json({ ok: true, quarter, ...summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "QBR invitation sweep failed"
    await recordCronFailureAction({ context_id: contextId, error: message }).catch(() => {})
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
