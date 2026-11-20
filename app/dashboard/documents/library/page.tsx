import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getGeneratedDocumentLibrary } from "@/app/actions/generated-documents"
import { GeneratedLibraryClient } from "./generated-library-client"

export const dynamic = "force-dynamic"
export const metadata = { title: "Generated Documents" }

/**
 * GENERATED DOCUMENT LIBRARY — the produced-PDF rail, a SIBLING of the
 * Document Center, never a fold-in: client_documents is uploaded/received
 * provenance; generated_documents is what the platform itself produced. Same
 * SSR → action → client-list shape as /dashboard/documents.
 */
export default async function GeneratedDocumentLibraryPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const data = await getGeneratedDocumentLibrary()
  if (!data.success) {
    // §3 — the refusal renders as a refusal, never as an empty library.
    return (
      <div className="p-6 text-sm text-red-600">
        Could not load the generated-document library: {data.error}
      </div>
    )
  }

  return <GeneratedLibraryClient documents={data.documents} />
}
