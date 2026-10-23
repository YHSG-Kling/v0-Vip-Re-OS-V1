import type { Metadata } from "next"
import { Suspense } from "react"
import { ContentOsClient } from "./content-os-client"

export const metadata: Metadata = {
  title: "Content OS",
  description: "Drafts, templates, SEO, hashtags, A/B tests, performance and AI spend",
}

/**
 * Content OS — the surface for the content-generation capabilities that had
 * been built but never reachable. Everything here talks to
 * app/actions/ai-content-generation.tsx.
 */
export default function ContentOsPage() {
  // ContentOsClient reads ?tab= via useSearchParams, which needs a Suspense
  // boundary or the whole route opts out of static rendering.
  return (
    <Suspense fallback={null}>
      <ContentOsClient />
    </Suspense>
  )
}
