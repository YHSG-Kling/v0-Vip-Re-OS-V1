'use client'

import { useState, useEffect, useRef, useTransition } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { createResourceAction } from "@/app/actions/education-kernel"
import {
  generateText,
  generateVideo,
  // Wave 4 slice 2 — these three were orphaned exports of the same gated
  // module the two above already come from. generateAudio adds the podcast
  // format (the learning-modules console already offers a Podcast channel);
  // generateFromURL is the repurpose-an-existing-article lane; the two reads
  // give the author the ledger of what they have already spent AI budget on.
  generateAudio,
  generateFromURL,
  getGenerationHistory,
  getGenerationStats,
} from "@/app/actions/content-generation-engine"
import { getDidAvatars, createTalkingPhotoVideo, type AvatarOption } from "@/app/actions/avatar-voice-catalog"
import { generateAvatarVideo, getAvatarVideoStatus } from "@/app/actions/external-services"
import { createClient } from "@/lib/supabase/client"
import { toast } from "sonner"
import { Sparkles, Video, Loader2, RefreshCw, History } from 'lucide-react'

type Tab = "create" | "ai-generate" | "avatar-video" | "photo-video"

export function EducationEditor({ brokerageId }: { brokerageId: string }) {
  const [tab, setTab] = useState<Tab>("create")
  const [agentId, setAgentId] = useState<string | null>(null)

  // Create tab state
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [contentType, setContentType] = useState('article')
  const [content, setContent] = useState('')
  const [minutes, setMinutes] = useState(5)
  const [loading, setLoading] = useState(false)

  // AI generate tab state
  const [aiTopic, setAiTopic] = useState('')
  const [aiAudience, setAiAudience] = useState<string>('agent')
  const [aiMode, setAiMode] = useState<'article' | 'script' | 'podcast' | 'url'>('article')
  const [aiSourceUrl, setAiSourceUrl] = useState('')
  const [aiResult, setAiResult] = useState('')
  const [isGenerating, startGenerating] = useTransition()

  // AI generation ledger — what this author has already generated, and what it
  // has cost in volume. Both reads are session-scoped inside the action
  // (resolveAuthorizedAgentId); nothing here names an agent.
  const [genStats, setGenStats] = useState<{
    total_generated: number
    by_content_type: Record<string, number>
    recent_generations: number
  } | null>(null)
  const [genHistory, setGenHistory] = useState<any[]>([])
  const [ledgerError, setLedgerError] = useState<string | null>(null)

  // Photo video tab state
  const [photoUrl, setPhotoUrl] = useState('')
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [photoScript, setPhotoScript] = useState('')
  const [photoVideoJobId, setPhotoVideoJobId] = useState<string | null>(null)
  const [photoVideoStatus, setPhotoVideoStatus] = useState<string | null>(null)
  const [photoVideoUrl, setPhotoVideoUrl] = useState<string | null>(null)
  const [isCreatingPhotoVideo, startCreatePhotoVideo] = useTransition()
  const photoPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Avatar video tab state
  const [avatars, setAvatars] = useState<AvatarOption[]>([])
  const [avatarsLoading, setAvatarsLoading] = useState(false)
  const [selectedAvatar, setSelectedAvatar] = useState<string>('')
  const [selectedVoice, setSelectedVoice] = useState<string>('')
  const [videoScript, setVideoScript] = useState('')
  const [videoJobId, setVideoJobId] = useState<string | null>(null)
  const [videoStatus, setVideoStatus] = useState<string | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [isCreatingVideo, startCreateVideo] = useTransition()
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data }: { data: { user: { id: string } | null } }) => setAgentId(data.user?.id ?? null))
  }, [])

  useEffect(() => {
    if (tab !== 'avatar-video' || avatars.length > 0) return
    setAvatarsLoading(true)
    getDidAvatars().then(({ avatars: list }) => {
      setAvatars(list)
      setAvatarsLoading(false)
    })
  }, [tab])

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      await createResourceAction({ title, description, contentType, content, estimatedMinutes: minutes, brokerageId })
      setTitle(''); setDescription(''); setContent('')
      toast.success('Resource created')
    } catch {
      toast.error('Failed to create resource')
    } finally {
      setLoading(false)
    }
  }

  const MODE_LABEL: Record<string, string> = {
    article: 'Article',
    script: 'Video Script',
    podcast: 'Podcast Script',
    url: 'Repurposed Article',
  }

  // Refresh the generation ledger. Errors are shown, not swallowed — an
  // unreadable ledger must not render as "you have generated nothing".
  const refreshGenerationLedger = async () => {
    setLedgerError(null)
    const [statsRes, historyRes] = await Promise.all([
      getGenerationStats({}).catch(() => null),
      getGenerationHistory({ limit: 10 }).catch(() => null),
    ])
    if (statsRes?.success && statsRes.stats) setGenStats(statsRes.stats)
    else if (statsRes && !statsRes.success) setLedgerError(statsRes.error ?? 'Could not read your generation stats')
    if (historyRes?.success && historyRes.history) setGenHistory(historyRes.history)
    else if (historyRes && !historyRes.success) {
      setLedgerError((prev) => prev ?? historyRes.error ?? 'Could not read your generation history')
    }
  }

  useEffect(() => {
    if (tab === 'ai-generate') void refreshGenerationLedger()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const handleAIGenerate = () => {
    if (!agentId) { toast.error('Finishing your account setup — try again in a moment'); return }
    if (aiMode === 'url') {
      if (!aiSourceUrl.trim()) { toast.error('Paste the article URL to repurpose'); return }
    } else if (!aiTopic) {
      toast.error('Enter a topic first'); return
    }
    startGenerating(async () => {
      let text = ''
      if (aiMode === 'url') {
        const result = await generateFromURL({
          agent_id: agentId,
          source_url: aiSourceUrl.trim(),
          content_type: 'blog',
          custom_instructions: `Rewrite this as an educational article for real estate ${aiAudience}s.`,
        })
        if (!result.success) {
          toast.error(result.error ?? 'Failed to generate content')
          return
        }
        text = (result as any).content?.raw_content ?? (result as any).content?.body ?? ''
      } else if (aiMode === 'podcast') {
        const result = await generateAudio({
          agent_id: agentId,
          content_type: 'podcast_script',
          duration_minutes: 10,
          custom_prompt: `Write a podcast script for real estate ${aiAudience}s about: ${aiTopic}`,
          target_audience: aiAudience,
        })
        if (!result.success) {
          toast.error(result.error ?? 'Failed to generate content')
          return
        }
        text = (result as any).content?.raw_content ?? (result as any).content?.script ?? ''
      } else if (aiMode === 'article') {
        const result = await generateText({
          agent_id: agentId,
          content_type: 'blog',
          custom_prompt: `Create an educational article for real estate ${aiAudience}s about: ${aiTopic}`,
          target_audience: aiAudience,
          length: 'medium',
        })
        if (!result.success) {
          toast.error(result.error ?? 'Failed to generate content')
          return
        }
        // The generator returns its text in content.raw_content (not .body).
        text = (result as any).content?.raw_content ?? (result as any).content?.body ?? (result as any).body ?? ''
      } else {
        const result = await generateVideo({
          agent_id: agentId,
          content_type: 'video_script',
          custom_prompt: `Write a video script for real estate ${aiAudience}s about: ${aiTopic}`,
          target_audience: aiAudience,
        })
        if (!result.success) {
          toast.error(result.error ?? 'Failed to generate content')
          return
        }
        // Video scripts also come back in content.raw_content (not .script).
        text = (result as any).content?.raw_content ?? (result as any).content?.script ?? (result as any).script ?? ''
      }
      setAiResult(text)
      // Only claim success when we actually captured content to show + save.
      if (text.trim()) toast.success('Content generated')
      else toast.error('The generator returned no content — try a different topic')
      // Every branch above logged a generation; keep the ledger truthful.
      void refreshGenerationLedger()
    })
  }

  const handleSaveAIContent = async () => {
    if (!aiResult || (!aiTopic && !aiSourceUrl)) { toast.error('No content to save'); return }
    setLoading(true)
    try {
      await createResourceAction({
        title: aiTopic || aiSourceUrl,
        description: `AI-generated ${MODE_LABEL[aiMode] ?? aiMode} for ${aiAudience}s`,
        // A podcast script is saved on the podcast channel, not mislabelled as
        // an article — learning_modules.channels already carries "podcast".
        contentType:
          aiMode === 'script' ? 'video' : aiMode === 'podcast' ? 'podcast' : 'article',
        content: aiResult,
        estimatedMinutes: aiMode === 'podcast' ? 10 : aiMode === 'article' || aiMode === 'url' ? 5 : 3,
        brokerageId,
      })
      toast.success('Saved to education library')
      setAiTopic(''); setAiResult(''); setAiSourceUrl('')
    } catch {
      toast.error('Failed to save')
    } finally {
      setLoading(false)
    }
  }

  const handleGeneratePhotoVideo = () => {
    if (!photoUrl || !photoScript) { toast.error('Enter a photo URL and script'); return }
    startCreatePhotoVideo(async () => {
      const result = await createTalkingPhotoVideo({ photoUrl, script: photoScript, voiceId: 'default' })
      if (!result.success || !result.videoId) {
        toast.error(result.error ?? 'Failed to start video generation')
        return
      }
      setPhotoVideoJobId(result.videoId)
      setPhotoVideoStatus('processing')
      toast.success('Video generation started — checking status…')
      let pollAttempts = 0
      photoPollRef.current = setInterval(async () => {
        pollAttempts++
        const statusResult = await getAvatarVideoStatus(result.videoId!)
        if (!statusResult.success) return
        if ((statusResult as any).status === 'completed') {
          clearInterval(photoPollRef.current!)
          setPhotoVideoStatus('completed')
          setPhotoVideoUrl((statusResult as any).videoUrl ?? null)
          toast.success('Video ready!')
        } else if ((statusResult as any).status === 'failed' || pollAttempts >= 60) {
          clearInterval(photoPollRef.current!)
          setPhotoVideoStatus('failed')
          toast.error(pollAttempts >= 60 ? 'Video generation timed out' : 'Video generation failed')
        }
      }, 10_000)
    })
  }

  const handleGenerateVideo = () => {
    if (!selectedAvatar || !videoScript) { toast.error('Select an avatar and enter a script'); return }
    startCreateVideo(async () => {
      const result = await generateAvatarVideo({
        avatarId: selectedAvatar,
        voiceId: selectedVoice || 'default',
        script: videoScript,
      })
      if (!result.success || !result.videoId) {
        toast.error(result.error ?? 'Failed to start video generation')
        return
      }
      setVideoJobId(result.videoId)
      setVideoStatus('processing')
      toast.success('Video generation started — checking status…')
      let pollAttempts = 0
      let consecutiveErrors = 0
      const MAX_POLL_ATTEMPTS = 60 // 10 minutes at 10s intervals
      const MAX_CONSECUTIVE_ERRORS = 5 // tolerate up to 5 transient errors before giving up
      pollRef.current = setInterval(async () => {
        pollAttempts++
        const statusResult = await getAvatarVideoStatus(result.videoId!)
        if (!statusResult.success) {
          consecutiveErrors++
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            clearInterval(pollRef.current!)
            setVideoStatus('failed')
            toast.error(statusResult.error ?? 'Failed to check video status')
          }
          // transient error — keep polling
          return
        }
        consecutiveErrors = 0 // reset on successful status check
        if ((statusResult as any).status === 'completed') {
          clearInterval(pollRef.current!)
          setVideoStatus('completed')
          setVideoUrl((statusResult as any).videoUrl ?? null)
          toast.success('Video ready!')
        } else if ((statusResult as any).status === 'failed') {
          clearInterval(pollRef.current!)
          setVideoStatus('failed')
          toast.error('Video generation failed')
        } else if (pollAttempts >= MAX_POLL_ATTEMPTS) {
          clearInterval(pollRef.current!)
          setVideoStatus('failed')
          toast.error('Video generation timed out after 10 minutes')
        }
      }, 10_000)
    })
  }

  const handleSaveVideo = async () => {
    if (!videoUrl || !videoScript) return
    setLoading(true)
    try {
      await createResourceAction({
        title: `Avatar Video - ${new Date().toLocaleDateString()}`,
        description: videoScript.slice(0, 120),
        contentType: 'video',
        content: videoUrl,
        estimatedMinutes: 3,
        brokerageId,
      })
      toast.success('Video saved to education library')
      setVideoJobId(null); setVideoStatus(null); setVideoUrl(null); setVideoScript('')
    } catch {
      toast.error('Failed to save video')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create Education Resource</CardTitle>
        <div className="flex gap-2 mt-2">
          {(['create', 'ai-generate', 'avatar-video', 'photo-video'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
                tab === t ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/80 text-muted-foreground'
              }`}
            >
              {t === 'create' ? 'Manual' : t === 'ai-generate' ? '✨ AI Generate' : t === 'avatar-video' ? '🎬 Avatar Video' : '📸 Photo Video'}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {/* Manual create tab */}
        {tab === 'create' && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Title</label>
              <input type="text" value={title} onChange={e => setTitle(e.target.value)}
                className="w-full border rounded px-3 py-2" required />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Description</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)}
                className="w-full border rounded px-3 py-2" rows={2} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Content Type</label>
              <select value={contentType} onChange={e => setContentType(e.target.value)}
                className="w-full border rounded px-3 py-2">
                <option>article</option>
                <option>video</option>
                <option>interactive</option>
                <option>assessment</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Content</label>
              <textarea value={content} onChange={e => setContent(e.target.value)}
                className="w-full border rounded px-3 py-2" rows={4} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Estimated Minutes</label>
              <input type="number" value={minutes} onChange={e => setMinutes(parseInt(e.target.value))}
                className="w-full border rounded px-3 py-2" />
            </div>
            <Button type="submit" disabled={loading}>
              {loading ? 'Creating...' : 'Create Resource'}
            </Button>
          </form>
        )}

        {/* AI generate tab */}
        {tab === 'ai-generate' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Topic</label>
              <input
                type="text"
                value={aiTopic}
                onChange={e => setAiTopic(e.target.value)}
                placeholder="e.g. How to prepare your home for a showing"
                className="w-full border rounded px-3 py-2"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Audience</label>
                <select value={aiAudience} onChange={e => setAiAudience(e.target.value)}
                  className="w-full border rounded px-3 py-2">
                  <option value="buyer">Buyer</option>
                  <option value="seller">Seller</option>
                  <option value="agent">Agent</option>
                  <option value="general">General</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Format</label>
                <select value={aiMode} onChange={e => setAiMode(e.target.value as 'article' | 'script' | 'podcast' | 'url')}
                  className="w-full border rounded px-3 py-2">
                  <option value="article">Article</option>
                  <option value="script">Video Script</option>
                  <option value="podcast">Podcast Script</option>
                  <option value="url">Repurpose from a URL</option>
                </select>
              </div>
            </div>
            {aiMode === 'url' && (
              <div>
                <label className="block text-sm font-medium mb-1">Source article URL</label>
                <input
                  type="url"
                  value={aiSourceUrl}
                  onChange={e => setAiSourceUrl(e.target.value)}
                  placeholder="https://…"
                  className="w-full border rounded px-3 py-2"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  The article is rewritten as an education lesson for the audience above.
                </p>
              </div>
            )}
            <Button onClick={handleAIGenerate} disabled={isGenerating || !agentId}>
              {isGenerating ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1.5" />}
              Generate {MODE_LABEL[aiMode] ?? 'Content'}
            </Button>
            {aiResult && (
              <div className="space-y-3">
                <textarea
                  value={aiResult}
                  onChange={e => setAiResult(e.target.value)}
                  className="w-full border rounded px-3 py-2 text-sm"
                  rows={10}
                />
                <Button onClick={handleSaveAIContent} disabled={loading} variant="outline">
                  Save to Education Library
                </Button>
              </div>
            )}

            {/* AI generation ledger — what this author has already generated.
                Every generation above costs AI budget, and until now there was
                no way to see what had been spent it on. */}
            <div className="border-t pt-4 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium flex items-center gap-1.5">
                  <History className="h-4 w-4" />
                  Your AI generations
                </p>
                <Button variant="ghost" size="sm" onClick={() => void refreshGenerationLedger()}>
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </div>

              {ledgerError && (
                <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
                  {ledgerError}
                </p>
              )}

              {genStats && (
                <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                  <span><span className="font-semibold text-foreground">{genStats.total_generated}</span> total</span>
                  <span><span className="font-semibold text-foreground">{genStats.recent_generations}</span> recent</span>
                  {Object.entries(genStats.by_content_type ?? {}).map(([k, v]) => (
                    <span key={k}>{k.replace(/_/g, ' ')}: <span className="font-semibold text-foreground">{v}</span></span>
                  ))}
                </div>
              )}

              {genHistory.length > 0 ? (
                <ul className="divide-y text-xs max-h-48 overflow-y-auto">
                  {genHistory.map((h: any, i: number) => (
                    // Real row shape from getContentGenerationHistory: the rows
                    // are `activities` (title/description/activity_type/notes/
                    // completed_at) — NOT content_type/created_at.
                    <li key={h?.id ?? i} className="py-1.5 flex items-center justify-between gap-3">
                      <span className="truncate">{h?.title ?? h?.activity_type?.replace(/_/g, ' ') ?? 'content'}</span>
                      <span className="text-muted-foreground shrink-0">
                        {h?.completed_at ? new Date(h.completed_at).toLocaleDateString() : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                !ledgerError && (
                  <p className="text-xs text-muted-foreground">Nothing generated yet.</p>
                )
              )}
            </div>
          </div>
        )}

        {/* Photo video tab */}
        {tab === 'photo-video' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Photo URL</label>
              <input
                type="url"
                value={photoUrl}
                onChange={e => { setPhotoUrl(e.target.value); setPhotoPreview(e.target.value || null) }}
                placeholder="https://example.com/your-headshot.jpg"
                className="w-full border rounded px-3 py-2 text-sm"
              />
              {photoPreview && (
                <div className="mt-2">
                  <img
                    src={photoPreview}
                    alt="Photo preview"
                    className="h-32 w-32 object-cover rounded-lg border"
                    onError={() => setPhotoPreview(null)}
                  />
                </div>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Script</label>
              <textarea
                value={photoScript}
                onChange={e => setPhotoScript(e.target.value)}
                placeholder="Enter the script for your talking photo video…"
                className="w-full border rounded px-3 py-2 text-sm"
                rows={5}
              />
            </div>
            {photoVideoStatus === null && (
              <Button onClick={handleGeneratePhotoVideo} disabled={isCreatingPhotoVideo || !photoUrl || !photoScript}>
                {isCreatingPhotoVideo ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Video className="h-4 w-4 mr-1.5" />}
                Create Video from Photo
              </Button>
            )}
            {photoVideoStatus === 'processing' && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin" />
                Processing video — checking every 10s…
              </div>
            )}
            {photoVideoStatus === 'completed' && photoVideoUrl && (
              <div className="space-y-3">
                <video src={photoVideoUrl} controls className="w-full rounded-lg border" />
                <Button onClick={async () => {
                  setLoading(true)
                  try {
                    await createResourceAction({
                      title: `Photo Video - ${new Date().toLocaleDateString()}`,
                      description: photoScript.slice(0, 120),
                      contentType: 'video',
                      content: photoVideoUrl,
                      estimatedMinutes: 3,
                      brokerageId,
                    })
                    toast.success('Video saved to education library')
                    setPhotoVideoJobId(null); setPhotoVideoStatus(null); setPhotoVideoUrl(null); setPhotoScript(''); setPhotoUrl(''); setPhotoPreview(null)
                  } catch { toast.error('Failed to save video') }
                  finally { setLoading(false) }
                }} disabled={loading}>
                  Save to Education Library
                </Button>
              </div>
            )}
            {photoVideoStatus === 'failed' && (
              <p className="text-sm text-destructive">Video generation failed. Please try again.</p>
            )}
          </div>
        )}

        {/* Avatar video tab */}
        {tab === 'avatar-video' && (
          <div className="space-y-4">
            {avatarsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : avatars.length === 0 ? (
              <div className="text-sm text-muted-foreground py-4 text-center">
                <Video className="h-8 w-8 mx-auto mb-2 opacity-40" />
                <p>No avatars available yet.</p>
                <p className="text-xs mt-1">Create an avatar in Settings → Voice &amp; Avatar (powered by D-ID) to enable avatar videos.</p>
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-sm font-medium mb-2">Select Avatar</label>
                  <div className="grid grid-cols-3 gap-2 max-h-48 overflow-y-auto">
                    {avatars.slice(0, 12).map(av => (
                      <button
                        key={av.avatar_id}
                        type="button"
                        onClick={() => setSelectedAvatar(av.avatar_id)}
                        className={`border rounded-lg p-1 text-left transition-colors ${
                          selectedAvatar === av.avatar_id ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-primary/50'
                        }`}
                      >
                        {av.preview_image_url ? (
                          <img src={av.preview_image_url} alt={av.avatar_name} className="w-full aspect-square object-cover rounded" />
                        ) : (
                          <div className="w-full aspect-square bg-muted rounded flex items-center justify-center text-xs text-muted-foreground">
                            {av.avatar_name.slice(0, 2)}
                          </div>
                        )}
                        <p className="text-[10px] mt-1 truncate text-center">{av.avatar_name}</p>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Video Script</label>
                  <textarea
                    value={videoScript}
                    onChange={e => setVideoScript(e.target.value)}
                    placeholder="Enter the script your avatar will speak…"
                    className="w-full border rounded px-3 py-2 text-sm"
                    rows={5}
                  />
                </div>
                {videoStatus === null && (
                  <Button onClick={handleGenerateVideo} disabled={isCreatingVideo || !selectedAvatar || !videoScript}>
                    {isCreatingVideo ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Video className="h-4 w-4 mr-1.5" />}
                    Generate Avatar Video
                  </Button>
                )}
                {videoStatus === 'processing' && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    Processing video — checking every 10s…
                  </div>
                )}
                {videoStatus === 'completed' && videoUrl && (
                  <div className="space-y-3">
                    <video src={videoUrl} controls className="w-full rounded-lg border" />
                    <Button onClick={handleSaveVideo} disabled={loading}>
                      Save to Education Library
                    </Button>
                  </div>
                )}
                {videoStatus === 'failed' && (
                  <p className="text-sm text-destructive">Video generation failed. Please try again.</p>
                )}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
