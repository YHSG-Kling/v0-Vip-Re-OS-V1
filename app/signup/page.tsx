import { SignupForm } from "./signup-form"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"
export const metadata = { title: "Start your free trial — VIP RE OS" }

// Prices are the SINGLE SOURCE OF TRUTH in subscription_tiers — never hardcoded, so
// a production price change is a DB update, not a code change.
export default async function SignupPage() {
  const svc = createServiceClient()
  const { data } = await svc
    .from("subscription_tiers")
    .select("tier_name, display_name, description, marketing_bullets, is_featured, monthly_price_cents, annual_price_cents, setup_fee_cents")
    .eq("is_active", true)
    .order("monthly_price_cents", { ascending: true })
  // Everything the signup card shows — name, blurb, bullets, highlight, price — comes
  // from subscription_tiers. Nothing is hardcoded, so a production change is DB-only.
  const tiers = ((data ?? []) as any[]).map((t) => ({
    tierName: t.tier_name as string,
    displayName: (t.display_name as string) ?? t.tier_name,
    description: (t.description as string) ?? "",
    bullets: Array.isArray(t.marketing_bullets) ? (t.marketing_bullets as string[]) : [],
    featured: !!t.is_featured,
    monthlyCents: t.monthly_price_cents ?? 0,
    annualCents: t.annual_price_cents ?? 0,
    setupCents: t.setup_fee_cents ?? 0,
  }))

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="max-w-5xl mx-auto px-6 py-12">
        <div className="text-center mb-10">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
            Start your 14-day free trial
          </h1>
          <p className="text-muted-foreground mt-3 max-w-2xl mx-auto">
            No credit card required. Pick the plan that fits your shape — you can change it any time.
            AI features, marketing automation, and the kernel-driven workflow OS are all included.
          </p>
        </div>
        <SignupForm tiers={tiers} />
      </div>
    </div>
  )
}
