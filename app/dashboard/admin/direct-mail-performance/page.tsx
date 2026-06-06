import { getDirectMailPerformance } from "@/app/actions/direct-mail-performance"
import { DirectMailPerformanceClient } from "./client"

export const dynamic = "force-dynamic"

export default async function DirectMailPerformancePage() {
  const result = await getDirectMailPerformance()
  if (!result.success) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Direct Mail Performance</h1>
        <p className="text-red-600">{result.error}</p>
      </div>
    )
  }
  return (
    <DirectMailPerformanceClient
      overview={result.overview}
      topVariants={result.topVariants}
      recentCampaigns={result.recentCampaigns}
      geoHeatmap={result.geoHeatmap}
    />
  )
}
