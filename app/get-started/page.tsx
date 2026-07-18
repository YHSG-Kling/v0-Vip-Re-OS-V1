import Link from "next/link"
import { GetStartedForm } from "./get-started-form"
import { TrialFunnelForm, type FunnelSnapshotMap } from "./trial-funnel-form"
import { createServiceClient } from "@/lib/supabase/service"
import { loadProductBrand } from "@/lib/platform/product-brand"
import { loadPublicTiers } from "@/lib/platform/public-tiers"
import { liveFunnelSnapshots } from "@/lib/platform/trial-funnel"

export const dynamic = "force-dynamic"
export const metadata = { title: "Start your free trial — get started" }

// Public SELF-SERVE TRIAL FUNNEL — brand-driven and UTM-attributed. A prospect
// picks a tier (DB-driven pricing — the same subscription_tiers rows /pricing
// renders), optionally applies a coupon (validated live, redeemed at signup,
// honored at checkout), and signs up with zero human touch: provisioning applies
// the tier's LIVE funnel snapshot (newest snapshot recommending that tier) so
// the day-one website comes up branded. No snapshots / no coupons configured ⇒
// the page still works as a plain signup. The prospect-capture form stays below
// for people who want a walkthrough before starting a trial.
export default async function GetStartedPage({ searchParams }: { searchParams: Promise<{ utm_source?: string; utm_campaign?: string; tier?: string }> }) {
  const params = await searchParams
  const svc = createServiceClient()
  const [brand, tiers, snapshotsByTier] = await Promise.all([
    loadProductBrand(svc),
    loadPublicTiers(svc),
    liveFunnelSnapshots(svc),
  ])
  // Only id + name cross to the client — snapshot payloads never ship to a public page.
  const funnelSnapshots: FunnelSnapshotMap = Object.fromEntries(
    Object.entries(snapshotsByTier).map(([tier, s]) => [tier, { id: s.id, name: s.name }]),
  )
  const initialTier = tiers.some((t) => t.tierName === params.tier) ? params.tier! : null
  const source = params.utm_source
    ? `utm:${params.utm_source}${params.utm_campaign ? `:${params.utm_campaign}` : ""}`.slice(0, 80)
    : "get_started"

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="max-w-5xl mx-auto px-6 py-14">
        <div className="flex justify-end gap-4 text-sm text-muted-foreground mb-4">
          <Link href="/pricing" className="underline underline-offset-2 hover:text-foreground">Pricing</Link>
          <Link href="/demo" className="underline underline-offset-2 hover:text-foreground">Book a 15-min demo</Link>
        </div>
        <div className="text-center mb-8">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">{brand.tagline}</h1>
          <p className="text-muted-foreground mt-3 max-w-2xl mx-auto">
            Not another dashboard — {brand.name} is an accountable AI team of managers that scrape leads,
            coordinate deals, market (video + social + ads), recruit and retain agents, manage vendors, and
            report — from one command center, with a voice admin that takes a command and does it.
            Lead → deal → lifetime client. Start a 14-day free trial below — no credit card required.
          </p>
        </div>

        <TrialFunnelForm tiers={tiers} funnelSnapshots={funnelSnapshots} initialTier={initialTier} />

        <div className="mt-14 border-t pt-10 max-w-2xl mx-auto">
          <div className="text-center mb-4">
            <h2 className="text-lg font-semibold">Want a walkthrough first?</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Leave your details and we&apos;ll show you the AI team handing a real deal between managers, live.
            </p>
          </div>
          <GetStartedForm source={source} />
        </div>
      </div>
    </div>
  )
}
