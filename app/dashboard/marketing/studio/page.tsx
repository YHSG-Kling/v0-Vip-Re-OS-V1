import { Suspense } from "react"
import MarketingStudioClient from "./marketing-studio-client"

export const metadata = {
  title: "Marketing Studio | Dashboard",
  description: "Unified marketing command center for campaigns, assets, and content scheduling",
}

export default function MarketingStudioPage() {
  return (
    <Suspense fallback={<MarketingStudioSkeleton />}>
      <MarketingStudioClient />
    </Suspense>
  )
}

function MarketingStudioSkeleton() {
  return (
    <div className="min-h-screen bg-background p-6 lg:p-8">
      <div className="max-w-[1600px] mx-auto space-y-6">
        {/* Header skeleton */}
        <div className="h-32 bg-muted animate-pulse rounded-xl" />
        {/* Stats skeleton */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />
          ))}
        </div>
        {/* Tabs skeleton */}
        <div className="h-16 bg-muted animate-pulse rounded-lg" />
        {/* Content skeleton */}
        <div className="h-96 bg-muted animate-pulse rounded-lg" />
      </div>
    </div>
  )
}
