"use client"

import type React from "react"
import { useState, useEffect } from "react"
import { Zap, Trash2, Loader2, Sparkles, CheckCircle2 } from "lucide-react"
import { type SmartAssistantSuggestion, FEATURE_FLAGS } from "@/types"
import { supabaseService } from "@/services/supabaseService"
import { workflowService } from "@/services/workflowService"

const DailyGameplan: React.FC<{ agentId: string }> = ({ agentId }) => {
  const [suggestions, setSuggestions] = useState<SmartAssistantSuggestion[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [executingId, setExecutingId] = useState<string | null>(null)

  useEffect(() => {
    if (!FEATURE_FLAGS.SUGGESTIONS) return
    const load = async () => {
      setIsLoading(true)
      const data = await supabaseService.getSuggestions(agentId)
      setSuggestions(data || [])
      setIsLoading(false)
    }
    load()
  }, [agentId])

  const handleAction = async (id: string, action: "do" | "skip") => {
    if (action === "skip") {
      await supabaseService.updateSuggestionStatus(id, "ignored")
      setSuggestions((prev) => prev.filter((s) => s.id !== id))
      return
    }

    setExecutingId(id)
    const suggestion = suggestions.find((s) => s.id === id)
    if (suggestion) {
      await workflowService.triggerWorkflow("wf-assistant-execute", {
        suggestionId: id,
        action: suggestion.action_type,
        payload: JSON.parse(suggestion.action_payload_JSON || "{}"),
      })
      await supabaseService.updateSuggestionStatus(id, "executed")
      setSuggestions((prev) => prev.filter((s) => s.id !== id))
    }
    setExecutingId(null)
  }

  if (!FEATURE_FLAGS.SUGGESTIONS) return null

  const buckets = {
    "People to Call": suggestions.filter((s) => s.context_type === "lead"),
    "Deals to Protect": suggestions.filter((s) => s.context_type === "transaction"),
    "Content to Post": suggestions.filter((s) => s.context_type === "content"),
  }

  return (
    <div className="space-y-6 animate-fade-in-up">
      <div className="flex justify-between items-center px-2">
        <h3 className="text-sm font-black text-slate-400 uppercase tracking-[0.3em] flex items-center gap-2">
          <Sparkles size={16} className="text-indigo-600" /> Daily Gameplan.
        </h3>
        <span className="text-[10px] font-black bg-indigo-50 text-indigo-700 px-3 py-1 rounded-full border border-indigo-100 uppercase tracking-widest">
          {suggestions.length} High-Intensity Suggestions
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {Object.entries(buckets).map(([title, items]) => (
          <div
            key={title}
            className="bg-white rounded-[2rem] border border-slate-200 shadow-sm p-6 flex flex-col h-[500px]"
          >
            <div className="flex justify-between items-center mb-6 px-2">
              <h4 className="text-[10px] font-black text-slate-800 uppercase tracking-widest flex items-center gap-2">
                <div
                  className={`w-1.5 h-1.5 rounded-full ${items.length > 0 ? "bg-indigo-600 animate-pulse" : "bg-slate-200"}`}
                />
                {title}
              </h4>
              <span className="text-[10px] font-black text-slate-400">{items.length}</span>
            </div>

            <div className="flex-1 overflow-y-auto space-y-4 scrollbar-hide">
              {isLoading ? (
                <div className="h-full flex items-center justify-center opacity-30">
                  <Loader2 className="animate-spin" />
                </div>
              ) : items.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center opacity-20 text-center px-10">
                  <CheckCircle2 size={48} className="mb-4" />
                  <p className="text-[10px] font-black uppercase tracking-widest">Queue Clear</p>
                </div>
              ) : (
                items.map((item) => (
                  <div
                    key={item.id}
                    className="bg-slate-50 border border-slate-100 rounded-2xl p-5 hover:border-indigo-400 transition-all group relative overflow-hidden"
                  >
                    {item.priority === "high" && <div className="absolute top-0 right-0 w-12 h-1 bg-red-500" />}
                    <h5 className="font-black text-slate-900 text-xs uppercase tracking-tight italic mb-1.5 leading-none">
                      "{item.title}"
                    </h5>
                    <p className="text-[10px] text-slate-500 leading-relaxed font-medium mb-5">{item.description}</p>

                    <div className="flex gap-2">
                      <button
                        onClick={() => handleAction(item.id, "do")}
                        disabled={executingId === item.id}
                        className="flex-1 bg-indigo-600 text-white py-2 rounded-xl font-black uppercase text-[9px] tracking-widest shadow-lg hover:bg-indigo-700 active:scale-95 transition-all flex items-center justify-center gap-2"
                      >
                        {executingId === item.id ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}{" "}
                        Do It
                      </button>
                      <button
                        onClick={() => handleAction(item.id, "skip")}
                        className="px-3 bg-white border border-slate-200 text-slate-400 py-2 rounded-xl hover:text-red-500 hover:border-red-100 transition-all active:scale-95"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default DailyGameplan
