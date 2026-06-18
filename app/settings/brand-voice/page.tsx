"use client"

import { useState, useEffect, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Loader2, Mic, Save, X, Plus } from "lucide-react"
import { getBrandVoiceProfile, updateBrandVoiceProfile } from "@/app/actions/ai-content-generation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"

const TONE_OPTIONS = [
  { value: "professional", label: "Professional" },
  { value: "professional yet approachable", label: "Professional yet Approachable" },
  { value: "warm and friendly", label: "Warm & Friendly" },
  { value: "authoritative", label: "Authoritative" },
  { value: "conversational", label: "Conversational" },
  { value: "luxury", label: "Luxury & Sophisticated" },
  { value: "energetic", label: "Energetic & Enthusiastic" },
]

const STYLE_OPTIONS = [
  { value: "conversational", label: "Conversational" },
  { value: "formal", label: "Formal" },
  { value: "storytelling", label: "Storytelling" },
  { value: "data-driven", label: "Data-Driven" },
  { value: "empathetic", label: "Empathetic" },
  { value: "direct", label: "Direct & Concise" },
]

export default function BrandVoicePage() {
  const [agentId, setAgentId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [isPending, startTransition] = useTransition()

  const [tone, setTone] = useState("")
  const [style, setStyle] = useState("")
  const [brandPersonality, setBrandPersonality] = useState("")
  const [targetAudience, setTargetAudience] = useState("")
  const [keywordsText, setKeywordsText] = useState("")
  const [avoidWordsText, setAvoidWordsText] = useState("")
  const [examplePostsText, setExamplePostsText] = useState("")

  useEffect(() => {
    const load = async () => {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setLoading(false); return }
      setAgentId(user.id)
      const profile = await getBrandVoiceProfile(user.id)
      if (profile) {
        setTone(profile.tone ?? "")
        setStyle(profile.style ?? "")
        setBrandPersonality(profile.brand_personality ?? "")
        setTargetAudience(profile.target_audience ?? "")
        setKeywordsText((profile.preferred_words ?? []).join(", "))
        setAvoidWordsText((profile.prohibited_words ?? []).join(", "))
        setExamplePostsText((profile.tone_examples ?? []).join("\n\n"))
      }
      setLoading(false)
    }
    load().catch(() => {
      setLoading(false)
      toast.error("Failed to load brand voice profile")
    })
  }, [])

  const handleSave = () => {
    if (!agentId) return
    startTransition(async () => {
      try {
        const keywords = keywordsText.split(",").map(s => s.trim()).filter(Boolean)
        const avoidWords = avoidWordsText.split(",").map(s => s.trim()).filter(Boolean)
        const examplePosts = examplePostsText.split("\n\n").map(s => s.trim()).filter(Boolean)

        const result = await updateBrandVoiceProfile({
          agentId,
          tone,
          style,
          brandPersonality,
          targetAudience,
          keywords,
          avoidWords,
          examplePosts,
        })

        if ((result as any)?.error) {
          toast.error("Failed to save brand voice profile")
        } else {
          toast.success("Brand voice profile saved")
        }
      } catch {
        toast.error("Failed to save brand voice profile")
      }
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Mic className="h-6 w-6 text-primary" />
            Brand Voice
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Define how AI generates content in your name
          </p>
        </div>
        <Button onClick={handleSave} disabled={isPending || !agentId}>
          {isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
          Save Profile
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Tone</CardTitle>
          </CardHeader>
          <CardContent>
            <Select value={tone} onValueChange={setTone}>
              <SelectTrigger>
                <SelectValue placeholder="Select tone..." />
              </SelectTrigger>
              <SelectContent>
                {TONE_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Writing Style</CardTitle>
          </CardHeader>
          <CardContent>
            <Select value={style} onValueChange={setStyle}>
              <SelectTrigger>
                <SelectValue placeholder="Select style..." />
              </SelectTrigger>
              <SelectContent>
                {STYLE_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Brand Personality</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            placeholder="Describe your brand personality in 2-3 sentences. E.g., 'I'm a trusted neighborhood expert who makes buying and selling feel effortless. I combine data-driven insights with genuine care for my clients.'"
            value={brandPersonality}
            onChange={e => setBrandPersonality(e.target.value)}
            rows={3}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Target Audience</CardTitle>
        </CardHeader>
        <CardContent>
          <Input
            placeholder="E.g., First-time buyers in their 30s, move-up buyers, luxury buyers..."
            value={targetAudience}
            onChange={e => setTargetAudience(e.target.value)}
          />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Preferred Keywords</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Textarea
              placeholder="expertise, local market, trusted advisor, personalized service"
              value={keywordsText}
              onChange={e => setKeywordsText(e.target.value)}
              rows={3}
            />
            <p className="text-xs text-muted-foreground">Comma-separated words to use in your content</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Words to Avoid</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Textarea
              placeholder="cheap, deal, discount, aggressive"
              value={avoidWordsText}
              onChange={e => setAvoidWordsText(e.target.value)}
              rows={3}
            />
            <p className="text-xs text-muted-foreground">Comma-separated words to exclude from AI content</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Example Posts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Textarea
            placeholder={`Paste 1-3 sample social posts or emails that sound like you.\n\nSeparate each example with a blank line.`}
            value={examplePostsText}
            onChange={e => setExamplePostsText(e.target.value)}
            rows={8}
          />
          <p className="text-xs text-muted-foreground">These examples help AI match your voice exactly</p>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isPending || !agentId} size="lg">
          {isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
          Save Brand Voice Profile
        </Button>
      </div>
    </div>
  )
}
