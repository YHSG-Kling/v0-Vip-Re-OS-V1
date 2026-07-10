/**
 * app/site/[slug]/page.tsx — THE TENANT WEBSITE (owner ask: "can tenants
 * build a website on this and not have to host the domain?" — yes: this IS
 * it). Every brokerage with a slug gets a complete, public, SEO/GEO-ready
 * website served on the PLATFORM's origin — zero tenant hosting, zero DNS
 * work, live the moment they sign up. A custom domain can be pointed later
 * without rebuilding anything (the page is origin-agnostic).
 *
 * Assembled 100% from surfaces the OS already runs — the site is a live
 * window into the tenant's real operation, not a static brochure:
 *   · HERO — the brokerage's own brand (name, about, colors, logo, contact)
 *   · FEATURED LISTINGS — active inventory → /listing/[slug] (lead capture)
 *   · OUR AGENTS — the roster → /p/[agentSlug] profiles
 *   · LATEST ARTICLES — the autonomous blog rail → /blog/[slug]
 *   · JOIN US — the recruiting landing → /recruiting/[slug]
 *   · compliance footer (license + EHO + not-a-solicitation)
 *
 * Server-rendered with Organization/RealEstateAgent JSON-LD; indexed by the
 * sitemap + llms.txt so search AND AI search can read the whole storefront.
 */
import { notFound } from "next/navigation"
import Link from "next/link"
import { createServiceClient } from "@/lib/supabase/service"
import { siteUrl } from "@/lib/platform/site-url"
import { serializeJsonLd } from "@/lib/geo/video-landing"

export const dynamic = "force-dynamic"
export const revalidate = 300

interface PageProps { params: Promise<{ slug: string }> }

async function loadSite(slug: string) {
  const svc = createServiceClient()
  const { data: b } = await svc.from("brokerages")
    .select("id, name, slug, logo_url, primary_color, about_text, bio_text, phone, email, website, license_number, license_state, city, state, recruiting_pitch")
    .eq("slug", slug).is("deleted_at", null).maybeSingle()
  if (!b) return null
  const [{ data: listings }, { data: agents }, { data: posts }] = await Promise.all([
    svc.from("listings")
      .select("id, mls_number, address, city, state, list_price, bedrooms, bathrooms, sqft, primary_photo_url")
      .eq("brokerage_id", b.id).eq("status", "active").is("deleted_at", null)
      .order("updated_at", { ascending: false }).limit(6),
    svc.from("agents")
      .select("public_slug, photo_url, user_id, users(first_name, last_name)")
      .eq("brokerage_id", b.id).not("public_slug", "is", null).limit(12),
    svc.from("blog_posts")
      .select("slug, title, excerpt, published_at")
      .eq("brokerage_id", b.id).eq("publish_status", "published").not("slug", "is", null)
      .order("published_at", { ascending: false }).limit(3),
  ])
  return { b, listings: listings ?? [], agents: agents ?? [], posts: posts ?? [] }
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params
  const data = await loadSite(slug)
  if (!data) return { title: "Real Estate" }
  const desc = (data.b.about_text ?? data.b.bio_text ?? `${data.b.name} — real estate.`).slice(0, 160)
  return {
    title: data.b.name,
    description: desc,
    openGraph: { title: data.b.name, description: desc, type: "website" },
  }
}

const money = (n: number | null) => (n ? `$${Number(n).toLocaleString("en-US")}` : "")

