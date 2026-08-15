/**
 * app/embed/blog/[slug]/page.tsx
 *
 * Wave 32 — chrome-stripped blog renderer for iframe embedding on the
 * brokerage's existing website. Brokerage drops one line on their site:
 *
 *   <iframe src="https://platform/embed/blog/<slug>"
 *           style="width:100%;border:0;min-height:1400px"
 *           loading="lazy"></iframe>
 *
 * No brand header, no locale, no navigation — the surrounding site supplies
 * those. We render the article title + byline + hero + body + share +
 * tracker so the embedded surface still funnels readers into the brokerage's
 * own attribution loop.
 */
import { notFound } from "next/navigation"
import Image from "next/image"
import { createServiceClient } from "@/lib/supabase/service"
import { BlogTracker } from "@/app/components/blog-landing/BlogTracker"
import { BlogShareButtons } from "@/app/components/blog-landing/BlogShareButtons"

export const dynamic = "force-dynamic"

interface PageProps {
  params:       Promise<{ slug: string }>
  searchParams: Promise<{ p?: string; c?: string; utm_source?: string }>
}

export default async function EmbedBlogPage({ params, searchParams }: PageProps) {
  const { slug } = await params
  const { p: persona, c: contactId, utm_source } = await searchParams

  const svc = createServiceClient()
  const { data: post } = await svc
    .from("blog_posts")
    .select("id, brokerage_id, agent_user_id, title, excerpt, content, featured_image_url, published_at, slug")
    .eq("slug", slug)
    .in("publish_status", ["published", "approved"])
    .in("publish_target", ["embed", "both", "hosted"])
    .maybeSingle()
  const p = post as {
    id: string; brokerage_id: string; agent_user_id: string | null;
    title: string; excerpt: string | null; content: string;
    featured_image_url: string | null; published_at: string | null; slug: string
  } | null
  if (!p) notFound()

  let authorName = ""
  let authorPhoto: string | null = null
  if (p.agent_user_id) {
    const { data: agent } = await svc.from("agents")
      .select("photo_url, user:users!agents_user_id_fkey(first_name, last_name)")
      .eq("user_id", p.agent_user_id)
      .maybeSingle()
    if (agent) {
      const a = agent as { photo_url: string | null; user: Array<{ first_name: string | null; last_name: string | null }> | { first_name: string | null; last_name: string | null } | null }
      const u = Array.isArray(a.user) ? a.user[0] : a.user
      authorName = [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim()
      authorPhoto = a.photo_url
    }
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""
  const shareUrl = `${baseUrl}/blog/${p.slug}`

  return (
    <article className="bg-transparent">
      <div className="max-w-3xl mx-auto px-4 py-6">
        {p.featured_image_url && (
          <div className="mb-6">
            <Image
              src={p.featured_image_url}
              alt={p.title}
              width={1792}
              height={1024}
              className="w-full h-auto rounded object-cover"
              priority
            />
          </div>
        )}
        <h1 className="text-3xl font-bold text-gray-900 leading-tight mb-3">{p.title}</h1>
        {p.excerpt && (
          <p className="text-lg text-gray-600 leading-relaxed mb-5">{p.excerpt}</p>
        )}
        {(authorName || p.published_at) && (
          <div className="flex items-center gap-3 pb-4 mb-6 border-b border-gray-200">
            {authorPhoto && (
              <Image src={authorPhoto} alt={authorName} width={36} height={36} className="rounded-full" />
            )}
            <div className="text-sm">
              {authorName && <div className="font-medium text-gray-900">{authorName}</div>}
              {p.published_at && (
                <div className="text-gray-500">
                  {new Date(p.published_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
                </div>
              )}
            </div>
          </div>
        )}

        <div
          className="prose max-w-none text-gray-800 leading-relaxed"
          dangerouslySetInnerHTML={{ __html: p.content }}
        />

        <div className="mt-8">
          <BlogShareButtons
            blogPostId={p.id}
            shareUrl={shareUrl}
            title={p.title}
            personaSnapshot={persona ?? null}
            contactId={contactId ?? null}
          />
        </div>
      </div>
      <BlogTracker
        blogPostId={p.id}
        personaSnapshot={persona ?? null}
        contactId={contactId ?? null}
        utmSource={utm_source ?? null}
      />
    </article>
  )
}
