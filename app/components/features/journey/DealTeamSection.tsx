"use client"

import type React from "react"
import { useState, useEffect } from "react"
import {
  UserCircle,
  Bot,
  Briefcase,
  Building,
  FileText,
  Clipboard,
  TrendingUp,
  Phone,
  PhoneIncoming,
  MessageSquare,
  Mail,
  Calendar,
  CheckCircle,
  Clock,
  Activity,
  ChevronRight,
  Sparkles,
  Users,
} from "lucide-react"
import { supabaseService } from "@/services/supabaseService"
import type { DealTeamMember, AIISAActivity } from "@/types"

interface DealTeamSectionProps {
  dealId?: string
  contactId?: string
  showAIActivity?: boolean
}

export const DealTeamSection: React.FC<DealTeamSectionProps> = ({ dealId, contactId, showAIActivity = true }) => {
  const [team, setTeam] = useState<DealTeamMember[]>([])
  const [aiActivities, setAiActivities] = useState<AIISAActivity[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    loadTeamData()
  }, [dealId, contactId])

  const loadTeamData = async () => {
    setIsLoading(true)

    // Load team members - Using supabaseService
    if (dealId) {
      const teamData = await supabaseService.getTeamByDealId(dealId)
      setTeam(teamData)
    }

    // Load AI ISA activities - Using supabaseService
    if (showAIActivity && contactId) {
      const activities = await supabaseService.getAIISAActivityByContactId(contactId, 5)
      setAiActivities(activities)
    }

    setIsLoading(false)
  }

  const getRoleLabel = (role: string) => {
    const labels: Record<string, string> = {
      agent: "Your Agent",
      ai_isa: "AI Assistant",
      tc: "Transaction Coordinator",
      lender: "Lender",
      title: "Title Company",
      inspector: "Home Inspector",
      appraiser: "Appraiser",
    }
    return labels[role] || role
  }

  const getRoleIcon = (role: string) => {
    const icons: Record<string, any> = {
      agent: UserCircle,
      ai_isa: Bot,
      tc: Briefcase,
      lender: Building,
      title: FileText,
      inspector: Clipboard,
      appraiser: TrendingUp,
    }
    const Icon = icons[role] || UserCircle
    return Icon
  }

  const getActivityIcon = (type: string) => {
    const icons: Record<string, any> = {
      outbound_call: Phone,
      inbound_call: PhoneIncoming,
      sms_sent: MessageSquare,
      sms_received: MessageSquare,
      email_sent: Mail,
      appointment_set: Calendar,
      lead_qualified: CheckCircle,
      lead_nurture: Sparkles,
      follow_up_scheduled: Clock,
    }
    return icons[type] || Activity
  }

  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return "Just now"
    if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`
    return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`
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
      <div className="space-y-4 animate-pulse">
        <div className="h-6 bg-slate-200 rounded w-1/4 mb-4"></div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 bg-slate-100 rounded-2xl"></div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="flex items-center gap-3 px-2">
        <h2 className="text-xl font-black text-slate-800 uppercase italic tracking-tighter leading-none">Your Team.</h2>
        <div className="h-px flex-1 bg-slate-100"></div>
      </div>

      {/* Team Members Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {team.map((member) => {
          const Icon = getRoleIcon(member.role)

          return (
            <div
              key={member.id}
              className={`bg-white border rounded-[2rem] p-6 shadow-sm hover:shadow-md transition-all group ${member.isAi ? "border-purple-200 ring-4 ring-purple-50" : "border-slate-200 hover:border-indigo-400"}`}
            >
              <div className="flex items-start gap-4">
                {/* Photo or Icon */}
                <div className="flex-shrink-0 relative">
                  {member.photoUrl ? (
                    <img
                      src={member.photoUrl || "/placeholder.svg"}
                      alt={member.name}
                      className="w-14 h-14 rounded-2xl object-cover shadow-lg border-2 border-white"
                    />
                  ) : (
                    <div
                      className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-inner border-2 border-white ${member.isAi ? "bg-purple-600 text-white" : "bg-indigo-50 text-indigo-600"}`}
                    >
                      <Icon size={24} />
                    </div>
                  )}
                  {member.isAi && (
                    <div className="absolute -top-2 -right-2">
                      <span className="text-[8px] font-black bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full border border-purple-200 uppercase tracking-widest shadow-sm">
                        AI ISA
                      </span>
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p
                    className={`text-[9px] font-black uppercase tracking-widest mb-1 ${member.isAi ? "text-purple-500" : "text-slate-400"}`}
                  >
                    {getRoleLabel(member.role)}
                  </p>
                  <p className="font-black text-slate-900 uppercase tracking-tight italic leading-none truncate mb-1.5">
                    {member.name}
                  </p>
                  {member.company && (
                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">{member.company}</p>
                  )}

                  {/* Contact Methods (only for non-AI) */}
                  {!member.isAi && (
                    <div className="flex gap-2 mt-4">
                      {member.phone && (
                        <button
                          onClick={() => handleContactClick("call", member.phone!)}
                          className="p-2 bg-slate-50 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all border border-slate-100"
                          title="Call"
                        >
                          <Phone size={14} />
                        </button>
                      )}
                      {member.email && (
                        <button
                          onClick={() => handleContactClick("email", member.email!)}
                          className="p-2 bg-slate-50 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all border border-slate-100"
                          title="Email"
                        >
                          <Mail size={14} />
                        </button>
                      )}
                      {member.phone && (
                        <button
                          onClick={() => handleContactClick("text", member.phone!)}
                          className="p-2 bg-slate-50 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all border border-slate-100"
                          title="Text"
                        >
                          <MessageSquare size={14} />
                        </button>
                      )}
                    </div>
                  )}

                  {/* AI ISA Description */}
                  {member.isAi && (
                    <div className="bg-purple-50 rounded-xl p-3 border border-purple-100 mt-3">
                      <p className="text-[10px] text-purple-900 leading-relaxed font-bold italic">
                        "Working 24/7 on your lead conversion & scheduling."
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* AI ISA Recent Activity */}
      {showAIActivity && aiActivities.length > 0 && (
        <div className="mt-10 animate-fade-in-up">
          <div className="flex items-center justify-between mb-4 px-2">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-600 text-white rounded-xl shadow-lg shadow-purple-900/20">
                <Bot size={20} />
              </div>
              <div>
                <h3 className="text-xl font-black text-slate-800 uppercase italic tracking-tighter leading-none">
                  AI Assistant Activity.
                </h3>
                <p className="text-[10px] text-purple-600 font-black uppercase tracking-widest mt-1">
                  Global ISA Network Tracking
                </p>
              </div>
            </div>
            <span className="text-[9px] font-black bg-purple-100 text-purple-700 px-3 py-1 rounded-full border border-purple-200 uppercase tracking-widest shadow-sm">
              Live Monitoring
            </span>
          </div>

          <div className="space-y-2">
            {aiActivities.map((activity) => {
              const Icon = getActivityIcon(activity.activityType)
              const timeAgo = formatTimeAgo(activity.createdAt)

              return (
                <div
                  key={activity.id}
                  className="bg-white border border-slate-200 rounded-[1.5rem] p-5 shadow-sm hover:border-purple-400 transition-all group relative overflow-hidden"
                >
                  <div className="absolute right-[-10px] top-[-10px] p-2 opacity-5 text-purple-900 group-hover:rotate-12 transition-transform duration-700">
                    <Bot size={60} />
                  </div>
                  <div className="flex items-start gap-5 relative z-10">
                    <div className="p-3 bg-purple-50 text-purple-600 rounded-2xl group-hover:bg-purple-600 group-hover:text-white transition-all shadow-inner">
                      <Icon size={18} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-1">
                        <p className="text-sm font-bold text-slate-800 italic leading-snug flex-1">
                          "{activity.summary}"
                        </p>
                        <p className="text-[9px] font-black text-slate-300 uppercase tracking-widest shrink-0">
                          {timeAgo}
                        </p>
                      </div>

                      <div className="flex items-center gap-3 mt-3">
                        {/* Outcome Badge */}
                        {activity.outcome && (
                          <span
                            className={`text-[8px] font-black uppercase px-2 py-0.5 rounded border tracking-widest ${
                              activity.outcome === "appointment_set"
                                ? "bg-emerald-50 text-emerald-700 border-emerald-100"
                                : activity.outcome === "connected"
                                  ? "bg-blue-50 text-blue-700 border-blue-100"
                                  : "bg-slate-50 text-slate-500 border-slate-200"
                            }`}
                          >
                            {activity.outcome.replace("_", " ")}
                          </span>
                        )}

                        {/* Next Action */}
                        {activity.nextAction && (
                          <div className="flex items-center gap-1.5 text-purple-700">
                            <Clock size={10} />
                            <span className="text-[9px] font-black uppercase tracking-widest">
                              Next Action: {activity.nextAction}
                            </span>
                            {activity.nextActionDate && (
                              <span className="text-[9px] font-bold text-purple-400 italic">
                                ({new Date(activity.nextActionDate).toLocaleDateString()})
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          <button
            onClick={() => {
              /* Show full activity log */
            }}
            className="w-full mt-4 py-3 bg-white border border-slate-200 rounded-2xl text-[9px] font-black uppercase tracking-widest text-slate-400 hover:text-indigo-600 hover:border-indigo-400 transition-all shadow-sm flex items-center justify-center gap-2"
          >
            View Full Protocol Log <ChevronRight size={14} />
          </button>
        </div>
      )}

      {/* No Team Members */}
      {team.length === 0 && (
        <div className="text-center py-10 bg-slate-50 rounded-[2rem] border border-dashed border-slate-200">
          <Users size={32} className="mx-auto text-slate-200 mb-3" />
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
            Initializing Tactical Team Mapping...
          </p>
        </div>
      )}
    </div>
  )
}
