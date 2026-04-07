"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { distributeVideoProjectAction } from "@/app/actions/video"
import { Youtube, Linkedin, Send } from "lucide-react"

export function DistributionControls({ projectId }: { projectId: string }) {
  const [channels, setChannels] = useState<Array<"youtube" | "linkedin" | "tiktok" | "instagram">>([
    "youtube",
  ])
  const [isDistributing, setIsDistributing] = useState(false)
  const [title, setTitle] = useState("Beautiful Property Showcase")
  const [description, setDescription] = useState("Check out this stunning property...")

  const channelOptions = [
    { id: "youtube" as const, label: "YouTube", icon: Youtube },
    { id: "linkedin" as const, label: "LinkedIn", icon: Linkedin },
    { id: "tiktok" as const, label: "TikTok", icon: Send },
    { id: "instagram" as const, label: "Instagram", icon: Send },
  ]

  function toggleChannel(id: "youtube" | "linkedin" | "tiktok" | "instagram") {
    setChannels(
      channels.includes(id) ? channels.filter((c) => c !== id) : [...channels, id]
    )
  }

  async function handleDistribute() {
    setIsDistributing(true)
    await distributeVideoProjectAction({
      projectId,
      channels,
      title,
      description,
    })
    setIsDistributing(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Distribution</CardTitle>
        <CardDescription>Publish your video to social media channels</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <label className="text-sm font-medium">Select Channels</label>
          {channelOptions.map(({ id, label, icon: Icon }) => (
            <div key={id} className="flex items-center gap-2">
              <Checkbox
                id={id}
                checked={channels.includes(id)}
                onCheckedChange={() => toggleChannel(id)}
              />
              <Icon className="w-4 h-4" />
              <label htmlFor={id} className="text-sm cursor-pointer">
                {label}
              </label>
            </div>
          ))}
        </div>

        <div>
          <label className="text-sm font-medium mb-1 block">Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full px-3 py-2 border border-input rounded-md text-sm"
          />
        </div>

        <div>
          <label className="text-sm font-medium mb-1 block">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full px-3 py-2 border border-input rounded-md text-sm"
            rows={3}
          />
        </div>

        <Button onClick={handleDistribute} disabled={isDistributing || channels.length === 0} className="w-full">
          {isDistributing ? "Publishing..." : "Publish to Selected Channels"}
        </Button>
      </CardContent>
    </Card>
  )
}
