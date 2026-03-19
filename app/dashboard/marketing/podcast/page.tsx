import { Suspense } from "react"
import { PodcastDashboard } from "./podcast-dashboard"

export const metadata = {
  title: "Podcast Studio | VIP Agents AI",
  description: "AI-powered podcast creation and distribution for real estate agents",
}

export default function PodcastPage() {
  return (
    <div className="flex flex-col h-full">
      <Suspense fallback={<PodcastLoadingSkeleton />}>
        <PodcastDashboard />
      </Suspense>
    </div>
  )
}

function PodcastLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div className="h-8 w-48 bg-gray-200 rounded animate-pulse" />
        <div className="h-10 w-32 bg-gray-200 rounded animate-pulse" />
      </div>
      <div className="h-10 w-full max-w-md bg-gray-200 rounded animate-pulse" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-48 bg-gray-200 rounded-xl animate-pulse" />
        ))}
      </div>
    </div>
  )
}
