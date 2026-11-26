/**
 * app/site/[slug]/events/[eventId]/page.tsx — AN EVENT'S REGISTRATION PAGE INSIDE THE TENANT WEBSITE (wave 149, lane 149F;
 * owner rulings 11 + 12: "the landing page is added to the tenant user's own website with the tenant's branding, routes and
 * domain"; C32: tenant-branded unless the platform's own event).
 *
 * THE VIEW IS THE ONE REGISTRATION VIEW (app/open-house/[eventId]/register/registration-view.tsx) — this route does not copy it.
 * It adds what the detached address lacked:
 *   1. TENANT PROOF — the site's brokerage is read by slug and handed to the view, which 404s an event that is not THIS site's
 *      tenant's (a storefront — and its connected custom domain — never serves another tenant's event);
 *   2. THE WEBSITE AROUND IT — the tenant's own name / logo / colour bar links back to the storefront, and the canonical URL is
 *      this in-website path, so search and AI search attribute the event to the tenant's site.
 * The registration POST stays the one public door (app/api/open-house/register — the event row decides the tenant).
 */
import Link from "next/link"
import { notFound } from "next/navigation"
import type { Metadata } from "next"
import { createServiceClient } from "@/lib/supabase/service"
import { siteUrl } from "@/lib/platform/site-url"
import { tenantWebsitePath } from "@/lib/kernel/tenant-creation"
import { EventRegistrationView } from "@/app/open-house/[eventId]/register/registration-view"

export const dynamic = "force-dynamic"

interface PageProps { params: Promise<{ slug: string; eventId: string }> }

async function loadSite(slug: string): Promise<{ id: string; slug: string; name: string; logoUrl: string | null; primaryColor: string | null } | null> {
  const { data, error } = await createServiceClient().from("brokerages")
    .select("id, slug, name, logo_url, primary_color, status").eq("slug", slug).is("deleted_at", null).maybeSingle()
  if (error) throw new Error("This website could not be loaded")
  const b = data as { id: string; slug: string; name: string | null; logo_url: string | null; primary_color: string | null; status: string | null } | null
  if (!b || b.status === "archived") return null
  return { id: b.id, slug: b.slug, name: (b.name ?? "").trim(), logoUrl: b.logo_url, primaryColor: b.primary_color }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug, eventId } = await params
  const site = await loadSite(slug)
  if (!site) return { title: "Not Found", robots: { index: false, follow: false } }
  return { title: site.name ? `Register — ${site.name}` : "Register", alternates: { canonical: `${siteUrl()}${tenantWebsitePath(site.slug)}/events/${eventId}` } }
}

export default async function TenantEventRegistrationPage({ params }: PageProps) {
  const { slug, eventId } = await params
  const site = await loadSite(slug)
  if (!site) notFound()
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
      <EventRegistrationView eventId={eventId} siteBrokerageId={site.id} />
    </>
  )
}
