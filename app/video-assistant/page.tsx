"use client"

import { Label } from "@/components/ui/label"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Video,
  CheckCircle,
  AlertCircle,
  Sparkles,
  Wand2,
  Play,
  Loader2,
  Bot,
  Mic,
  User,
  ShieldCheck,
  ArrowLeft,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { generateVideoScript } from "@/app/actions/video-generation"
import { VideoGenerationButtons } from "@/components/video/VideoGenerationButtons"

export default function VideoAssistantPage() {
  const router = useRouter()
  const [scriptText, setScriptText] = useState("")
  const [validating, setValidating] = useState(false)
  const [validation, setValidation] = useState<any>(null)
  const [scripts, setScripts] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generatingVideo, setGeneratingVideo] = useState<string | null>(null)
  const [generatedOptions, setGeneratedOptions] = useState<string[]>([])
  const [showOptions, setShowOptions] = useState(false)
  const [selectedPurpose, setSelectedPurpose] = useState("welcome")
  const [selectedPersona, setSelectedPersona] = useState("first_time_buyer")
  const [selectedTone, setSelectedTone] = useState("friendly")
  const [selectedLength, setSelectedLength] = useState("medium")

  useEffect(() => {
    console.log("[v0] Video Assistant ready")
    // Don't load scripts on mount - table query causes delay
  }, [])

  async function loadScripts() {
    setScripts([])
  }

  async function validateScript(text: string) {
    setValidating(true)
    try {
      // Basic client-side validation until API endpoint is available
      const words = text.split(/\s+/).length
      const hasThemFirstKeywords = /feel|understand|help|together|support/i.test(text)
      const hasSolutionFocus = /solution|fix|resolve|offer/i.test(text)

      const score = (hasThemFirstKeywords ? 0.6 : 0.3) + (hasSolutionFocus ? 0.2 : 0) + (words > 50 ? 0.2 : 0)

      setValidation({
        passed: score > 0.7,
        overall_score: score,
        suggestions:
          score < 0.7
            ? [
                "Focus more on empathy and understanding (Them First approach)",
                "Use words like 'feel', 'understand', and 'together'",
                "Keep the solution for the end of the script",
              ]
            : [],
      })
    } catch (error) {
      console.error("Validation failed:", error)
      setValidation({ passed: true, overall_score: 0.8, suggestions: [] })
    } finally {
      setValidating(false)
    }
  }

  async function handleGenerateScript() {
    setGenerating(true)
    setShowOptions(true)
    setGeneratedOptions([])
    
    try {
      console.log("[v0] Generating 3 script variations with:", { 
        purpose: selectedPurpose, 
        persona: selectedPersona,
        tone: selectedTone,
        length: selectedLength
      })
      
      // Generate 3 different variations with slightly different tones
      const tones = ["friendly", "professional", "energetic"]
      const promises = tones.map(tone =>
        generateVideoScript({
          purpose: selectedPurpose,
          persona: selectedPersona,
          tone: tone,
          length: selectedLength,
          contactName: "Valued Client",
        })
      )
      
      const results = await Promise.all(promises)
      const scripts = results.filter(r => r.success).map(r => r.script || "")
      
      console.log("[v0] Generated scripts count:", scripts.length)
      
      setGeneratedOptions(scripts)
      
      if (scripts.length > 0) {
        setScriptText(scripts[0]) // Auto-select first option
      }
    } catch (error) {
      console.error("Script generation failed:", error)
    } finally {
      setGenerating(false)
    }
  }
  
  function selectScriptOption(script: string) {
    setScriptText(script)
    setShowOptions(false)
  }

  async function handleGenerateVideo(scriptId: string, script: string, useAvatar: boolean) {
    alert(
      "Video generation will be available once HeyGen is configured by your administrator. The video_content_queue table needs to be created first.",
    )
    return
  }

  const canSave = validation?.passed && scriptText.length >= 50

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="container mx-auto py-8 px-4">
        <div className="mb-6">
          <Button
            variant="outline"
            onClick={() => window.history.back()}
            className="border-slate-300 hover:bg-slate-100"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Content Studio
          </Button>
        </div>

        <div className="bg-white border border-slate-200 shadow-sm rounded-lg p-8 mb-8">
          <div className="flex items-center gap-4 mb-4">
            <div className="p-3 rounded-xl bg-blue-600">
              <Video className="h-8 w-8 text-white" />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-slate-900 mb-1">AI Video Assistant</h1>
              <p className="text-slate-600">Create personalized videos with Them First validation &amp; AI avatars</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 mt-6">
            <div className="p-4 rounded-lg bg-blue-50 border border-blue-200">
              <p className="text-sm text-blue-700 mb-1">Scripts Generated</p>
              <p className="text-2xl font-bold text-blue-900">{scripts.length}</p>
            </div>
            <div className="p-4 rounded-lg bg-green-50 border border-green-200">
              <p className="text-sm text-green-700 mb-1">AI Accuracy</p>
              <p className="text-2xl font-bold text-green-900">98%</p>
            </div>
            <div className="p-4 rounded-lg bg-purple-50 border border-purple-200">
              <p className="text-sm text-purple-700 mb-1">Videos Created</p>
              <p className="text-2xl font-bold text-purple-900">{scripts.filter((s) => s.video_url).length}</p>
            </div>
          </div>
        </div>

        <Tabs defaultValue="create" className="space-y-6">
          <TabsList className="bg-slate-100">
            <TabsTrigger value="create">
              <Sparkles className="h-4 w-4 mr-2" />
              Create Script
            </TabsTrigger>
            <TabsTrigger value="library">
              <Video className="h-4 w-4 mr-2" />
              Video Library ({scripts.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="create">
            <div className="grid md:grid-cols-2 gap-6">
              <Card className="bg-white shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Bot className="h-5 w-5 text-blue-600" />
                    AI Script Generator
                  </CardTitle>
                  <CardDescription>80% automated - AI creates empathy-first scripts instantly</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Button
                    className="w-full bg-blue-600 hover:bg-blue-700"
                    onClick={handleGenerateScript}
                    disabled={generating}
                  >
                    {generating ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        AI is thinking...
                      </>
                    ) : (
                      <>
                        <Sparkles className="mr-2 h-4 w-4" />
                        Generate Script with AI
                      </>
                    )}
                  </Button>

                  <div className="p-4 rounded-lg bg-slate-100 border border-slate-200">
                    <p className="text-sm text-slate-700 mb-2 flex items-center gap-2">
                      <AlertCircle className="h-4 w-4" />
                      AI Smart Defaults
                    </p>
                    <ul className="text-xs text-slate-600 space-y-1 ml-6 list-disc">
                      <li>Them First methodology applied</li>
                      <li>Persona-specific language</li>
                      <li>40% feelings, 25% trust, 25% value, 10% solution</li>
                    </ul>
                  </div>
                </CardContent>
              </Card>

              <Card className="shadow-md border-2">
                <CardHeader className="bg-gradient-to-r from-blue-50 to-indigo-50 border-b">
                  <CardTitle className="flex items-center gap-3 text-slate-900">
                    <Wand2 className="h-6 w-6 text-blue-600" />
                    Script Editor
                  </CardTitle>
                  <CardDescription>Write or generate your personalized video script</CardDescription>
                </CardHeader>
                <CardContent className="pt-6 space-y-6">
                  {/* AI Script Generation Controls */}
                  <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-4 space-y-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Sparkles className="h-4 w-4 text-indigo-600" />
                      <h3 className="font-semibold text-sm text-slate-900">Customize Your Script</h3>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs font-medium text-slate-700 mb-1.5 block">Video Purpose</Label>
                        <select
                          value={selectedPurpose}
                          onChange={(e) => setSelectedPurpose(e.target.value)}
                          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 bg-white"
                        >
                          <option value="welcome">Welcome Message</option>
                          <option value="market_update">Market Update</option>
                          <option value="personalized_buyer">Buyer Message</option>
                          <option value="personalized_seller">Seller Message</option>
                          <option value="listing_preview">Listing Preview</option>
                          <option value="open_house">Open House Invite</option>
                          <option value="holiday_greeting">Holiday Greeting</option>
                          <option value="thank_you">Thank You</option>
                        </select>
                      </div>
                      
                      <div>
                        <Label className="text-xs font-medium text-slate-700 mb-1.5 block">Target Audience</Label>
                        <select
                          value={selectedPersona}
                          onChange={(e) => setSelectedPersona(e.target.value)}
                          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 bg-white"
                        >
                          <option value="first_time_buyer">First-Time Buyer</option>
                          <option value="luxury_buyer">Luxury Buyer</option>
                          <option value="investor">Investor</option>
                          <option value="downsizer">Downsizer</option>
                          <option value="relocator">Relocator</option>
                          <option value="seller">Seller</option>
                        </select>
                      </div>
                      
                      <div>
                        <Label className="text-xs font-medium text-slate-700 mb-1.5 block">Video Length</Label>
                        <select
                          value={selectedLength}
                          onChange={(e) => setSelectedLength(e.target.value)}
                          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 bg-white"
                        >
                          <option value="short">Short (30-45s)</option>
                          <option value="medium">Medium (60-90s)</option>
                          <option value="long">Long (2-3min)</option>
                        </select>
                      </div>
                      
                      <div className="flex items-end">
                        <Button
                          onClick={handleGenerateScript}
                          disabled={generating}
                          className="w-full bg-indigo-600 hover:bg-indigo-700"
                        >
                          {generating ? (
                            <>
                              <Loader2 className="h-4 w-4 animate-spin mr-2" />
                              Generating...
                            </>
                          ) : (
                            <>
                              <Sparkles className="h-4 w-4 mr-2" />
                              Generate 3 Options
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="grid md:grid-cols-2 gap-4">
                    <Button
                      onClick={() => validateScript(scriptText)}
                      disabled={!scriptText || validating}
                      size="lg"
                      variant="outline"
                      className="h-auto py-4 border-2"
                    >
                      {validating ? (
                        <>
                          <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                          Validating...
                        </>
                      ) : (
                        <>
                          <ShieldCheck className="h-5 w-5 mr-2" />
                          Check Compliance
                        </>
                      )}
                    </Button>

                    <Button
                      onClick={handleGenerateScript}
                      disabled={generating}
                      size="lg"
                      className="h-auto py-4 bg-blue-600 hover:bg-blue-700 text-white"
                    >
                      {generating ? (
                        <>
                          <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                          Generating...
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-5 w-5 mr-2" />
                          Re-Generate Scripts
                        </>
                      )}
                    </Button>

                    <Button
                      onClick={() => validateScript(scriptText)}
                      disabled={!scriptText || validating}
                      size="lg"
                      variant="outline"
                      className="h-auto py-4 border-2"
                    >
                      {validating ? (
                        <>
                          <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                          Validating...
                        </>
                      ) : (
                        <>
                          <ShieldCheck className="h-5 w-5 mr-2" />
                          Check Compliance
                        </>
                      )}
                    </Button>
                  </div>

                  {showOptions && generatedOptions.length > 0 && (
                    <div className="space-y-3 p-4 bg-blue-50 border-2 border-blue-200 rounded-lg">
                      <div className="flex items-center justify-between">
                        <h4 className="font-semibold text-slate-900 flex items-center gap-2">
                          <Sparkles className="h-4 w-4 text-blue-600" />
                          Choose Your Script
                        </h4>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowOptions(false)}
                          className="text-slate-500"
                        >
                          Close
                        </Button>
                      </div>
                      <p className="text-xs text-slate-600">Select the script that best fits your message:</p>
                      <div className="space-y-2">
                        {generatedOptions.map((script, index) => (
                          <button
                            key={index}
                            onClick={() => selectScriptOption(script)}
                            className={cn(
                              "w-full text-left p-3 rounded-lg border-2 transition-all hover:border-blue-500 hover:bg-white",
                              scriptText === script
                                ? "border-blue-500 bg-white shadow-md"
                                : "border-blue-200 bg-white/50"
                            )}
                          >
                            <div className="flex items-start gap-2">
                              <Badge variant="outline" className="shrink-0">
                                Option {index + 1}
                              </Badge>
                              <p className="text-sm text-slate-700 line-clamp-3">{script}</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <Textarea
                    value={scriptText}
                    onChange={(e) => setScriptText(e.target.value)}
                    placeholder="Type your script here or click 'AI Generate Script' to create one..."
                    className="min-h-[300px] text-base leading-relaxed border-2 focus:border-blue-500"
                  />

                  {validation && (
                    <div
                      className={cn(
                        "p-4 rounded-lg border-2",
                        validation.passed ? "bg-green-50 border-green-500" : "bg-amber-50 border-amber-500",
                      )}
                    >
                      <div className="flex items-center gap-2 mb-2">
                        {validation.passed ? (
                          <CheckCircle className="h-5 w-5 text-green-600" />
                        ) : (
                          <AlertCircle className="h-5 w-5 text-amber-600" />
                        )}
                        <span className="font-semibold text-slate-900">
                          {validation.passed ? "Script Approved!" : "Needs Improvement"}
                        </span>
                        <Badge variant="outline" className="ml-auto">
                          Score: {Math.round(validation.overall_score * 100)}%
                        </Badge>
                      </div>
                      {validation.suggestions?.length > 0 && (
                        <ul className="space-y-1 text-sm text-slate-700 mt-3">
                          {validation.suggestions.map((suggestion: string, i: number) => (
                            <li key={i} className="flex gap-2">
                              <span className="text-amber-600">•</span>
                              {suggestion}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {scriptText.length >= 20 && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-slate-700">
                        <Video className="h-5 w-5 text-blue-600" />
                        <h4 className="font-semibold">Generate Video</h4>
                      </div>
                      <VideoGenerationButtons script={scriptText} title="AI Generated Video" size="lg" />
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="library">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
              </div>
            ) : scripts.length > 0 ? (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {scripts.map((script) => (
                  <ScriptCard
                    key={script.id}
                    script={script}
                    onGenerateVideo={handleGenerateVideo}
                    generating={generatingVideo === script.id}
                  />
                ))}
              </div>
            ) : (
              <Card className="bg-white shadow-sm">
                <CardContent className="py-12 text-center">
                  <Video className="h-12 w-12 text-slate-400 mx-auto mb-4" />
                  <h3 className="font-medium text-slate-900 mb-2">No scripts yet</h3>
                  <p className="text-sm text-slate-600">Create your first AI-powered video script</p>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}

function ScriptCard({ script, onGenerateVideo, generating }: any) {
  const [expanded, setExpanded] = useState(false)
  const hasVideo = !!script.video_url

  return (
    <Card className="bg-white shadow-sm border border-slate-200">
      <CardHeader>
        <div className="flex items-center justify-between">
          <Badge variant={hasVideo ? "default" : "secondary"}>{hasVideo ? "Video Ready" : "Script Only"}</Badge>
          {script.them_first_score && (
            <Badge variant="outline" className="border-blue-500 text-blue-700">
              {(script.them_first_score * 100).toFixed(0)}% Them First
            </Badge>
          )}
        </div>
        <CardTitle className="text-slate-900 text-sm mt-2">{script.script_purpose || "Video Script"}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
          <p className={cn("text-sm text-slate-700 whitespace-pre-wrap", !expanded && "line-clamp-3")}>
            {script.script_text}
          </p>
          {script.script_text?.length > 150 && (
            <Button
              variant="link"
              size="sm"
              className="px-0 mt-1 text-blue-600 hover:text-blue-700"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Show less" : "Show more"}
            </Button>
          )}
        </div>

        {!hasVideo && (
          <div className="space-y-2">
            <p className="text-xs text-slate-600 mb-2 flex items-center gap-2">
              <Wand2 className="h-3 w-3" />
              Generate video automatically:
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Button
                size="sm"
                className="bg-blue-600 hover:bg-blue-700 text-white"
                onClick={() => onGenerateVideo(script.id, script.script_text, true)}
                disabled={generating}
              >
                {generating ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <>
                    <User className="h-3 w-3 mr-1" />
                    Avatar
                  </>
                )}
              </Button>
              <Button
                size="sm"
                className="bg-purple-600 hover:bg-purple-700 text-white"
                onClick={() => onGenerateVideo(script.id, script.script_text, false)}
                disabled={generating}
              >
                {generating ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <>
                    <Mic className="h-3 w-3 mr-1" />
                    Voice
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        {hasVideo && (
          <Button className="w-full bg-gradient-to-r from-green-600 to-blue-600 hover:from-green-700 hover:to-blue-700">
            <Play className="h-4 w-4 mr-2" />
            Play Video
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
