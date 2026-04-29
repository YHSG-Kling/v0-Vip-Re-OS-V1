"use client"

import { useState } from "react"
import { VideoProjectList } from "@/app/components/features/video/VideoProjectList"
import { ScriptEditor } from "@/app/components/features/video/ScriptEditor"
import { GenerationSettings } from "@/app/components/features/video/GenerationSettings"
import { VideoPreview } from "@/app/components/features/video/VideoPreview"
import { DistributionControls } from "@/app/components/features/video/DistributionControls"
import type { VideoProject } from "@/app/actions/video/create-video-project"

interface VideoHubClientProps {
  initialProjects: VideoProject[]
  brokerageId: string
  userId: string
}

export default function VideoHubClient({ initialProjects, brokerageId, userId }: VideoHubClientProps) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    initialProjects[0]?.id ?? null
  )

  return (
    <div className="container mx-auto py-8">
      <div className="mb-8">
        <h1 className="text-4xl font-bold mb-2">Video Generation Hub</h1>
        <p className="text-muted-foreground">Create, customize, and distribute AI-powered property videos</p>
      </div>

      <div className="grid gap-8">
        <VideoProjectList
          brokerageId={brokerageId}
          initialProjects={initialProjects}
          selectedProjectId={selectedProjectId}
          onSelect={setSelectedProjectId}
          onProjectCreated={(id) => setSelectedProjectId(id)}
        />

        {selectedProjectId ? (
          <>
            <ScriptEditor projectId={selectedProjectId} />
            <GenerationSettings projectId={selectedProjectId} />
            <VideoPreview projectId={selectedProjectId} />
            <DistributionControls projectId={selectedProjectId} />
          </>
        ) : (
          <div className="text-center py-16 text-muted-foreground border-2 border-dashed rounded-xl">
            <p className="text-lg font-medium mb-2">No project selected</p>
            <p className="text-sm">Create your first video project above to get started.</p>
          </div>
        )}
      </div>
    </div>
  )
}
