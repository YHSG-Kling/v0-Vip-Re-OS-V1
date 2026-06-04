import { getMyBlogCadencePolicy } from "@/app/actions/blog-cadence-policy"
import { BlogCadenceSettingsClient } from "./client"

export const dynamic = "force-dynamic"

export default async function BlogCadenceSettingsPage() {
  const result = await getMyBlogCadencePolicy()
  if (!result.success) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Blog Cadence Settings</h1>
        <p className="text-red-600">{result.error ?? "Could not load settings"}</p>
      </div>
    )
  }
  return (
    <BlogCadenceSettingsClient
      initialPolicy={result.policy ?? null}
    />
  )
}
