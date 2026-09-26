import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { comparePlanPriceToStripe, type PlanDriftFinding } from "@/lib/billing/plan-catalog"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"

/**
 * STRIPE PLAN-CATALOG DRIFT CRON — weekly.
 *
 * The plan catalog (subscription_tiers) is the pricing source of truth and
 * Stripe MIRRORS it (publishTierToStripeAction). Until now the only drift
 * check was a human pressing "Sync" in the plans console. This cron walks
 * every ACTIVE tier that carries a stripe_price_id, retrieves the live price,
 * and compares via the SAME interval rule the manual sync uses
 * (comparePlanPriceToStripe — keep-one in lib/billing/plan-catalog.ts).
 *
 * Honest mechanics:
 *   • No Stripe key → recorded as success with skipped=true (nothing faked).
 *   • Nothing is auto-fixed — pricing decisions stay human. On drift the cron
 *     writes ONE notifications row per superadmin pointing at the plans
 *     console, deduped per day per tier via the notification entity.
 *   • Result always lands in the cron ledger (cron-kernel actions).
 *
 * REGISTRATION (deliberately NOT wired here): add to lib/kernel/cron-dispatch.ts
 *   { path: "/api/cron/stripe-drift", schedule: "0 9 * * 1" }   // Mondays 09:00 UTC
 */
export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "stripe-drift",
    cron_path: "/app/api/cron/stripe-drift/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const svc = createServiceClient()

    if (!process.env.STRIPE_SECRET_KEY) {
      await recordCronSuccessAction({
        context_id: contextId, records_processed: 0,
        metadata: { skipped: true, reason: "STRIPE_SECRET_KEY not configured" },
      })
      return NextResponse.json({ message: "Skipped — Stripe not configured", skipped: true })
    }

    const { data: tiers, error } = await svc
      .from("subscription_tiers")
      .select("id, tier_name, display_name, monthly_price_cents, annual_price_cents, stripe_price_id")
      .eq("is_active", true)
      .not("stripe_price_id", "is", null)
    if (error) throw new Error(`Failed to load tier catalog: ${error.message}`)

    // "checked 0, drifted 0" IS NOT A CLEAN BILL — it is a check that could not
    // see anything (CLAUDE.md §2). The filter above skips every tier whose
    // stripe_price_id is NULL, and MEASURED LIVE that is all four of them, so
    // once a key is present this cron would report a healthy catalogue while
    // comparing nothing at all. An UNLINKED catalogue is the finding, not the
    // absence of one: no tier can be repriced (stripeSwapPrice skips on a NULL
    // price id) and no drift can ever be detected. Reported with its denominator.
    const { count: activeTierCount } = await svc
      .from("subscription_tiers")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
    const linked = (tiers ?? []).length
    const unlinked = Math.max(0, (activeTierCount ?? 0) - linked)
    if (linked === 0) {
      const reason = `Stripe is configured but NO active tier carries a stripe_price_id (0 of ${activeTierCount ?? 0} linked) — nothing could be compared, and no tier can be repriced. Publish each tier from /dashboard/superadmin/plans.`
      await recordCronSuccessAction({
        context_id: contextId, records_processed: 0,
        metadata: { checked: 0, drifted: 0, notified: 0, unlinkedTiers: unlinked, catalogUnlinked: true, reason },
      })
      return NextResponse.json({
        message: "Nothing to check — the plan catalog is not linked to Stripe",
        checked: 0, drifted: 0, notified: 0, unlinkedTiers: unlinked, catalogUnlinked: true, reason,
      })
    }

    const { stripe } = await import("@/lib/stripe")
    const drifts: Array<{ tierName: string; priceId: string; finding: PlanDriftFinding | null; error?: string }> = []
    let checked = 0

    for (const t of (tiers ?? []) as Array<{
      id: string; tier_name: string; display_name: string | null
      monthly_price_cents: number | null; annual_price_cents: number | null; stripe_price_id: string
    }>) {
      checked += 1
      try {
        const price = await stripe.prices.retrieve(t.stripe_price_id)
        const finding = comparePlanPriceToStripe(t, {
          unitAmount: price.unit_amount,
          interval: price.recurring?.interval ?? null,
          active: price.active,
        })
        if (finding.drifted) drifts.push({ tierName: t.tier_name, priceId: t.stripe_price_id, finding })
      } catch (err) {
        // A vanished/invalid price IS drift — the published tier points nowhere.
        drifts.push({
          tierName: t.tier_name, priceId: t.stripe_price_id, finding: null,
          error: err instanceof Error ? err.message : "price retrieve failed",
        })
      }
    }

    let notified = 0
    if (drifts.length > 0) {
      const { data: staff } = await svc
        .from("users")
        .select("id, brokerage_id")
        .or("user_type.eq.superadmin,platform_role.eq.superadmin")
        .limit(20)
      const detail = drifts
        .map((d) => d.finding
          ? `${d.tierName}: DB $${(d.finding.dbCents / 100).toFixed(2)} vs Stripe ${d.finding.stripeCents == null ? "—" : `$${(d.finding.stripeCents / 100).toFixed(2)}`} (${d.finding.reason})`
          : `${d.tierName}: price ${d.priceId} unreadable (${d.error})`)
        .join("; ")
      for (const u of (staff ?? []) as Array<{ id: string; brokerage_id: string | null }>) {
        const { error: notifErr } = await svc.from("notifications").insert({
          user_id: u.id,
          brokerage_id: u.brokerage_id,
          type: "stripe_plan_drift",
          title: `Plan catalog drifted from Stripe — ${drifts.length} tier${drifts.length === 1 ? "" : "s"}`,
          body: `${detail}. Review in the plans console (Sync from Stripe or Publish to Stripe decides which side wins).`.slice(0, 480),
          entity_type: "subscription_tier",
          entity_id: contextId,
          priority: "high",
          channel: "in_app",
        })
        if (!notifErr) notified += 1
      }
    }

    // `unlinkedTiers` travels with every result: a partially-linked catalogue is
    // a partially-blind check, and the count is what makes the zero readable.
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: checked,
      metadata: { checked, drifted: drifts.length, notified, unlinkedTiers: unlinked, drifts },
    })
    return NextResponse.json({ message: "Stripe drift check complete", checked, drifted: drifts.length, notified, unlinkedTiers: unlinked })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Stripe drift check failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
