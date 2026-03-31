"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { previewVideoProjectAction, submitVideoGenerationJobAction } from "@/app/actions/video"
import { Play } from "lucide-react"

export function VideoPreview({ projectId, scriptText }: { projectId: string; scriptText?: string }) {
  const [previewUrl, setPreviewUrl] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)

  async function handleLoadPreview() {
    setIsLoading(true)
    const result = await previewVideoProjectAction({ projectId })
    if (result.success && result.data) {
      setPreviewUrl(result.data.streamUrl)
    }
    setIsLoading(false)
  }

  async function handleGenerateVideo() {
    if (!scriptText) return

    setIsGenerating(true)
    const result = await submitVideoGenerationJobAction({
      projectId,
      scriptText,
      voiceProfileId: "default",
      avatarStyle: "professional",
      estimatedDurationSeconds: 60,
    })

    if (result.success) {
      // Poll for completion
      setTimeout(() => handleLoadPreview(), 5000)
    }
    setIsGenerating(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Video Preview</CardTitle>
        <CardDescription>Preview and generate your video</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {previewUrl ? (
          <div className="aspect-video bg-black rounded-lg overflow-hidden">
            <video src={previewUrl} controls className="w-full h-full" />
          </div>
        ) : (
          <div className="aspect-video bg-muted rounded-lg flex items-center justify-center">
            <div className="text-center text-muted-foreground">
              <Play className="w-12 h-12 mx-auto mb-2 opacity-50" />
              <p>Video preview will appear here</p>
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={handleGenerateVideo} disabled={isGenerating || !scriptText} className="flex-1">
            {isGenerating ? "Generating..." : "Generate Video"}
          </Button>
          <Button onClick={handleLoadPreview} disabled={isLoading} variant="outline" className="flex-1">
            {isLoading ? "Loading..." : "Load Preview"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
