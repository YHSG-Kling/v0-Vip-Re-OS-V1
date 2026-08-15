import { getCompositionLibrarySnapshot } from "@/app/actions/composition-library"
import { CompositionLibraryClient } from "./client"

export const dynamic = "force-dynamic"

export default async function CompositionLibraryPage() {
  const result = await getCompositionLibrarySnapshot()
  if (!result.success) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Composition Library</h1>
        <p className="text-red-600">{result.error}</p>
      </div>
    )
  }
  return <CompositionLibraryClient snapshot={result.snapshot} />
}
