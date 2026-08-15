/**
 * app/blog/[slug]/page.tsx
 *
 * Wave 31 — public hosted blog landing page. Mirrors the existing
 * /listing/[slug] pattern: no auth, full OG/Twitter Card metadata,
 * inline tracking (track-view fires on mount), share-buttons component.
 *
 * Brokerages without WordPress can use this URL as the canonical blog
 * destination — they add a link from their main site nav to point at
 * /blog/[slug]. For brokerages that publish to BOTH targets, the
 * WordPress post carries a rel="canonical" tag pointing here so search
 * engines don't penalize duplicate content.
 *
 * URL params honored by the tracker:
 *   ?p=<persona>     — persona snapshot for per-(topic, persona) attribution
 *   ?c=<contact_id>  — when sent from a tagged newsletter / drip link
 *   ?utm_source=…    — traffic source (newsletter, social, organic, ai_overview)
 */
import { notFound } from "next/navigation"
import Image from "next/image"
import { createServiceClient } from "@/lib/supabase/service"
import { BlogTracker } from "@/app/components/blog-landing/BlogTracker"
import { BlogShareButtons } from "@/app/components/blog-landing/BlogShareButtons"

export const dynamic = "force-dynamic"

interface PageProps {
  params:       Promise<{ slug: string }>
  searchParams: Promise<{
    p?: string
    c?: string
    utm_source?: string
  }>
}

interface BlogPostRow {
  id:                 string
  brokerage_id:       string
  agent_user_id:      string | null
  title:              string
  slug:               string
  excerpt:            string | null
  content:            string
  featured_image_url: string | null
  publish_status:     string
  published_at:       string | null
  category:           string | null
  view_count_total:   number
  share_count_total:  number
}

interface BrokerageRow {
  name:                  string | null
  logo_url:              string | null
  brand_primary_color:   string | null
  city:                  string | null
  state:                 string | null
}

interface AgentDisplay {
  first_name: string | null
  last_name:  string | null
  photo_url:  string | null
}

async function getPost(slug: string): Promise<{ post: BlogPostRow; brokerage: BrokerageRow | null; author: AgentDisplay | null } | null> {
  const svc = createServiceClient()
  const { data: post } = await svc
    .from("blog_posts")
    .select("id, brokerage_id, agent_user_id, title, slug, excerpt, content, featured_image_url, publish_status, published_at, category, view_count_total, share_count_total, publish_target")
    .eq("slug", slug)
    .in("publish_status", ["published", "approved"])
    .in("publish_target", ["hosted", "both"])
    .maybeSingle()
  const p = post as (BlogPostRow & { publish_target: string }) | null
  if (!p) return null
  const [{ data: brokerage }, authorRes] = await Promise.all([
    svc.from("brokerages")
      .select("name, logo_url, brand_primary_color, city, state")
      .eq("id", p.brokerage_id)
      .maybeSingle(),
    p.agent_user_id
      ? svc.from("agents")
          .select("photo_url, user:users!agents_user_id_fkey(first_name, last_name)")
          .eq("user_id", p.agent_user_id)
          .maybeSingle()
      : Promise.resolve({ data: null } as { data: null }),
  ])
  let author: AgentDisplay | null = null
  if (authorRes.data) {
    const a = authorRes.data as { photo_url: string | null; user: Array<{ first_name: string | null; last_name: string | null }> | { first_name: string | null; last_name: string | null } | null }
    const u = Array.isArray(a.user) ? a.user[0] : a.user
    author = { first_name: u?.first_name ?? null, last_name: u?.last_name ?? null, photo_url: a.photo_url ?? null }
  }
  return { post: p, brokerage: brokerage as BrokerageRow | null, author }
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params
  const r = await getPost(slug)
  if (!r) return { title: "Blog", description: "Real estate insights" }
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""
  const canonical = `${baseUrl}/blog/${r.post.slug}`
  return {
    title:       r.post.title,
    description: r.post.excerpt ?? "",
    alternates:  { canonical },
    openGraph: {
      title:       r.post.title,
      description: r.post.excerpt ?? "",
      url:         canonical,
      type:        "article",
      images:      r.post.featured_image_url ? [r.post.featured_image_url] : undefined,
      siteName:    r.brokerage?.name ?? undefined,
      publishedTime: r.post.published_at ?? undefined,
    },
    twitter: {
      card:        "summary_large_image",
      title:       r.post.title,
      description: r.post.excerpt ?? "",
      images:      r.post.featured_image_url ? [r.post.featured_image_url] : undefined,
    },
  }
}

