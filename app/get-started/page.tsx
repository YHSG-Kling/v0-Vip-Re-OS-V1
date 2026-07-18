import Link from "next/link"
import { GetStartedForm } from "./get-started-form"
import { createServiceClient } from "@/lib/supabase/service"
import { loadProductBrand } from "@/lib/platform/product-brand"

export const dynamic = "force-dynamic"
export const metadata = { title: "See the AI team — get started" }

// Public marketing front door — BRAND-DRIVEN (the product name lives in platform
// settings) and UTM-attributed: posts/reels link here with utm_source/utm_campaign,
// which we fold into the prospect's source so the funnel shows which channel × angle
// actually converts.
export default async function GetStartedPage({ searchParams }: { searchParams: Promise<{ utm_source?: string; utm_campaign?: string }> }) {
  const params = await searchParams
  const brand = await loadProductBrand(createServiceClient())
  const source = params.utm_source
    ? `utm:${params.utm_source}${params.utm_campaign ? `:${params.utm_campaign}` : ""}`.slice(0, 80)
    : "get_started"

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="max-w-2xl mx-auto px-6 py-14">
        <div className="flex justify-end gap-4 text-sm text-muted-foreground mb-4">
          <Link href="/pricing" className="underline underline-offset-2 hover:text-foreground">Pricing</Link>
          <Link href="/demo" className="underline underline-offset-2 hover:text-foreground">Book a 15-min demo</Link>
        </div>
        <div className="text-center mb-8">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">{brand.tagline}</h1>
          <p className="text-muted-foreground mt-3">
            Not another dashboard — {brand.name} is an accountable AI team of managers that scrape leads,
            coordinate deals, market (video + social + ads), recruit and retain agents, manage vendors, and
            report — from one command center, with a voice admin that takes a command and does it.
            Lead → deal → lifetime client.
          </p>
        </div>
        <GetStartedForm source={source} />
      </div>
    </div>
  )
}