export default async function TenantSitePage({ params }: PageProps) {
  const { slug } = await params
  const data = await loadSite(slug)
  if (!data) notFound()
  const { b, listings, agents, posts } = data
  const primary = /^#[0-9a-fA-F]{6}$/.test(b.primary_color ?? "") ? (b.primary_color as string) : "#0F172A"
  const base = siteUrl()
  const pageUrl = `${base}/site/${b.slug}`

  const orgJsonLd = {
    "@context": "https://schema.org",
    "@type": "RealEstateAgent",
    name: b.name,
    url: pageUrl,
    ...(b.logo_url ? { logo: b.logo_url } : {}),
    ...(b.phone ? { telephone: b.phone } : {}),
    ...(b.email ? { email: b.email } : {}),
    ...(b.city || b.state ? { address: { "@type": "PostalAddress", ...(b.city ? { addressLocality: b.city } : {}), ...(b.state ? { addressRegion: b.state } : {}), addressCountry: "US" } } : {}),
  }

  return (
    <div className="min-h-screen bg-background">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(orgJsonLd) }} />

      {/* HERO — the tenant's brand, full bleed */}
      <header style={{ backgroundColor: primary }} className="text-white">
        <div className="container mx-auto px-6 py-20">
          {b.logo_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={b.logo_url} alt={b.name} className="h-14 mb-8 object-contain" />
          )}
          <h1 className="text-4xl md:text-6xl font-black tracking-tight text-balance">{b.name}</h1>
          {(b.about_text ?? b.bio_text) && (
            <p className="mt-6 max-w-2xl text-lg text-white/85 leading-relaxed">{(b.about_text ?? b.bio_text ?? "").slice(0, 300)}</p>
          )}
          <div className="mt-8 flex flex-wrap gap-3 text-sm font-semibold">
            {b.phone && <a href={`tel:${b.phone}`} className="rounded-full bg-white/15 px-5 py-2.5 hover:bg-white/25">{b.phone}</a>}
            {b.email && <a href={`mailto:${b.email}`} className="rounded-full bg-white/15 px-5 py-2.5 hover:bg-white/25">{b.email}</a>}
            {b.recruiting_pitch && (
              <Link href={`/recruiting/${b.slug}`} className="rounded-full bg-white px-5 py-2.5 hover:opacity-90" style={{ color: primary }}>
                Agents: join our team →
              </Link>
            )}
          </div>
        </div>
      </header>

      {/* FEATURED LISTINGS — live inventory, each a lead-capture page */}
      {listings.length > 0 && (
        <section className="container mx-auto px-6 py-16">
          <h2 className="text-2xl font-bold mb-8">Featured listings</h2>
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
                    {l.bedrooms ? ` · ${l.bedrooms} bd` : ""}{l.bathrooms ? ` · ${l.bathrooms} ba` : ""}{l.sqft ? ` · ${Number(l.sqft).toLocaleString()} sqft` : ""}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* AGENTS — the roster, each with a public profile */}
      {agents.length > 0 && (
        <section className="bg-muted/40">
          <div className="container mx-auto px-6 py-16">
            <h2 className="text-2xl font-bold mb-8">Our agents</h2>
            <div className="grid gap-6 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
              {agents.map((a: any) => {
                const u = Array.isArray(a.users) ? a.users[0] : a.users
                const name = [u?.first_name, u?.last_name].filter(Boolean).join(" ") || "Agent"
                return (
                  <Link key={a.public_slug} href={`/p/${a.public_slug}`} className="group text-center">
                    {a.photo_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={a.photo_url} alt={name} className="mx-auto w-24 h-24 rounded-full object-cover border-2 group-hover:scale-105 transition-transform" style={{ borderColor: primary }} />
                    ) : (
                      <div className="mx-auto w-24 h-24 rounded-full flex items-center justify-center text-2xl font-bold text-white" style={{ backgroundColor: primary }}>
                        {name[0]}
                      </div>
                    )}
                    <div className="mt-3 font-medium text-sm">{name}</div>
                  </Link>
                )
              })}
            </div>
          </div>
        </section>
      )}

      {/* ARTICLES — the autonomous blog rail */}
      {posts.length > 0 && (
        <section className="container mx-auto px-6 py-16">
          <h2 className="text-2xl font-bold mb-8">Latest from us</h2>
          <div className="grid gap-6 md:grid-cols-3">
            {posts.map((p: any) => (
              <Link key={p.slug} href={`/blog/${p.slug}`} className="rounded-xl border p-6 hover:shadow-lg transition-shadow">
                <div className="font-semibold text-balance">{p.title}</div>
                {p.excerpt && <p className="mt-2 text-sm text-muted-foreground line-clamp-3">{p.excerpt}</p>}
                <div className="mt-4 text-sm font-semibold" style={{ color: primary }}>Read →</div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* COMPLIANCE FOOTER */}
      <footer className="border-t">
        <div className="container mx-auto px-6 py-10 text-sm text-muted-foreground space-y-1">
          <div className="font-medium text-foreground">{b.name}</div>
          <div>
            {b.license_number ? `License #${b.license_number}${b.license_state ? ` (${b.license_state})` : ""} · ` : ""}
            Equal Housing Opportunity
          </div>
          <div>If your home is currently listed with another broker, this is not a solicitation. Information deemed reliable but not guaranteed.</div>
        </div>
      </footer>
    </div>
  )
}
