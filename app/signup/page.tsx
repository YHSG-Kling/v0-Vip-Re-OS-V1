import Link from "next/link"
import { SignupForm } from "./signup-form"
import { createServiceClient } from "@/lib/supabase/service"
import { loadPublicTiers } from "@/lib/platform/public-tiers"
import { cleanCarriedZip } from "@/lib/platform/territory-marketplace"

export const dynamic = "force-dynamic"
export const metadata = { title: "Start your free trial — VIP RE OS" }

// Prices are the SINGLE SOURCE OF TRUTH in subscription_tiers (loadPublicTiers —
// the same loader /pricing renders from) — never hardcoded, so a production price
// change is a DB update, not a code change. /pricing?→/signup?tier=X preselects.
export default async function SignupPage({ searchParams }: { searchParams: Promise<{ tier?: string; zip?: string }> }) {
  const params = await searchParams
  const svc = createServiceClient()
  const tiers = await loadPublicTiers(svc)
  const initialTier = tiers.some((t) => t.tierName === params.tier) ? params.tier! : null
  // TERRITORY MARKETPLACE carry (round 40, rec 4): /pricing's territory CTA
  // hands off with ?zip= — a validated 5-digit zip rides through signup as a
  // SUGGESTED first market for onboarding. Never auto-claimed, never required.
  const initialZip = cleanCarriedZip(params.zip)

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="max-w-5xl mx-auto px-6 py-12">
        <div className="flex justify-end gap-4 text-sm text-muted-foreground mb-4">
          <Link href="/pricing" className="underline underline-offset-2 hover:text-foreground">See full pricing</Link>
          <Link href="/demo" className="underline underline-offset-2 hover:text-foreground">Book a 15-min demo</Link>
        </div>
        <div className="text-center mb-10">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
            Start your 14-day free trial
          </h1>
          <p className="text-muted-foreground mt-3 max-w-2xl mx-auto">
            No credit card required. Pick the plan that fits your shape — you can change it any time.
            AI features, marketing automation, and the kernel-driven workflow OS are all included.
          </p>
        </div>
        <SignupForm tiers={tiers} initialTier={initialTier} initialZip={initialZip} />
      </div>
    </div>
  )
}
