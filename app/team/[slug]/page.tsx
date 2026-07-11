/**
 * app/team/[slug]/page.tsx — THE TEAM WEBSITE (tier-audit closure: the
 * brokerage got /site/[slug], agents have /p/[agentSlug] — TEAMS, the
 * middle tier, had no public presence at all). Same contract as the
 * brokerage site: served on the platform origin, zero team hosting/DNS,
 * assembled from live surfaces so it updates itself.
 *
 *   · HERO — the TEAM's own brand (name, tagline, bio, colors, logo, phone)
 *   · TEAM LISTINGS — active inventory carried by the team's agents
 *   · THE TEAM — roster → /p/[agentSlug] profiles
 *   · compliance footer on the BROKERAGE's license (teams advertise under
 *     their brokerage's license — the footer names both)
 */
import { notFound } from "next/navigation"
import Link from "next/link"
import { createServiceClient } from "@/lib/supabase/service"
import { siteUrl } from "@/lib/platform/site-url"
import { serializeJsonLd } from "@/lib/geo/video-landing"

export const dynamic = "force-dynamic"
export const revalidate = 300

interface PageProps { params: Promise<{ slug: string }> }

async function loadTeamSite(slug: string) {
  const svc = createServiceClient()
  const { data: t } = await svc.from("teams")
    .select("id, brokerage_id, name, tagline, bio_text, logo_url, primary_color, phone, public_slug")
    .eq("public_slug", slug).is("deleted_at", null).maybeSingle()
  if (!t) return null
  const [{ data: b }, { data: agents }] = await Promise.all([
    svc.from("brokerages").select("name, license_number, license_state").eq("id", t.brokerage_id).maybeSingle(),
    svc.from("agents")
      .select("id, public_slug, photo_url, users(first_name, last_name)")
      .eq("team_id", t.id).eq("is_active", true).limit(24),
  ])
  const agentIds = ((agents ?? []) as Array<{ id: string }>).map((a) => a.id)
  let listings: any[] = []
  if (agentIds.length > 0) {
    const { data: ls } = await svc.from("listings")
      .select("id, mls_number, address, city, state, list_price, bedrooms, bathrooms, sqft, primary_photo_url")
      .in("agent_id", agentIds).eq("status", "active").is("deleted_at", null)
      .order("updated_at", { ascending: false }).limit(6)
    listings = ls ?? []
  }
  return { t, b, agents: agents ?? [], listings }
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params
  const data = await loadTeamSite(slug)
  if (!data) return { title: "Real Estate Team" }
  const desc = (data.t.tagline ?? data.t.bio_text ?? `${data.t.name} — real estate team.`).slice(0, 160)
  return { title: data.t.name, description: desc, openGraph: { title: data.t.name, description: desc, type: "website" } }
}

const money = (n: number | null) => (n ? `$${Number(n).toLocaleString("en-US")}` : "")

export default async function TeamSitePage({ params }: PageProps) {
  const { slug } = await params
  const data = await loadTeamSite(slug)
  if (!data) notFound()
  const { t, b, agents, listings } = data
  const primary = /^#[0-9a-fA-F]{6}$/.test(t.primary_color ?? "") ? (t.primary_color as string) : "#0F172A"
  const pageUrl = `${siteUrl()}/team/${t.public_slug}`

  const orgJsonLd = {
    "@context": "https://schema.org",
    "@type": "RealEstateAgent",
    name: t.name,
    url: pageUrl,
    ...(t.logo_url ? { logo: t.logo_url } : {}),
    ...(t.phone ? { telephone: t.phone } : {}),
    ...(b?.name ? { parentOrganization: { "@type": "RealEstateAgent", name: b.name } } : {}),
  }

  return (
    <div className="min-h-screen bg-background">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(orgJsonLd) }} />

      <header style={{ backgroundColor: primary }} className="text-white">
        <div className="container mx-auto px-6 py-20">
          {t.logo_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={t.logo_url} alt={t.name ?? "Team"} className="h-14 mb-8 object-contain" />
          )}
          <h1 className="text-4xl md:text-6xl font-black tracking-tight text-balance">{t.name}</h1>
          {t.tagline && <p className="mt-4 text-xl text-white/90 font-medium">{t.tagline}</p>}
          {t.bio_text && <p className="mt-4 max-w-2xl text-lg text-white/80 leading-relaxed">{t.bio_text.slice(0, 300)}</p>}
          {t.phone && (
            <a href={`tel:${t.phone}`} className="mt-8 inline-block rounded-full bg-white/15 px-5 py-2.5 text-sm font-semibold hover:bg-white/25">{t.phone}</a>
          )}
        </div>
      </header>

      {listings.length > 0 && (
        <section className="container mx-auto px-6 py-16">
          <h2 className="text-2xl font-bold mb-8">Our listings</h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {listings.map((l: any) => (
              <Link key={l.id} href={`/listing/${l.mls_number ?? l.id}`} className="group rounded-xl border overflow-hidden hover:shadow-lg transition-shadow">
                <div className="aspect-[4/3] bg-muted overflow-hidden">
                  {l.primary_photo_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={l.primary_photo_url} alt={l.address ?? "Listing"} className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                  )}
                </div>
                <div className="p-4">
                  <div className="text-lg font-bold" style={{ color: primary }}>{money(l.list_price)}</div>
                  <div className="font-medium">{l.address}</div>
                  <div className="text-sm text-muted-foreground">
                    {[l.city, l.state].filter(Boolean).join(", ")}
                    {l.bedrooms ? ` · ${l.bedrooms} bd` : ""}{l.bathrooms ? ` · ${l.bathrooms} ba` : ""}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {agents.length > 0 && (
        <section className="bg-muted/40">
          <div className="container mx-auto px-6 py-16">
            <h2 className="text-2xl font-bold mb-8">The team</h2>
            <div className="grid gap-6 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
              {agents.map((a: any) => {
                const u = Array.isArray(a.users) ? a.users[0] : a.users
                const name = [u?.first_name, u?.last_name].filter(Boolean).join(" ") || "Agent"
                const inner = (
                  <>
                    {a.photo_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={a.photo_url} alt={name} className="mx-auto w-24 h-24 rounded-full object-cover border-2 group-hover:scale-105 transition-transform" style={{ borderColor: primary }} />
                    ) : (
                      <div className="mx-auto w-24 h-24 rounded-full flex items-center justify-center text-2xl font-bold text-white" style={{ backgroundColor: primary }}>
                        {name[0]}
                      </div>
                    )}
                    <div className="mt-3 font-medium text-sm">{name}</div>
                  </>
                )
                return a.public_slug
                  ? <Link key={a.id} href={`/p/${a.public_slug}`} className="group text-center">{inner}</Link>
                  : <div key={a.id} className="text-center">{inner}</div>
              })}
            </div>
          </div>
        </section>
      )}

      <footer className="border-t">
        <div className="container mx-auto px-6 py-10 text-sm text-muted-foreground space-y-1">
          <div className="font-medium text-foreground">{t.name}{b?.name ? ` · ${b.name}` : ""}</div>
          <div>
            {b?.license_number ? `Brokerage License #${b.license_number}${b.license_state ? ` (${b.license_state})` : ""} · ` : ""}
            Equal Housing Opportunity
          </div>
          <div>If your home is currently listed with another broker, this is not a solicitation. Information deemed reliable but not guaranteed.</div>
        </div>
      </footer>
    </div>
  )
}
