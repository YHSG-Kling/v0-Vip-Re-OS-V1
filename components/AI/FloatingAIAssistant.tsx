"use client"

import type React from "react"
import { useState } from "react"
import { Sparkles, X, Mail, Home, Share2, FileText, Bot, ChevronRight } from "lucide-react"
import { AIToolModal } from "./AIToolModal"
import type { AIToolName, UserRole } from "../../types"

interface FloatingAIAssistantProps {
  currentView?: string
  userRole?: UserRole
}

export const FloatingAIAssistant: React.FC<FloatingAIAssistantProps> = ({ currentView, userRole }) => {
  const [isOpen, setIsOpen] = useState(false)
  const [selectedTool, setSelectedTool] = useState<any>(null)

  const quickTools = [
    {
      name: "Email Smart Composer",
      icon: Mail,
      toolName: "email_composer" as AIToolName,
      description: "Synthesize professional correspondence",
    },
    {
      name: "Listing Architect",
      icon: Home,
      toolName: "listing_description" as AIToolName,
      description: "Generate high-velocity descriptions",
    },
    {
      name: "Social Hook Engine",
      icon: Share2,
      toolName: "social_post" as AIToolName,
      description: "Create viral-pattern social hooks",
    },
    {
      name: "Clause Explainer",
      icon: FileText,
      toolName: "contract_explainer" as AIToolName,
      description: "Translate legalese to plain English",
    },
  ]

  return (
    <>
      {/* Floating Button */}
      <div className="fixed bottom-6 right-6 z-[400] flex flex-col items-end gap-3">
        {isOpen && (
          <div className="bg-white rounded-[2rem] shadow-[0_20px_50px_rgba(79,70,229,0.25)] border border-slate-200 p-6 w-80 animate-fade-in-up mb-4 overflow-hidden relative group">
            <div className="absolute right-[-10px] top-[-10px] p-2 opacity-5 text-indigo-900 group-hover:rotate-12 transition-transform duration-700 pointer-events-none">
              <Bot size={120} />
            </div>

            <div className="flex items-center justify-between mb-6 relative z-10">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-600 rounded-xl shadow-lg">
                  <Sparkles size={16} className="text-white" />
                </div>
                <h3 className="font-black text-xs uppercase tracking-widest text-slate-800">Quick AI Synthesis</h3>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1.5 hover:bg-slate-100 rounded-full text-slate-300 transition-all"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-2 relative z-10">
              {quickTools.map((tool) => {
                const Icon = tool.icon
                return (
                  <button
                    key={tool.toolName}
                    onClick={() => {
                      setSelectedTool(tool)
                      setIsOpen(false)
                    }}
                    className="w-full p-4 bg-slate-50 hover:bg-white border-2 border-transparent hover:border-indigo-100 rounded-2xl text-left transition-all group flex items-center gap-4 hover:shadow-lg hover:scale-[1.02]"
                  >
                    <div className="p-3 bg-white rounded-xl shadow-sm group-hover:bg-indigo-50 transition-colors">
                      <Icon className="w-4 h-4 text-indigo-400 group-hover:text-indigo-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-black text-slate-900 text-[10px] uppercase tracking-tight truncate leading-none">
                        {tool.name}
                      </p>
                      <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest mt-1.5 opacity-60 italic leading-none">
                        {tool.description}
                      </p>
                    </div>
                  </button>
                )
              })}
            </div>

            <button
              onClick={() => {
                window.dispatchEvent(new CustomEvent("nexus-navigate", { detail: "ai-tools" }))
                setIsOpen(false)
              }}
              className="w-full mt-6 py-4 bg-slate-900 text-white rounded-2xl hover:bg-black transition-all text-[10px] font-black uppercase tracking-[0.2em] shadow-xl flex items-center justify-center gap-2 border-b-4 border-indigo-600"
            >
              Full AI Hub <ChevronRight size={14} />
            </button>
          </div>
        )}

        <button
          onClick={() => setIsOpen(!isOpen)}
          className={`w-16 h-16 bg-slate-900 text-white rounded-[1.5rem] shadow-[0_20px_50px_rgba(79,70,229,0.3)] flex items-center justify-center transition-all hover:scale-105 active:scale-95 border-4 border-white ${isOpen ? "rotate-90 bg-indigo-600" : ""}`}
        >
          {isOpen ? <X size={28} /> : <Sparkles size={28} className="animate-pulse" />}
        </button>
      </div>

      {/* Tool Modal */}
      {selectedTool && <AIToolModal tool={selectedTool} onClose={() => setSelectedTool(null)} />}
    </>
  )
}
