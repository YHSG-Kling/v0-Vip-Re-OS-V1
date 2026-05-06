import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getDocumentCenterData } from "@/app/actions/document-center"
import { DocumentCenterClient } from "./document-center-client"

export const dynamic = "force-dynamic"
export const metadata = { title: "Document Center" }

export default async function DocumentCenterPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const data = await getDocumentCenterData()
  if (!data.success) {
    return (
      <div className="p-6 text-sm text-red-600">
        Could not load Document Center: {data.error}
      </div>
    )
  }

  return (
    <DocumentCenterClient
      folders={data.folders}
      totalCount={data.totalCount}
      pendingReviewCount={data.pendingReviewCount}
      blockingIssuesCount={data.blockingIssuesCount}
    />
  )
}
