"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Mic,
  Play,
  Pause,
  Download,
  Share2,
  Sparkles,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Plus,
  Radio,
  BarChart3,
} from "lucide-react"
import {
  createPodcastEpisode,
  generatePodcastAudio,
  getPodcastEpisodes,
  publishPodcastEpisode,
  trackPodcastEvent,
  getPodcastTemplates,
} from "@/app/actions/podcast-generation"

export function PodcastStudio() {
  const [activeTab, setActiveTab] = useState<"create" | "episodes" | "analytics">("create")
  const [episodes, setEpisodes] = useState<any[]>([])
  const [templates, setTemplates] = useState<any[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)

  // Create Form State
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [script, setScript] = useState("")
  const [keywords, setKeywords] = useState("")
  const [category, setCategory] = useState("market_update")
  const [selectedVoice, setSelectedVoice] = useState("default")
  const [useKeywords, setUseKeywords] = useState(false)

  // Audio Player State
  const [currentlyPlaying, setCurrentlyPlaying] = useState<string | null>(null)
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null)

  useEffect(() => {
    loadEpisodes()
    loadTemplates()
  }, [])

  const loadEpisodes = async () => {
    setIsLoading(true)
    const result = await getPodcastEpisodes()
    if (result.success) {
      setEpisodes(result.episodes)
    }
    setIsLoading(false)
  }

  const loadTemplates = async () => {
    const result = await getPodcastTemplates()
    if (result.success) {
      setTemplates(result.templates)
    }
  }

  const handleCreateEpisode = async () => {
    if (!title || (!script && !keywords)) return

    setIsGenerating(true)
    try {
      const result = await createPodcastEpisode({
        title,
        description,
        script: useKeywords ? undefined : script,
        keywords: useKeywords ? keywords.split(",").map((k) => k.trim()) : undefined,
        voiceId: selectedVoice,
        category,
      })

      if (result.success && result.episode) {
        // Automatically generate audio
        await generatePodcastAudio(result.episode.id)
        await loadEpisodes()

        // Reset form
        setTitle("")
        setDescription("")
        setScript("")
        setKeywords("")
        setActiveTab("episodes")
      }
    } catch (error) {
      console.error("[v0] Error creating podcast:", error)
    } finally {
      setIsGenerating(false)
    }
  }

  const handlePlayPause = (episodeId: string, audioUrl: string) => {
    if (currentlyPlaying === episodeId && audioElement) {
      audioElement.pause()
      setCurrentlyPlaying(null)
    } else {
      if (audioElement) {
        audioElement.pause()
      }
      const audio = new Audio(audioUrl)
      audio.play()
      setAudioElement(audio)
      setCurrentlyPlaying(episodeId)

      // Track play event
      trackPodcastEvent(episodeId, "play", { platform: "web" })

      audio.onended = () => {
        setCurrentlyPlaying(null)
        trackPodcastEvent(episodeId, "complete")
      }
    }
  }

  const handlePublish = async (episodeId: string) => {
    const result = await publishPodcastEpisode(episodeId, ["internal"])
    if (result.success) {
      await loadEpisodes()
    }
  }

  const getStatusBadge = (status: string) => {
    const statusConfig: any = {
      draft: { color: "bg-slate-100 text-slate-600", icon: AlertCircle },
      generating: { color: "bg-blue-100 text-blue-600", icon: Loader2 },
      completed: { color: "bg-emerald-100 text-emerald-600", icon: CheckCircle2 },
      published: { color: "bg-indigo-100 text-indigo-600", icon: Radio },
      failed: { color: "bg-red-100 text-red-600", icon: AlertCircle },
    }

    const config = statusConfig[status] || statusConfig.draft
    const Icon = config.icon

    return (
      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${config.color}`}>
        <Icon size={12} className={status === "generating" ? "animate-spin" : ""} />
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </span>
    )
  }

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, "0")}`
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">AI Podcast Studio</h2>
          <p className="text-sm text-slate-600">Create automated podcasts from scripts or keywords</p>
        </div>
        <Button onClick={() => setActiveTab("create")} className="bg-indigo-600 hover:bg-indigo-700">
          <Plus size={16} className="mr-2" />
          New Episode
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-200">
        <button
          onClick={() => setActiveTab("create")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === "create"
              ? "text-indigo-600 border-b-2 border-indigo-600"
              : "text-slate-600 hover:text-slate-900"
          }`}
        >
          Create
        </button>
        <button
          onClick={() => setActiveTab("episodes")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === "episodes"
              ? "text-indigo-600 border-b-2 border-indigo-600"
              : "text-slate-600 hover:text-slate-900"
          }`}
        >
          Episodes ({episodes.length})
        </button>
        <button
          onClick={() => setActiveTab("analytics")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === "analytics"
              ? "text-indigo-600 border-b-2 border-indigo-600"
              : "text-slate-600 hover:text-slate-900"
          }`}
        >
          Analytics
        </button>
      </div>

      {/* Create Tab */}
      {activeTab === "create" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Card className="p-6 space-y-4">
              <h3 className="text-lg font-bold text-slate-900">Episode Details</h3>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Weekly Market Update - January 2026"
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Description (Optional)</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="A brief summary of this episode..."
                  rows={2}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>

              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={!useKeywords}
                    onChange={() => setUseKeywords(false)}
                    className="text-indigo-600"
                  />
                  <span className="text-sm font-medium text-slate-700">Write Script</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={useKeywords}
                    onChange={() => setUseKeywords(true)}
                    className="text-indigo-600"
                  />
                  <span className="text-sm font-medium text-slate-700">Use Keywords</span>
                </label>
              </div>

              {useKeywords ? (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    Keywords (comma separated)
                  </label>
                  <input
                    type="text"
                    value={keywords}
                    onChange={(e) => setKeywords(e.target.value)}
                    placeholder="interest rates, new listings, buyer tips"
                    className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  />
                  <p className="text-xs text-slate-500 mt-2">AI will generate a podcast script from these keywords</p>
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Script</label>
                  <textarea
                    value={script}
                    onChange={(e) => setScript(e.target.value)}
                    placeholder="Write your podcast script here... Include intro, main content, and outro."
                    rows={12}
                    className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent font-mono text-sm"
                  />
                </div>
              )}
            </Card>
          </div>

          <div className="space-y-6">
            <Card className="p-6 space-y-4">
              <h3 className="text-lg font-bold text-slate-900">Settings</h3>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Category</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                >
                  <option value="market_update">Market Update</option>
                  <option value="listing_showcase">Listing Showcase</option>
                  <option value="buyer_guide">Buyer Guide</option>
                  <option value="seller_tips">Seller Tips</option>
                  <option value="neighborhood_spotlight">Neighborhood Spotlight</option>
                  <option value="custom">Custom</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Voice</label>
                <select
                  value={selectedVoice}
                  onChange={(e) => setSelectedVoice(e.target.value)}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                >
                  <option value="default">Professional Male</option>
                  <option value="female-1">Professional Female</option>
                  <option value="casual-male">Casual Male</option>
                  <option value="casual-female">Casual Female</option>
                </select>
              </div>

              <Button
                onClick={handleCreateEpisode}
                disabled={isGenerating || !title || (!script && !keywords)}
                className="w-full bg-indigo-600 hover:bg-indigo-700"
              >
                {isGenerating ? (
                  <>
                    <Loader2 size={16} className="mr-2 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Sparkles size={16} className="mr-2" />
                    Generate Podcast
                  </>
                )}
              </Button>
            </Card>

            <Card className="p-6 bg-indigo-50 border-indigo-200">
              <div className="flex items-start gap-3">
                <Mic size={20} className="text-indigo-600 mt-0.5 shrink-0" />
                <div className="text-sm text-indigo-900">
                  <p className="font-semibold mb-1">AI-Powered Voice Synthesis</p>
                  <p className="text-indigo-700">
                    Your podcast will be automatically generated with professional voice synthesis, including natural
                    pauses and intonation.
                  </p>
                </div>
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* Episodes Tab */}
      {activeTab === "episodes" && (
        <div className="space-y-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={32} className="animate-spin text-indigo-600" />
            </div>
          ) : episodes.length === 0 ? (
            <Card className="p-12 text-center">
              <Radio size={48} className="mx-auto text-slate-400 mb-4" />
              <h3 className="text-lg font-bold text-slate-900 mb-2">No Episodes Yet</h3>
              <p className="text-slate-600 mb-4">Create your first AI-generated podcast episode</p>
              <Button onClick={() => setActiveTab("create")} className="bg-indigo-600 hover:bg-indigo-700">
                <Plus size={16} className="mr-2" />
                Create Episode
              </Button>
            </Card>
          ) : (
            episodes.map((episode) => (
              <Card key={episode.id} className="p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-lg font-bold text-slate-900 truncate">{episode.title}</h3>
                      {getStatusBadge(episode.status)}
                    </div>
                    {episode.description && <p className="text-sm text-slate-600 mb-3">{episode.description}</p>}
                    <div className="flex items-center gap-4 text-xs text-slate-500">
                      <span className="capitalize">{episode.category?.replace("_", " ")}</span>
                      {episode.duration_seconds && <span>{formatDuration(episode.duration_seconds)}</span>}
                      {episode.play_count > 0 && <span>{episode.play_count} plays</span>}
                      <span>{new Date(episode.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {episode.status === "completed" && episode.audio_url && (
                      <>
                        <Button
                          onClick={() => handlePlayPause(episode.id, episode.audio_url)}
                          variant="outline"
                          size="sm"
                          className="bg-transparent"
                        >
                          {currentlyPlaying === episode.id ? <Pause size={14} /> : <Play size={14} />}
                        </Button>
                        <Button
                          onClick={() => {
                            const a = document.createElement("a")
                            a.href = episode.audio_url
                            a.download = `${episode.title}.mp3`
                            a.click()
                            trackPodcastEvent(episode.id, "download")
                          }}
                          variant="outline"
                          size="sm"
                          className="bg-transparent"
                        >
                          <Download size={14} />
                        </Button>
                        {episode.status !== "published" && (
                          <Button
                            onClick={() => handlePublish(episode.id)}
                            variant="outline"
                            size="sm"
                            className="bg-transparent"
                          >
                            <Radio size={14} className="mr-1" />
                            Publish
                          </Button>
                        )}
                      </>
                    )}
                    {episode.status === "generating" && (
                      <span className="text-xs text-blue-600 flex items-center gap-1">
                        <Loader2 size={14} className="animate-spin" />
                        Generating audio...
                      </span>
                    )}
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>
      )}

      {/* Analytics Tab */}
      {activeTab === "analytics" && (
        <Card className="p-8 text-center">
          <BarChart3 size={48} className="mx-auto text-slate-400 mb-4" />
          <h3 className="text-lg font-bold text-slate-900 mb-2">Analytics Coming Soon</h3>
          <p className="text-slate-600">Track plays, downloads, completion rates, and listener engagement</p>
        </Card>
      )}
    </div>
  )
}
