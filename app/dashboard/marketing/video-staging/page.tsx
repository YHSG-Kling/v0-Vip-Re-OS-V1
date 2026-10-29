/**
 * app/dashboard/marketing/video-staging/page.tsx — NON-LISTING VIDEOS ARE STAGED (wave 146, lane 146F — owner rulings 4 + 9).
 *
 * Every non-listing broadcast video (market update, education, explainer, social reel, agent intro, testimonial) with its
 * stage: generated → playable → rights/branding checked → audience/channel chosen → approver assigned → approved →
 * published. The assigned approver approves here; nothing reaches YouTube or a public page before that
 * (lib/video/video-staging.ts stagedPublicationVerdict). An empty board says so.
 */
import { listStagedVideosAction } from "./actions"
import { VideoStagingClient } from "./staging-client"

export const dynamic = "force-dynamic"

export default async function VideoStagingPage() {
  const result = await listStagedVideosAction()
  if (!result.success) {
    return (
      <div className="p-4 md:p-6">
        <h1 className="text-2xl font-bold text-foreground mb-2">Video staging</h1>
        <p role="alert" className="text-destructive">{result.error}</p>
      </div>
    )
  }
  return <VideoStagingClient videos={result.videos} userId={result.userId} />
}