export default async function PublicBlogPage({ params, searchParams }: PageProps) {
  const { slug } = await params
  const { p: persona, c: contactId, utm_source } = await searchParams
  const r = await getPost(slug)
  if (!r) notFound()

  const { post, brokerage, author } = r
  const authorName = author ? [author.first_name, author.last_name].filter(Boolean).join(" ").trim() : ""
  const brand = {
    primary: brokerage?.brand_primary_color ?? "#0F172A",
    name:    brokerage?.name ?? "",
    logo:    brokerage?.logo_url ?? null,
    locale:  [brokerage?.city, brokerage?.state].filter(Boolean).join(", "),
  }
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""
  const shareUrl = `${baseUrl}/blog/${post.slug}`

  return (
    <article className="min-h-screen bg-white">
      {/* Brand header */}
      <header style={{ backgroundColor: brand.primary }} className="text-white">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center gap-3">
          {brand.logo && (
            <Image src={brand.logo} alt={brand.name} width={40} height={40} className="rounded" />
          )}
          <div>
            <div className="font-semibold">{brand.name}</div>
            {brand.locale && <div className="text-xs opacity-80">{brand.locale}</div>}
          </div>
        </div>
      </header>

      {/* Hero */}
      {post.featured_image_url && (
        <div className="w-full bg-gray-100">
          <div className="max-w-4xl mx-auto">
            <Image
              src={post.featured_image_url}
              alt={post.title}
              width={1792}
              height={1024}
              className="w-full h-auto object-cover"
              priority
            />
          </div>
        </div>
      )}

      <div className="max-w-3xl mx-auto px-6 py-10">
        {/* Title + byline */}
        <h1 className="text-4xl font-bold text-gray-900 leading-tight mb-3">{post.title}</h1>
        {post.excerpt && (
          <p className="text-lg text-gray-600 leading-relaxed mb-6">{post.excerpt}</p>
        )}
        <div className="flex items-center gap-3 pb-6 mb-6 border-b border-gray-200">
          {author?.photo_url && (
            <Image src={author.photo_url} alt={authorName} width={44} height={44} className="rounded-full" />
          )}
          <div className="text-sm">
            {authorName && <div className="font-medium text-gray-900">{authorName}</div>}
            {post.published_at && (
              <div className="text-gray-500">
                {new Date(post.published_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
              </div>
            )}
          </div>
        </div>

        {/* Body — pre-sanitized at authoring time via the compliance chain.
            The model output goes through evaluateOutbound + applyBrandVoice
            before reaching the DB so the HTML here is policy-clean. */}
        <div
          className="prose prose-lg max-w-none text-gray-800 leading-relaxed"
          dangerouslySetInnerHTML={{ __html: post.content }}
        />

        {/* Share buttons + tracker */}
        <div className="mt-10">
          <BlogShareButtons
            blogPostId={post.id}
            shareUrl={shareUrl}
            title={post.title}
            personaSnapshot={persona ?? null}
            contactId={contactId ?? null}
          />
        </div>
      </div>

      {/* Tracker — fires track-view on mount with the URL-tag persona +
          contact_id + source. Runs client-side AFTER the page renders so
          the view is attributed even if the user closes the tab before
          interacting. */}
      <BlogTracker
        blogPostId={post.id}
        personaSnapshot={persona ?? null}
        contactId={contactId ?? null}
        utmSource={utm_source ?? null}
      />
    </article>
  )
}
