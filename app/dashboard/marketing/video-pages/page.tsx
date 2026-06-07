/**
 * app/dashboard/marketing/video-pages/page.tsx
 *
 * Wave 39 GEO — the all-tiers "Publish to web" surface. Every subscriber
 * (solo agent → multi-location brokerage) sees their succeeded renders and
 * can publish them as public, AI-search-citable /v/[slug] pages without
 * waiting for the weekly Asset Manager cycle. Agents see their own renders;
 * brokerage admins see the whole tenant.
 */
import { listPublishableRenders } from "@/app/actions/video-landing"
import { VideoPagesClient } from "./client"

export const dynamic = "force-dynamic"

export default async function VideoPagesPage() {
  const result = await listPublishableRenders()
  if (!result.success) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Video Pages</h1>
        <p className="text-red-600">{result.error}</p>
      </div>
    )
  }
  return <VideoPagesClient renders={result.renders} />
}
