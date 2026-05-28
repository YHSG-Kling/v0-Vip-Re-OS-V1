"use client"

import type React from "react"
import { useState, useEffect } from "react"
import {
  PlayCircle,
  Sparkles,
  Wand2,
  Download,
  RefreshCw,
  Smartphone,
  Bot,
  Layers,
  CheckCircle2,
  Palette,
  Film,
  Send,
  ShieldCheck,
  AlertTriangle,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { generateAIText } from "@/lib/ai"
import { executeWorkflow } from "@/app/actions/workflows"
import { queueVideoGeneration } from "@/app/actions/video-generation"
import type { AgentVideo, Agent } from "@/types"
import { supabaseService } from "@/services/supabaseService"
import { analyzeContentQuality } from "@/lib/quality-checker"

interface VideoGeneratorProps {
  agentId: string
  leadId?: string
  campaignId?: string
  purpose: AgentVideo["videoPurpose"]
  context: {
    name: string
    city: string
    property?: string
    offer?: string
    marketStats?: string
    cta?: string
    backgroundOverride?: {
      type: "solid_color" | "image_url" | "video_url"
      value: string
    }
  }
  onComplete?: (videoUrl: string) => void
}

const VideoGenerator: React.FC<VideoGeneratorProps> = ({
  agentId,
  leadId,
  campaignId,
  purpose,
  context,
  onComplete,
}) => {
  const router = useRouter()
  const [isGenerating, setIsGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [queueId, setQueueId] = useState<string | null>(null)
  const [heyGenNotConfigured, setHeyGenNotConfigured] = useState(false)
  const [script, setScript] = useState<string>("")
  const [agentSettings, setAgentSettings] = useState<Agent | null>(null)
  const [statusMessage, setStatusMessage] = useState("")
  const [qualityScore, setQualityScore] = useState<any>(null)

  useEffect(() => {
    const loadAgent = async () => {
      const agents = await supabaseService.getAgents()
      const match = agents?.find((a) => a.id === agentId)
      if (match) setAgentSettings(match)
      else {
        setAgentSettings({
          id: agentId,
          name: "Sarah Smith",
          heyGenAvatarId: "sarah_avatar_v2_pro",
          heyGenVoiceId: "en-us-sarah-emotional",
          defaultVideoBackgroundType: "solid_color",
          defaultVideoBackgroundValue: "#4f46e5",
        } as any)
      }
    }
    loadAgent()
  }, [agentId])

  const generateScript = async () => {
    setStatusMessage("Drafting AI script...")

    try {
      const prompt = `Act as a high-performance real estate agent. Write a 45-second high-energy script for a personalized HeyGen avatar video.
            
PURPOSE: ${purpose}
RECIPIENT: ${context.name}
CITY/AREA: ${context.city}
PROPERTY: ${context.property || "N/A"}
OFFER/PLAN: ${context.offer || "N/A"}
MARKET STATS: ${context.marketStats || "N/A"}
CTA: ${context.cta || "Reply"}

CRITICAL: THEM-FIRST CONTENT PHILOSOPHY
- Write 80-90% about ${context.name} and their real estate situation
- Focus on THEIR needs, emotions, and goals
- Use "you" and "your" extensively (15%+ of words)
- Minimize "I", "me", "my" to under 10% of content
- Start with THEIR situation/pain point, not your introduction
- Show you understand what THEY care about regarding ${context.property || "their search"}
- Make it feel like this video was made specifically for them

STRUCTURE:
1. Personal greeting acknowledging THEIR specific interest
2. Show you understand THEIR situation and what matters to them
3. How this helps THEM achieve their goals
4. Clear single Call to Action that benefits THEM

TONE: Empathetic expert who puts their needs first.
Return ONLY the spoken script text.`

      const response = await generateAIText(prompt)
      return response.text || `Hi ${context.name}! I saw you were looking at property in ${context.city}. Our ${context.offer} plan is designed to save you time. Click the link below to get started!`
    } catch (err) {
      console.error("Script gen error", err)
      return `Hi ${context.name}! I saw you were looking at property in ${context.city}. Our ${context.offer} plan is designed to save you time. Click the link below to get started!`
    }
  }

  const handleGenerate = async () => {
    if (!agentSettings?.heyGenAvatarId) {
      setHeyGenNotConfigured(true)
      return
    }

    setIsGenerating(true)
    setProgress(5)
    setHeyGenNotConfigured(false)

    const generatedScript = await generateScript()
    setScript(generatedScript)
    setProgress(25)
    setStatusMessage("Queuing video via HeyGen API...")

    try {
      const queueItem = await queueVideoGeneration({
        agentId,
        scriptContent: generatedScript,
        videoType: purpose,
        metadata: {
          avatarId: agentSettings.heyGenAvatarId,
          voiceId: agentSettings.heyGenVoiceId,
          background: {
            type: context.backgroundOverride?.type || agentSettings.defaultVideoBackgroundType,
            value: context.backgroundOverride?.value || agentSettings.defaultVideoBackgroundValue,
          },
          leadId,
          campaignId,
          context,
        },
      })

      // queueVideoGeneration currently returns { error } because of schema
      // drift on video_generation_queue. Surface that to the UI instead of
      // pretending a queue id was issued.
      if (!queueItem || "error" in queueItem) {
        setIsGenerating(false)
        setStatusMessage(queueItem?.error ?? "Video queue not available")
        return
      }
      const queueItemId = (queueItem as { id: string }).id

      setQueueId(queueItemId)
      setProgress(40)
      setStatusMessage("Submitted to production queue — polling for completion...")

      // Poll video_generation_queue until status = 'completed' or 'failed'
      const pollInterval = setInterval(async () => {
        const statusResult = await executeWorkflow("poll-heygen-video", { queueId: queueItemId })
        if (statusResult?.status === "completed" && statusResult?.video_url) {
          clearInterval(pollInterval)
          setVideoUrl(statusResult.video_url)
          setIsGenerating(false)
          setProgress(100)
          setStatusMessage("Production Complete.")
          if (onComplete) onComplete(statusResult.video_url)
        } else if (statusResult?.status === "failed") {
          clearInterval(pollInterval)
          setIsGenerating(false)
          setStatusMessage("Generation failed — please retry.")
          setProgress(0)
        } else {
          setProgress((p) => Math.min(p + 5, 92))
          if (statusResult?.status === "processing") setStatusMessage("Rendering digital persona...")
        }
      }, 5000)
    } catch (err) {
      console.error("[v0] queueVideoGeneration error:", err)
      setIsGenerating(false)
      setStatusMessage("Failed to queue video. Check HeyGen integration settings.")
      setProgress(0)
    }
  }

  return (
    <div className="bg-white rounded-[2rem] border-2 border-slate-200 shadow-2xl overflow-hidden animate-fade-in">
      <div className="bg-slate-900 p-8 text-white relative overflow-hidden">
        <div className="absolute right-[-20px] top-[-20px] p-6 opacity-10 rotate-12">
          <Film size={140} />
        </div>
        <div className="relative z-10 flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-indigo-600 rounded-xl shadow-lg">
                <Bot size={24} />
              </div>
              <span className="text-[10px] font-black uppercase tracking-[0.4em] text-indigo-400">
                WF-MEDIA-01 PRODUCTION
              </span>
            </div>
            <h3 className="text-3xl font-black italic tracking-tighter uppercase mb-2 leading-none">
              AI Video Studio.
            </h3>
            <p className="text-indigo-100 text-sm font-medium opacity-80 max-w-md">
              Personalized avatar production for{" "}
              <strong className="text-white underline">{purpose.replace(/([A-Z])/g, " $1").trim()}</strong>.
            </p>
          </div>
          <div className="bg-white/10 p-5 rounded-3xl border border-white/10 backdrop-blur-md min-w-[220px] text-center shadow-xl">
            <p className="text-[9px] font-black text-indigo-300 uppercase tracking-widest mb-2">ACTIVE AGENT</p>
            <div className="flex items-center justify-center gap-3">
              <div className="w-8 h-8 rounded-full bg-indigo-50 border border-white/20 flex items-center justify-center font-black text-xs">
                SS
              </div>
              <p className="text-base font-black text-white uppercase italic">{agentSettings?.name || "Sarah Smith"}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="p-8">
        {heyGenNotConfigured && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-center mb-6">
            <AlertTriangle className="h-8 w-8 text-amber-500 mx-auto mb-3" />
            <p className="font-medium">Video generation not configured</p>
            <p className="text-sm text-muted-foreground mt-1">
              Connect HeyGen in your integrations settings to generate real videos.
            </p>
            <button
              className="mt-4 px-4 py-2 bg-slate-900 text-white rounded-xl text-sm font-bold hover:bg-black transition-all"
              onClick={() => router.push("/settings/integrations")}
            >
              Connect HeyGen
            </button>
          </div>
        )}
        {!videoUrl ? (
          <div className="space-y-8">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="bg-slate-50 border border-slate-100 p-6 rounded-3xl">
                <h4 className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-6 flex items-center gap-2">
                  <Layers size={14} /> Context Payload
                </h4>
                <div className="space-y-4">
                  {[
                    { k: "Recipient", v: context.name },
                    { k: "Region", v: context.city },
                    { k: "Plan/Offer", v: context.offer || "Default Nurture" },
                    { k: "CTA Target", v: context.cta || "Reply" },
                  ].map((item) => (
                    <div key={item.k} className="flex justify-between border-b border-slate-100 pb-2">
                      <span className="text-[8px] font-black text-indigo-400 uppercase">{item.k}</span>
                      <span className="text-xs font-bold text-slate-700">{item.v}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-slate-50 border border-slate-100 p-6 rounded-3xl">
                <h4 className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-6 flex items-center gap-2">
                  <Palette size={14} /> Style Settings
                </h4>
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-[8px] font-black text-indigo-400 uppercase">Avatar identity</span>
                    <span className="text-[10px] font-black bg-white px-2 py-0.5 rounded border border-slate-200 uppercase tracking-widest">
                      {agentSettings?.heyGenAvatarId || "Sarah_V1"}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-[8px] font-black text-indigo-400 uppercase">Background</span>
                    <div className="flex items-center gap-2">
                      <div
                        className="w-3 h-3 rounded-full"
                        style={{
                          backgroundColor:
                            agentSettings?.defaultVideoBackgroundType === "solid_color"
                              ? agentSettings.defaultVideoBackgroundValue
                              : "#ccc",
                        }}
                      />
                      <span className="text-[10px] font-bold text-slate-600 uppercase">
                        {agentSettings?.defaultVideoBackgroundType}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {isGenerating ? (
              <div className="py-12 flex flex-col items-center justify-center text-center space-y-8 animate-fade-in">
                <div className="relative">
                  <div className="w-32 h-32 bg-indigo-50 rounded-[3rem] flex items-center justify-center text-indigo-600 shadow-inner ring-4 ring-white">
                    <RefreshCw size={56} className="animate-spin-slow" />
                  </div>
                  <div className="absolute -top-3 -right-3 w-12 h-12 bg-white rounded-2xl flex items-center justify-center shadow-2xl border border-indigo-50 animate-bounce-subtle">
                    <Sparkles size={24} className="text-indigo-500" />
                  </div>
                </div>
                <div className="w-full max-w-sm space-y-3">
                  <div className="flex justify-between items-end mb-1 px-1">
                    <p className="text-[10px] font-black text-indigo-600 uppercase tracking-[0.2em]">{statusMessage}</p>
                    <p className="text-lg font-black text-indigo-600 tabular-nums">{progress}%</p>
                  </div>
                  <div className="w-full bg-slate-100 h-3 rounded-full overflow-hidden p-0.5 shadow-inner">
                    <div
                      className="h-full bg-gradient-to-r from-indigo-600 to-indigo-400 transition-all duration-700 ease-out rounded-full"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <button
                onClick={handleGenerate}
                className="w-full bg-slate-900 text-white py-6 rounded-[2rem] font-black uppercase text-sm tracking-[0.3em] shadow-2xl hover:bg-black transition-all active:scale-95 border-b-8 border-indigo-600"
              >
                <Wand2 size={24} className="inline-block mr-3 mb-1" />
                Launch Production Stream
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-8 animate-fade-in">
            <div className="aspect-video bg-slate-900 rounded-[2.5rem] overflow-hidden relative group shadow-2xl ring-8 ring-indigo-50/50">
              <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/40 transition-colors">
                <div className="w-20 h-20 bg-white/20 backdrop-blur-md rounded-full flex items-center justify-center border-2 border-white group-hover:scale-110 transition-transform cursor-pointer shadow-2xl">
                  <PlayCircle size={48} className="text-white ml-1" />
                </div>
              </div>
              <div className="absolute top-8 left-8 flex gap-2">
                <div className="bg-indigo-600 text-white text-[10px] font-black uppercase px-4 py-1.5 rounded-full shadow-xl flex items-center gap-2">
                  <CheckCircle2 size={14} /> Render Success
                </div>
              </div>
              {queueId && (
                <div className="absolute bottom-6 right-6">
                  <p className="text-[9px] font-black text-white/60 uppercase tracking-widest">
                    Queue ID: {queueId.slice(0, 12)}...
                  </p>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              <div className="bg-slate-50 border border-slate-100 p-6 rounded-3xl">
                <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                  <Smartphone size={14} /> AI Written Script
                </p>
                <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-inner italic text-xs text-slate-600 leading-relaxed overflow-y-auto max-h-32 scrollbar-hide">
                  {script}
                </div>
                {qualityScore && (
                  <div className="mt-4 p-4 bg-white rounded-xl border border-slate-100">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-[8px] font-black text-slate-400 uppercase">Them-First Score</span>
                      <span
                        className={`text-xs font-black ${qualityScore.score >= 80 ? "text-emerald-600" : qualityScore.score >= 60 ? "text-orange-600" : "text-red-600"}`}
                      >
                        {qualityScore.score}/100
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[8px]">
                      <div>
                        <span className="text-slate-400">Prospect Focus:</span>
                        <span className="font-black text-indigo-600 ml-1">
                          {qualityScore.themPercentage.toFixed(1)}%
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-400">Agent Focus:</span>
                        <span className="font-black text-slate-600 ml-1">
                          {qualityScore.agentPercentage.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-4 justify-center">
                <button className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl hover:bg-indigo-700 flex items-center justify-center gap-3 active:scale-95 border-b-4 border-indigo-900">
                  <Send size={18} /> Push to GHL Drip
                </button>
                <div className="flex gap-4">
                  <button
                    onClick={() => {
                      setVideoUrl(null)
                      setScript("")
                    }}
                    className="flex-1 bg-white border-2 border-slate-200 text-slate-400 py-4 rounded-2xl font-black uppercase text-[10px] tracking-widest hover:bg-slate-50 transition-all flex items-center justify-center gap-2"
                  >
                    <RefreshCw size={14} /> Re-Render
                  </button>
                  <button className="flex-1 bg-slate-900 text-white py-4 rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-lg hover:bg-black transition-all flex items-center justify-center gap-2">
                    <Download size={14} /> Save to Vault
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="bg-slate-50 px-8 py-4 border-t border-slate-100 flex justify-between items-center text-[9px] font-black text-slate-400 uppercase tracking-widest">
        <div className="flex items-center gap-2">
          <ShieldCheck size={12} className="text-emerald-500" /> Secure Production Lane
        </div>
        <span>Asset Persistence: 7 Days</span>
      </div>
    </div>
  )
}

export default VideoGenerator
