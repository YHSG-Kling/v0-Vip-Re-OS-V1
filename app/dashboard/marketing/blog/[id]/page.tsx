import { notFound, redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getBlogPostById } from "@/app/actions/blog"
import { BlogPostEditor } from "./blog-post-editor"

export const dynamic = "force-dynamic"

interface BlogPostPageProps {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: BlogPostPageProps) {
  const { id } = await params
  const result = await getBlogPostById(id)
  return {
    title: result.post ? `${result.post.title} | Blog` : "Blog Post",
    description: result.post?.excerpt || "Edit blog post",
  }
}

export default async function BlogPostPage({ params }: BlogPostPageProps) {
  const { id } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  const result = await getBlogPostById(id)

  if (!result.success || !result.post) {
    notFound()
  }

  return <BlogPostEditor post={result.post} userId={user.id} />
}
