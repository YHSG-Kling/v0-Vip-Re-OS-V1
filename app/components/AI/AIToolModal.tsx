"use client"

import type React from "react"
import { useState } from "react"
import { X, Sparkles, Copy, Check, Save, Loader2, Bot, ShieldCheck, Zap } from "lucide-react"
import type { AIToolName } from "../../types"
import { workflowService } from "../../services/workflowService"
import { supabaseService } from "../../services/supabaseService"
import { useAuth } from "@/lib/auth/client"
import { toast } from "sonner"

interface AIToolModalProps {
  tool: {
    name: string
    icon: any
    toolName: AIToolName
    description: string
  }
  onClose: () => void
  context?: any
}

export const AIToolModal: React.FC<AIToolModalProps> = ({ tool, onClose, context }) => {
  const { user } = useAuth()
  const [output, setOutput] = useState("")
  const [isGenerating, setIsGenerating] = useState(false)
  const [copied, setCopied] = useState(false)

  const [inputText, setInputText] = useState("")
  const [features, setFeatures] = useState<string[]>([])
  const [tone, setTone] = useState("professional")

  const handleGenerate = async () => {
    setIsGenerating(true)
    try {
      const result = await workflowService.executeAITool(
        tool.toolName,
        {
          inputText,
          features,
          tone,
          ...context,
        },
        { userId: user?.id || "agent_1", ...context },
      )

      setOutput(result.output || "")
    } catch (e) {
      toast.error("AI Engine error — try again")
    } finally {
      setIsGenerating(false)
    }
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(output)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleSave = async () => {
    await supabaseService.saveAIOutput({
      userId: user?.id || "agent_1",
      toolName: tool.toolName,
      title: `${tool.name} result - ${new Date().toLocaleDateString()}`,
      content: output,
      tags: [tone, tool.toolName],
    })
    toast.success("Saved to Vault")
  }

  return (
    <div className="fixed inset-0 z-[1000] bg-slate-950/60 backdrop-blur-md flex items-center justify-center p-6 animate-fade-in">
      <div className="bg-white rounded-[2.5rem] w-full max-w-4xl max-h-[90vh] shadow-2xl border border-white/20 overflow-hidden flex flex-col">
        {/* Header */}
        <div className="bg-slate-900 p-8 text-white flex justify-between items-center shrink-0 border-b-8 border-indigo-600">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-indigo-600 flex items-center justify-center shadow-xl">
              <tool.icon size={24} />
            </div>
            <div>
              <h3 className="text-xl font-black italic tracking-tighter uppercase leading-none">{tool.name}</h3>
              <p className="text-indigo-400 font-bold text-[10px] uppercase tracking-widest mt-1">{tool.description}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-all text-white">
            <X size={24} />
          </button>
        </div>

        <div className="flex-1 overflow-hidden flex flex-col md:flex-row">
          {/* Inputs Section */}
          <div className="w-full md:w-[40%] p-8 border-r border-slate-100 overflow-y-auto bg-slate-50/50 scrollbar-hide">
            <div className="space-y-6">
              <div className="space-y-1.5">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block px-1">
                  Synthesis Input
                </label>
                <textarea
                  className="w-full p-4 bg-white border border-slate-200 rounded-2xl font-bold text-sm focus:ring-2 focus:ring-indigo-600 outline-none transition-all shadow-inner h-32"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder="Paste details or context here..."
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block px-1">
                  Delivery Tone
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {["professional", "luxury", "casual", "urgent"].map((t) => (
                    <button
                      key={t}
                      onClick={() => setTone(t)}
                      className={`py-2.5 rounded-xl text-[10px] font-black uppercase border-2 transition-all ${tone === t ? "bg-indigo-600 text-white border-indigo-600 shadow-md" : "bg-white border-slate-100 text-slate-400 hover:border-indigo-200"}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <button
                onClick={handleGenerate}
                disabled={isGenerating || !inputText}
                className="w-full bg-slate-900 text-white py-5 rounded-2xl font-black uppercase text-xs tracking-[0.2em] shadow-xl hover:bg-black transition-all active:scale-95 border-b-4 border-indigo-600 disabled:opacity-50"
              >
                {isGenerating ? (
                  <Loader2 className="animate-spin inline-block mr-2" size={18} />
                ) : (
                  <Sparkles className="inline-block mr-2" size={18} />
                )}
                Synthesize Output
              </button>
            </div>
          </div>

          {/* Output Section */}
          <div className="flex-1 p-8 flex flex-col overflow-hidden bg-white">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1 flex items-center gap-2">
                <Bot size={14} className="text-indigo-600" /> Nexus Engine Result
              </h4>
              {output && (
                <div className="flex gap-2">
                  <button
                    onClick={handleCopy}
                    className="p-2 bg-slate-50 text-slate-400 hover:text-indigo-600 rounded-lg shadow-sm transition-all"
                    title="Copy to Clipboard"
                  >
                    {copied ? <Check size={18} className="text-emerald-500" /> : <Copy size={18} />}
                  </button>
                  <button
                    onClick={handleSave}
                    className="p-2 bg-slate-50 text-slate-400 hover:text-indigo-600 rounded-lg shadow-sm transition-all"
                    title="Save to Vault"
                  >
                    <Save size={18} />
                  </button>
                </div>
              )}
            </div>

            <div className="flex-1 bg-slate-50 rounded-[2rem] border border-slate-100 p-8 shadow-inner overflow-y-auto scrollbar-hide relative">
              {!output && !isGenerating && (
                <div className="h-full flex flex-col items-center justify-center text-center opacity-30">
                  <Bot size={48} className="mb-4 text-indigo-200" />
                  <p className="font-black uppercase tracking-[0.2em] text-[10px]">Awaiting Instructions</p>
                </div>
              )}
              {isGenerating && (
                <div className="h-full flex flex-col items-center justify-center text-center space-y-4">
                  <Loader2 className="animate-spin text-indigo-600" size={32} />
                  <p className="font-black uppercase tracking-widest text-[10px] text-indigo-400 animate-pulse">
                    Running Neural Synthesis...
                  </p>
                </div>
              )}
              {output && (
                <textarea
                  className="w-full h-full bg-transparent border-none focus:ring-0 text-sm font-medium leading-relaxed italic text-slate-700 resize-none scrollbar-hide"
                  value={output}
                  onChange={(e) => setOutput(e.target.value)}
                />
              )}
            </div>

            <div className="mt-6 flex items-center justify-between text-[8px] font-black text-slate-400 uppercase tracking-widest">
              <div className="flex items-center gap-4">
                <span className="flex items-center gap-1">
                  <ShieldCheck size={10} className="text-emerald-500" /> COMPLIANT
                </span>
                <span className="flex items-center gap-1">
                  <Zap size={10} className="text-indigo-400" /> GPT-4O-MINI
                </span>
              </div>
              <span>Protocol 442-AI ACTIVE</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
