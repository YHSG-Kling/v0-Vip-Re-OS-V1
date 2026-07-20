import Link from "next/link"
import type { Metadata } from "next"
import { CheckCircle2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { createServiceClient } from "@/lib/supabase/service"
import { loadPublicTiers, formatTierPrice } from "@/lib/platform/public-tiers"
import { loadProductBrand } from "@/lib/platform/product-brand"
import { serializeJsonLd } from "@/lib/geo/video-landing"
import { siteUrl } from "@/lib/platform/site-url"
import { redirect } from "next/navigation"
import { refCaptureRedirect } from "@/lib/platform/affiliate-ref-capture"
import { loadTerritoryMarketplace, cleanCarriedZip } from "@/lib/platform/territory-marketplace"
import { TerritoryAvailability } from "./territory-availability"

export const dynamic = "force-dynamic"

// Public pricing — server-rendered from subscription_tiers, the SAME DB-driven
// plans /signup provisions from (loadPublicTiers, keep-one). Brand-driven copy
// (the product name is a platform setting, never hardcoded) + Product/Offer
// JSON-LD so search + AI answer engines can cite real plans and real prices.
export async function generateMetadata(): Promise<Metadata> {
  const brand = await loadProductBrand(createServiceClient())
  return {
    title: `Pricing — ${brand.name}`,
    description: `Plans and pricing for ${brand.name}: ${brand.tagline}. 14-day free trial, no credit card required.`,
  }
}

export default async function PricingPage({ searchParams }: { searchParams: Promise<{ ref?: string; zip?: string }> }) {
  // AFFILIATE ?ref CAPTURE — a server component cannot set cookies, so bounce
  // once through /api/ref (the one cookie-setter; 90-day AFFILIATE_REF_COOKIE)
  // and land back here without the ref param (no loop). A territory search
  // (?zip=) in flight is preserved through the bounce.
  const params = await searchParams
  if (params.ref) {
    const zipQs = cleanCarriedZip(params.zip)
    const capture = refCaptureRedirect(params.ref, `/pricing${zipQs ? `?zip=${zipQs}` : ""}`)
    if (capture) redirect(capture)
  }

  const svc = createServiceClient()
  // TERRITORY MARKETPLACE (round 40, rec 4): the anonymized unclaimed-territory
  // snapshot — real platform lead volume in zips no active subscriber claims,
  // never tenant identities, never a claimed zip's numbers. ?zip= is the
  // visitor's territory search (plain GET form — the page is force-dynamic).
  const [brand, tiers, marketplace] = await Promise.all([
    loadProductBrand(svc),
    loadPublicTiers(svc),
    loadTerritoryMarketplace(svc),
  ])
  const searchedZip = typeof params.zip === "string" && params.zip.trim() ? params.zip.trim().slice(0, 20) : null
  const base = siteUrl()

  // GEO: Product + per-tier Offer markup mirroring the public-site JSON-LD rail.
  const productJsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: brand.name,
    description: brand.voicePitch,
    brand: { "@type": "Organization", name: brand.name },
    ...(base ? { url: `${base}/pricing` } : {}),
    offers: tiers
      .filter((t) => t.monthlyCents > 0)
      .map((t) => ({
        "@type": "Offer",
        name: t.displayName,
        ...(t.description ? { description: t.description } : {}),
        price: (t.monthlyCents / 100).toFixed(2),
        priceCurrency: "USD",
        ...(base ? { url: `${base}/signup?tier=${encodeURIComponent(t.tierName)}` } : {}),
        availability: "https://schema.org/InStock",
      })),
  }

  // GEO: honest ItemList of available (UNCLAIMED) territories — same
  // serializeJsonLd idiom as the Product/Offer block above. Only rendered when
  // real teaser rows exist; each item states exactly what the section states.
  const territoryJsonLd =
    marketplace.snapshot && marketplace.snapshot.teaser.length > 0
      ? {
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: `Available territories on ${brand.name}`,
          description: `Unclaimed zip codes with real platform-surfaced lead volume in ${marketplace.snapshot.periodLabel} — no active subscriber serves them yet.`,
          itemListElement: marketplace.snapshot.teaser.map((z, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: `${z.zip}${z.city ? ` (${z.city}${z.state ? `, ${z.state}` : ""})` : z.state ? ` (${z.state})` : ""} — ${z.leadCount}${marketplace.snapshot!.countsAreFloors ? "+" : ""} leads in ${z.periodLabel}, unclaimed`,
            ...(base ? { url: `${base}/signup?zip=${z.zip}` } : {}),
          })),
        }
      : null

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(productJsonLd) }} />
      {territoryJsonLd && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(territoryJsonLd) }} />
      )}
      <div className="max-w-5xl mx-auto px-6 py-14">
        <div className="text-center mb-10">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">Pricing</h1>
          <p className="text-muted-foreground mt-3 max-w-2xl mx-auto">
            {brand.name} — {brand.tagline}. Every plan starts with a 14-day free trial, no credit card required.
            Change tiers any time; your price is set by the plan, not by add-ons.
          </p>
        </div>

        {tiers.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">
            Plans are being finalized — <Link href="/get-started" className="underline underline-offset-2">raise your hand</Link> and
            we&apos;ll reach out the moment they&apos;re live.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {tiers.map((t) => (
              <Card key={t.tierName} className={`relative flex flex-col ${t.featured ? "ring-2 ring-primary border-primary" : ""}`}>
                {t.featured && <Badge className="absolute -top-2 right-3 bg-amber-100 text-amber-800">Most popular</Badge>}
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t.displayName}</CardTitle>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold">{formatTierPrice(t.monthlyCents)}</span>
                    <span className="text-xs text-muted-foreground">/ month</span>
                  </div>
                  {t.annualCents > 0 && (
                    <p className="text-[11px] text-muted-foreground">{formatTierPrice(t.annualCents)} / year billed annually</p>
                  )}
                  {t.setupCents > 0 && (
                    <p className="text-[11px] text-muted-foreground">+ {formatTierPrice(t.setupCents)} one-time setup</p>
                  )}
                  {t.description ? <CardDescription className="text-xs mt-1">{t.description}</CardDescription> : null}
                </CardHeader>
                <CardContent className="flex flex-1 flex-col">
                  <ul className="text-xs space-y-1.5 flex-1">
                    {t.bullets.map((f) => (
                      <li key={f} className="flex items-start gap-1.5">
                        <CheckCircle2 className="h-3 w-3 text-primary mt-0.5 shrink-0" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  <Button asChild className="mt-4 w-full" variant={t.featured ? "default" : "outline"}>
                    <Link href={`/signup?tier=${encodeURIComponent(t.tierName)}`}>Start free trial</Link>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* TERRITORY MARKETPLACE — anonymized unclaimed-territory availability
            (beneath the tiers; the CTA carries the zip into /signup?zip=). */}
        <TerritoryAvailability
          snapshot={marketplace.snapshot}
          error={marketplace.error}
          searchedZip={searchedZip}
        />

        <div className="mt-12 text-center space-y-2">
          <p className="text-sm text-muted-foreground">
            Not sure which shape fits? See the AI team on a real deal first.
          </p>
          <div className="flex justify-center gap-3">
            <Button asChild variant="outline">
              <Link href="/demo">Book a 15-min demo</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/get-started">Or just raise your hand</Link>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            How we protect your data: <Link href="/trust" className="underline underline-offset-2">Trust &amp; Security</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
