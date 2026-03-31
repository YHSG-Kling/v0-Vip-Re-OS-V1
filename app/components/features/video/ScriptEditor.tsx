"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { generateVideoScriptAction } from "@/app/actions/video"

export function ScriptEditor({ projectId }: { projectId: string }) {
  const [scriptText, setScriptText] = useState("")
  const [strategy, setStrategy] = useState("luxury_showcase")
  const [tone, setTone] = useState("professional")
  const [duration, setDuration] = useState("60")
  const [isGenerating, setIsGenerating] = useState(false)

  async function handleGenerateScript() {
    setIsGenerating(true)
    const result = await generateVideoScriptAction({
      projectId,
      contentStrategy: strategy as "luxury_showcase" | "walkthrough" | "testimonial" | "market_update",
      tone: tone as "professional" | "friendly" | "energetic",
      duration: parseInt(duration) as 30 | 60 | 90,
    })

    if (result.success && result.data) {
      setScriptText(result.data.scriptText)
    }
    setIsGenerating(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Video Script</CardTitle>
        <CardDescription>Generate and edit your video script</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 grid-cols-3">
          <div>
            <label className="text-sm font-medium mb-1 block">Content Strategy</label>
            <Select value={strategy} onValueChange={setStrategy}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="luxury_showcase">Luxury Showcase</SelectItem>
                <SelectItem value="walkthrough">Walkthrough</SelectItem>
                <SelectItem value="testimonial">Testimonial</SelectItem>
                <SelectItem value="market_update">Market Update</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Tone</label>
            <Select value={tone} onValueChange={setTone}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="professional">Professional</SelectItem>
                <SelectItem value="friendly">Friendly</SelectItem>
                <SelectItem value="energetic">Energetic</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Duration (seconds)</label>
            <Select value={duration} onValueChange={setDuration}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="30">30 seconds</SelectItem>
                <SelectItem value="60">60 seconds</SelectItem>
                <SelectItem value="90">90 seconds</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <Textarea
          placeholder="Your video script will appear here..."
          value={scriptText}
          onChange={(e) => setScriptText(e.target.value)}
          rows={8}
          className="font-mono text-sm"
        />

        <Button onClick={handleGenerateScript} disabled={isGenerating} className="w-full">
          {isGenerating ? "Generating Script..." : "Generate Script with AI"}
        </Button>
      </CardContent>
    </Card>
  )
}
