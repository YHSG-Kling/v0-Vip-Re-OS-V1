import Link from "next/link"
import type { Metadata } from "next"
import { DemoRequestForm } from "./demo-request-form"
import { createServiceClient } from "@/lib/supabase/service"
import { loadProductBrand } from "@/lib/platform/product-brand"

export const dynamic = "force-dynamic"

// Public demo booking — the real surface behind the growth pitch's "15-minute
// demo" offer. HONEST flow: the form captures the request into the platform
// growth funnel (source 'demo_request') and a human follows up to schedule —
// there is no fake calendar. Brand-driven (the product name is a setting).
export async function generateMetadata(): Promise<Metadata> {
  const brand = await loadProductBrand(createServiceClient())
  return {
    title: `Book a 15-minute demo — ${brand.name}`,
    description: `See the ${brand.name} AI team work a real deal end to end, live. Tell us when works and a real person will confirm a time.`,
  }
}

export default async function DemoPage() {
  const brand = await loadProductBrand(createServiceClient())
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="max-w-2xl mx-auto px-6 py-14">
        <div className="flex justify-end gap-4 text-sm text-muted-foreground mb-4">
          <Link href="/pricing" className="underline underline-offset-2 hover:text-foreground">Pricing</Link>
          <Link href="/get-started" className="underline underline-offset-2 hover:text-foreground">Start free trial</Link>
        </div>
        <div className="text-center mb-8">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">Book a 15-minute demo</h1>
          <p className="text-muted-foreground mt-3">
            A live look at the {brand.name} AI team handing a real deal between managers — no slides.
            Tell us a few times that work for you; a real person on our team will reply to confirm one.
            No auto-scheduler, no credit card, no obligation.
          </p>
        </div>
        <DemoRequestForm />
      </div>
    </div>
  )
}
