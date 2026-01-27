"use client"

import type React from "react"
import { useState, useEffect } from "react"
import {
  Play,
  Phone,
  MessageSquare,
  Mail,
  UserCircle,
  Loader2,
  Bot,
  Sparkles,
  ArrowRight,
  Video,
  Calendar,
} from "lucide-react"
import type { TransparencyUpdate, TransparencyVideo } from "../types"
import { supabaseService } from "../services/supabaseService"

interface TransparencyFeedProps {
  contactId: string
  title?: string
}

export const TransparencyFeed: React.FC<TransparencyFeedProps> = ({ contactId, title = "What's Happening Now" }) => {
  const [updates, setUpdates] = useState<TransparencyUpdate[]>([])
  const [videos, setVideos] = useState<Record<string, TransparencyVideo>>({})
  const [isLoading, setIsLoading] = useState(true)
  const [expandedUpdateId, setExpandedUpdateId] = useState<string | null>(null)

  useEffect(() => {
    loadUpdates()
  }, [contactId])

  const loadUpdates = async () => {
    setIsLoading(true)
    const updatesData = await supabaseService.getUpdatesByContactId(contactId)
    setUpdates(updatesData)

    const videoIds = updatesData.filter((u) => u.transparencyVideoId).map((u) => u.transparencyVideoId as string)

    if (videoIds.length > 0) {
      const allVideos = await supabaseService.getTransparencyVideos()
      const videosMap: Record<string, TransparencyVideo> = {}
      allVideos.forEach((v) => {
        if (videoIds.includes(v.id)) {
          videosMap[v.id] = v
        }
      })
      setVideos(videosMap)
    }

    setIsLoading(false)
  }

  const handleContactClick = (method: "call" | "text" | "email", value: string) => {
    if (method === "call") {
      window.location.href = `tel:${value}`
    } else if (method === "text") {
      window.location.href = `sms:${value}`
    } else if (method === "email") {
      window.location.href = `mailto:${value}`
    }
  }

  if (isLoading) {
    return (
      <div className="py-8 text-center flex flex-col items-center justify-center animate-pulse">
        <Loader2 className="animate-spin text-indigo-600 mb-4" size={32} />
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Syncing Transparency Feed...</p>
      </div>
    )
  }

  if (updates.length === 0) {
    return (
      <div className="bg-white rounded-[2rem] p-10 border border-dashed border-slate-200 text-center shadow-inner">
        <Bot size={40} className="mx-auto text-slate-200 mb-4" />
        <p className="text-slate-400 font-bold text-sm uppercase tracking-tight italic">
          "The engine is idling. New updates will appear as your journey progresses."
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <h2 className="text-2xl font-black text-slate-800 uppercase italic tracking-tighter leading-none px-2">
        {title}
      </h2>

      <div className="space-y-4">
        {updates.map((update) => {
          const video = update.transparencyVideoId ? videos[update.transparencyVideoId] : null
          const isExpanded = expandedUpdateId === update.id
          const commLinks = update.communicationLinksJson ? JSON.parse(update.communicationLinksJson) : {}

          return (
            <div
              key={update.id}
              className="bg-white rounded-[2rem] border border-slate-200 shadow-md hover:border-indigo-400 transition-all group overflow-hidden"
            >
              {/* Update Header */}
              <div className="p-6 md:p-8">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="bg-indigo-50 text-indigo-700 text-[8px] font-black uppercase px-2 py-0.5 rounded border border-indigo-100 tracking-widest">
                        {update.stage} Stage
                      </span>
                      <div className="w-1 h-1 bg-slate-200 rounded-full" />
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                        {new Date(update.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </p>
                    </div>
                    <h3 className="text-xl font-black text-slate-900 uppercase tracking-tight italic leading-none">
                      {update.title}
                    </h3>
                  </div>
                </div>

                {/* Summary */}
                <div className="bg-slate-50 border border-slate-100 p-6 rounded-3xl relative">
                  <div className="absolute right-4 top-4 opacity-5 pointer-events-none">
                    <Sparkles size={40} className="text-indigo-600" />
                  </div>
                  <p className="text-sm font-bold text-slate-700 leading-relaxed italic">
                    "{update.plainLanguageSummary}"
                  </p>
                </div>

                {/* Video Player */}
                {video && (
                  <div className="mt-6">
                    <div className="bg-indigo-900 rounded-[1.5rem] p-6 text-white relative overflow-hidden group/video shadow-xl">
                      <div className="absolute right-[-10px] top-[-10px] p-2 opacity-10 rotate-12 transition-transform group-hover/video:rotate-0">
                        <Video size={80} />
                      </div>
                      <div className="relative z-10">
                        <div className="flex items-center gap-3 mb-4">
                          <div className="p-2 bg-white/20 rounded-xl backdrop-blur-md border border-white/10 shadow-lg">
                            <Bot size={20} className="text-indigo-200" />
                          </div>
                          <span className="text-[10px] font-black uppercase tracking-[0.3em] text-indigo-300">
                            AI Explainer Video
                          </span>
                        </div>

                        {isExpanded ? (
                          <div className="rounded-2xl overflow-hidden shadow-2xl border-4 border-white/20 aspect-video bg-black mt-4">
                            <video
                              controls
                              autoPlay
                              className="w-full h-full object-contain"
                              src={video.videoUrl}
                              poster={video.thumbnailUrl}
                            />
                          </div>
                        ) : (
                          <div className="flex flex-col md:flex-row items-center justify-between gap-6">
                            <p className="text-sm font-bold italic text-indigo-100 flex-1">
                              "I've synthesized a short video to explain exactly what this milestone means for your
                              closing."
                            </p>
                            <button
                              onClick={() => setExpandedUpdateId(update.id)}
                              className="px-8 py-3 bg-white text-indigo-900 rounded-xl font-black uppercase text-[10px] tracking-widest shadow-2xl hover:bg-indigo-50 transition-all flex items-center gap-2 shrink-0 border-b-4 border-indigo-200"
                            >
                              <Play size={14} fill="currentColor" /> Play Explainer ({video.durationSeconds}s)
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">
                  {/* Who's Handling This */}
                  <div className="flex items-start gap-5 p-5 bg-white border border-slate-100 rounded-3xl shadow-sm hover:border-indigo-200 transition-all group">
                    <div className="p-3 bg-slate-50 rounded-2xl group-hover:bg-indigo-50 transition-colors shadow-inner">
                      <UserCircle className="w-6 h-6 text-slate-400 group-hover:text-indigo-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">
                        Operational Lead
                      </p>
                      <p className="text-sm font-black text-slate-800 uppercase tracking-tight truncate">
                        {update.responsiblePartyName || update.responsibleParty}
                      </p>

                      {/* Contact Buttons */}
                      {Object.keys(commLinks).length > 0 && (
                        <div className="flex gap-2 mt-4">
                          {commLinks.call && (
                            <button
                              onClick={() => handleContactClick("call", commLinks.call)}
                              className="p-2 bg-indigo-50 text-indigo-600 rounded-xl hover:bg-indigo-600 hover:text-white transition-all shadow-sm"
                              title="Call"
                            >
                              <Phone size={14} />
                            </button>
                          )}
                          {commLinks.text && (
                            <button
                              onClick={() => handleContactClick("text", commLinks.text)}
                              className="p-2 bg-indigo-50 text-indigo-600 rounded-xl hover:bg-indigo-600 hover:text-white transition-all shadow-sm"
                              title="Text"
                            >
                              <MessageSquare size={14} />
                            </button>
                          )}
                          {commLinks.email && (
                            <button
                              onClick={() => handleContactClick("email", commLinks.email)}
                              className="p-2 bg-indigo-50 text-indigo-600 rounded-xl hover:bg-indigo-600 hover:text-white transition-all shadow-sm"
                              title="Email"
                            >
                              <Mail size={14} />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* What's Next */}
                  {update.nextStep && (
                    <div className="p-5 bg-indigo-600 rounded-3xl text-white shadow-xl relative overflow-hidden group">
                      <div className="absolute right-0 top-0 p-2 opacity-10 group-hover:rotate-12 transition-transform">
                        <ArrowRight size={60} />
                      </div>
                      <p className="text-[8px] font-black text-indigo-300 uppercase tracking-widest mb-1 relative z-10">
                        Target Milestone
                      </p>
                      <p className="text-sm font-black uppercase tracking-tight italic relative z-10 leading-tight">
                        {update.nextStep}
                      </p>
                      {update.nextStepDate && (
                        <div className="mt-4 flex items-center gap-2 relative z-10">
                          <Calendar className="w-3 h-3 text-indigo-300" />
                          <p className="text-[10px] font-bold text-indigo-100 uppercase tracking-widest">
                            Est: {new Date(update.nextStepDate).toLocaleDateString()}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
