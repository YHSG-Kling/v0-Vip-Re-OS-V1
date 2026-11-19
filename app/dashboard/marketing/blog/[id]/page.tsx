// blog post editor — dynamic param: [id]
import { createClient } from "@/lib/supabase/server"
import { redirect, notFound } from "next/navigation"
import { BlogEditorClient } from "./blog-editor-client"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const metadata = {
  title: "Edit Blog Post | Marketing",
  description: "Edit and optimize your blog post",
}

interface BlogEditorPageProps {
  params: Promise<{ id: string }>
}

export default async function BlogEditorPage({ params }: BlogEditorPageProps) {
  const { id: postId } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    redirect("/login")
  }


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  // Get user's brokerage
  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!userData?.brokerage_id) {
    redirect("/dashboard/onboarding")
  }

  // Fetch blog post
  const { data: post, error } = await supabase
    .from("blog_posts")
    .select(
      "id, brokerage_id, title, slug, excerpt, content, featured_image_url, publish_status, seo_score, wordpress_post_id, created_at, published_at, call_to_action, category, agent_user_id, marketing_campaign_id"
    )
    .eq("id", postId)
    .eq("brokerage_id", userData.brokerage_id)
    .maybeSingle()

  if (error || !post) {
    notFound()
  }

  // Fetch linked keywords
  const { data: keywordLinks } = await supabase
    .from("blog_post_keywords")
    .select("is_primary, seo_keyword_id")
    .eq("blog_post_id", postId)

  const keywords: Array<{ id: string; keyword: string; is_primary: boolean }> = []
  if (keywordLinks?.length) {
    const keywordIds = keywordLinks.map((kl) => kl.seo_keyword_id)
    const { data: keywordData } = await supabase
      .from("seo_keywords")
      .select("id, keyword")
      .in("id", keywordIds)

    if (keywordData) {
      for (const kd of keywordData) {
        const link = keywordLinks.find((kl) => kl.seo_keyword_id === kd.id)
        keywords.push({
          id: kd.id,
          keyword: kd.keyword,
          is_primary: link?.is_primary || false,
        })
      }
    }
  }

  // Fetch latest SEO log
  const { data: seoLog } = await supabase
    .from("seo_optimization_log")
    .select("score, issues, recommendations, optimized_at")
    .eq("blog_post_id", postId)
    .order("optimized_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  const latestSeoLog = seoLog
    ? {
        score: seoLog.score,
        issues: (seoLog.issues as { items?: string[] })?.items || [],
        recommendations: (seoLog.recommendations as { items?: string[] })?.items || [],
        optimized_at: seoLog.optimized_at,
      }
    : null

  // WAVE 155 (lane 155E) — the PRINT QR the post will carry, shown HERE, before approval. The tenant is the session's
  // (the post was read under it above); the slot is built from the POST, so this is the same code the public page
  // prints (lib/marketing/tracked-qr.ts blogPrintQrArgs). Held / too small / refused say why no code will print.
  const { resolveArtifactQrSlot, blogPrintQrArgs } = await import("@/lib/marketing/tracked-qr")
  const qrSlot = await resolveArtifactQrSlot(blogPrintQrArgs({ ...post, brokerage_id: userData.brokerage_id }))

  return (
    <>
    <BlogEditorClient
      userId={user.id}
      brokerageId={userData.brokerage_id}
      post={{
        ...post,
        keywords,
        latestSeoLog,
      }}
    />
    <section data-qr-slot-preview="print_footer" className="mx-auto max-w-5xl px-6 pb-10">
      <h2 className="text-sm font-semibold text-gray-900">Print QR code</h2>
      {qrSlot.status === "placed" && qrSlot.qrCodeDataUrl ? (
        <div className="mt-2 flex items-center gap-3">
          <div className="bg-white p-1 leading-none border border-gray-200">
            {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL preview of the print asset */}
            <img src={qrSlot.qrCodeDataUrl} alt="QR code preview" width={96} height={96} />
          </div>
          <p className="text-sm text-gray-600">Printed copies of this post carry this tracked code (1 in). It opens {qrSlot.targetUrl}. Manage it under Agent → QR Codes.</p>
        </div>
      ) : (
        <p className="mt-2 text-sm text-gray-600">
          {qrSlot.status === "absent" ? "No code will print — none was chosen." : qrSlot.status === "placed" ? "No code will print: this slot carries a link, not an image." : `No code will print: ${qrSlot.reason}.`}
        </p>
      )}
    </section>
    </>
  )
}
