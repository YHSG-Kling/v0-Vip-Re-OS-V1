import { Suspense } from "react"
import SavedPropertiesContent from "./saved-content"

export default function SavedPropertiesPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background p-8">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mt-12" />
        </div>
      }
    >
      <SavedPropertiesContent />
    </Suspense>
  )
}
