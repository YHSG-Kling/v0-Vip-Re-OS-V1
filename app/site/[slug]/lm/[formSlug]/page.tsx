/**
 * app/site/[slug]/lm/[formSlug]/page.tsx — A LANDING PAGE INSIDE THE TENANT WEBSITE (wave 143, lane 143G).
 *
 * Owner: "landing pages live inside the tenant website created automatically when the tenant subscribes."
 *
 * The page IS the lead-magnet survivor (app/lm/[slug]/page.tsx — AI landing copy, GEO FAQ, the ONE video slot,
 * consent-bearing capture, draft preview for a proven member). This route does NOT copy it. It adds the two things
 * the detached host lacked:
 *   1. TENANT PROOF — the form is read with THIS site's brokerage in the predicate
 *      (lib/tenant-site/landing-page.ts resolveTenantLandingForm). Another tenant's form is a 404 here, so a tenant's
 *      storefront (and its connected custom domain) can never serve someone else's landing page.
 *   2. THE WEBSITE AROUND IT — the tenant's own name/logo/colour bar links back to the storefront, and the page's
 *      canonical URL is the in-website path, so search and AI search attribute the page to the tenant's site.
 *
 * On a connected custom domain proxy.ts rewrites /lm/<formSlug> to this route, so https://theirdomain.com/lm/<slug>
 * is served from here. The bare platform-origin /lm/<slug> still resolves (printed QR codes, sent emails, live ads).
 */
import Link from "next/link"
import { notFound } from "next/navigation"
import type { Metadata } from "next"
import { createServiceClient } from "@/lib/supabase/service"
import { siteUrl } from "@/lib/platform/site-url"
import { tenantLandingPagePath, tenantWebsitePath } from "@/lib/kernel/tenant-creation"
import { resolveTenantLandingForm } from "@/lib/tenant-site/landing-page"
import LeadMagnetLandingPage, { generateMetadata as leadMagnetMetadata } from "@/app/lm/[slug]/page"

type SearchParams = Record<string, string | string[] | undefined>

interface PageProps {
  params: Promise<{ slug: string; formSlug: string }>
  searchParams?: Promise<SearchParams>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug, formSlug } = await params
  const resolved = await resolveTenantLandingForm(createServiceClient(), slug, formSlug)
  if (!resolved.ok) return { title: "Not Found", robots: { index: false, follow: false } }
  const base = await leadMagnetMetadata({ params: Promise.resolve({ slug: formSlug }) })
  return { ...base, alternates: { canonical: `${siteUrl()}${tenantLandingPagePath(resolved.site.slug, formSlug)}` } }
}

export default async function TenantLandingPage({ params, searchParams }: PageProps) {
  const { slug, formSlug } = await params
  const resolved = await resolveTenantLandingForm(createServiceClient(), slug, formSlug)
  if (!resolved.ok) notFound()
  const { site } = resolved
  const primary = /^#[0-9a-fA-F]{6}$/.test(site.primaryColor ?? "") ? (site.primaryColor as string) : "#0F172A"
  return (
    <>
      <nav style={{ backgroundColor: primary }} className="text-white" aria-label={`${site.name} website`}>
        <div className="container mx-auto flex items-center gap-3 px-6 py-3">
          {site.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={site.logoUrl} alt="" className="h-7 object-contain" />
          )}
          <Link href={tenantWebsitePath(site.slug)} className="text-sm font-semibold hover:underline">{site.name}</Link>
        </div>
      </nav>
      {await LeadMagnetLandingPage({ params: Promise.resolve({ slug: formSlug }), searchParams })}
    </>
  )
}
