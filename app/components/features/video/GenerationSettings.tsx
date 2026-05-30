"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { updateVideoGenerationSettingsAction } from "@/app/actions/video"

export function GenerationSettings({ projectId }: { projectId: string }) {
  const [voiceProfile, setVoiceProfile] = useState("default")
  const [avatarStyle, setAvatarStyle] = useState<"professional" | "casual" | "luxury">("professional")
  const [subtitles, setSubtitles] = useState(true)
  const [watermark, setWatermark] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  async function handleSave() {
    setIsSaving(true)
    await updateVideoGenerationSettingsAction({
      projectId,
      voiceProfileId: voiceProfile,
      avatarStyle,
      subtitles,
      watermark,
    })
    setIsSaving(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Generation Settings</CardTitle>
        <CardDescription>Configure video generation parameters</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <label className="text-sm font-medium mb-2 block">Voice Profile</label>
          <Select value={voiceProfile} onValueChange={setVoiceProfile}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Default Professional</SelectItem>
              <SelectItem value="warm">Warm & Friendly</SelectItem>
              <SelectItem value="energetic">Energetic</SelectItem>
              <SelectItem value="luxury">Luxury</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="text-sm font-medium mb-2 block">Avatar Style</label>
          <Select value={avatarStyle} onValueChange={(v) => setAvatarStyle(v as "professional" | "casual" | "luxury")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="professional">Professional</SelectItem>
              <SelectItem value="casual">Casual</SelectItem>
              <SelectItem value="luxury">Luxury</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Checkbox id="subtitles" checked={subtitles} onCheckedChange={(checked) => setSubtitles(Boolean(checked))} />
            <label htmlFor="subtitles" className="text-sm font-medium cursor-pointer">
              Include Subtitles
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="watermark" checked={watermark} onCheckedChange={(v) => setWatermark(v === true)} />
            <label htmlFor="watermark" className="text-sm font-medium cursor-pointer">
              Add Watermark
            </label>
          </div>
        </div>

        <Button onClick={handleSave} disabled={isSaving} className="w-full">
          {isSaving ? "Saving..." : "Save Settings"}
        </Button>
      </CardContent>
    </Card>
  )
}
