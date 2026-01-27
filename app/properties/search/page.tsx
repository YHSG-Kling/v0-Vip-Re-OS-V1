import { Suspense } from "react"
import PropertySearchContent from "./search-content"

export default function PropertySearchPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background p-8">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mt-12" />
        </div>
      }
    >
      <PropertySearchContent />
    </Suspense>
  )
}
