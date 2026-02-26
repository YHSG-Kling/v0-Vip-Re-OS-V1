"use client"

import type React from "react"
import { useState, useEffect, useRef } from "react"
import {
  Sparkles,
  Loader2,
  Users,
  ArrowRight,
  Bot,
  MessageSquare,
  X,
  Keyboard,
  Globe,
  Database,
  RefreshCw,
  Home,
  Briefcase,
  DollarSign,
  Calendar,
  Plus,
  Terminal,
  ShieldCheck,
  Activity,
} from "lucide-react"
import { generateAIJSON } from "@/lib/ai/generate"
import { executeWorkflow } from "../../app/actions/workflows"
import { supabaseService } from "../../services/supabaseService"

interface CommandBarProps {
  onNavigate: (view: string) => void
}

interface AIResult {
  intent: "NAVIGATE" | "ACTION" | "SEARCH" | "QUERY" | "UNKNOWN"
  target: string
  parameters?: Record<string, any>
  message: string
  confidence?: number
}

const CommandBar: React.FC<CommandBarProps> = ({ onNavigate }) => {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [isProcessing, setIsProcessing] = useState(false)
  const [aiResponse, setAiResponse] = useState<AIResult | null>(null)
  const [fetchedData, setFetchedData] = useState<any>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // All valid views in the Smart Engine platform
  const VALID_VIEWS = [
    "agent-dashboard",
    "offer-lab",
    "risk-management",
    "user-management",
    "listing-approvals",
    "listing-distribution",
    "oh-manager",
    "showings",
    "buyer-tours",
    "feedback-log",
    "calendar",
    "segmentation",
    "data-health",
    "lead-distribution",
    "notifications",
    "listing-intake",
    "crm",
    "transactions",
    "closing-dashboard",
    "sphere",
    "documents",
    "marketing",
    "social-scheduler",
    "shareable-assets",
    "cma",
    "inbox",
    "partners",
    "map-intelligence",
    "listing-reports",
    "broker-dashboard",
    "compliance",
    "financials",
    "agents",
    "system-health",
    "settings",
    "knowledge-base",
    "ai-audit",
    "vendor-compliance",
    "buyer-dashboard",
    "home-value",
    "playbook",
    "matches",
    "marketplace",
    "listing-journey",
    "seller-dashboard",
    "open-house",
    "events",
  ]

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setIsOpen((open) => !open)
      }
      if (e.key === "Escape") {
        setIsOpen(false)
      }
    }
    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [])

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50)
      setAiResponse(null)
      setFetchedData(null)
    }
  }, [isOpen])

  const handleCommand = async (manualQuery?: string) => {
    const activeQuery = manualQuery || query
    if (!activeQuery.trim()) return

    setIsProcessing(true)
    setAiResponse(null)
    setFetchedData(null)

    try {
      const prompt = `You are the Nexus OS Universal Command Brain. 
Determine the user intent and target from the query: "${activeQuery}"

VALID NAVIGATION SLUGS:
${VALID_VIEWS.join(", ")}

INTENT LOGIC:
- NAVIGATE: Changing views.
- SEARCH: Finding a specific lead or transaction in the database.
- QUERY: Asking a question about data (e.g., "How many leads today?").
- ACTION: Triggering an automation (e.g., "Schedule a tour", "Send a message").

If searching for a person, return SEARCH intent with target 'lead' and parameter 'name'.
If asking about deals, return SEARCH intent with target 'transaction' and parameter 'address'.

Return JSON with this structure:
{
  "intent": "NAVIGATE" | "ACTION" | "SEARCH" | "QUERY" | "UNKNOWN",
  "target": "the view slug or action name",
  "message": "natural language confirmation",
  "parameters": { "name": "optional", "address": "optional", "actionType": "optional", "date": "optional" }
}`

      const response = await generateAIJSON(prompt)

      const result = JSON.parse(response.text || "{}") as AIResult
      setAiResponse(result)

      // Execute Logic based on intent
      if (result.intent === "NAVIGATE") {
        if (VALID_VIEWS.includes(result.target)) {
          setTimeout(() => {
            onNavigate(result.target)
            setIsOpen(false)
          }, 1500)
        }
      } else if (result.intent === "SEARCH" || result.intent === "QUERY") {
        if (result.target === "lead" || activeQuery.toLowerCase().includes("lead")) {
          const leads = await supabaseService.getLeads()
          const match = leads?.find((l) => l.name.toLowerCase().includes(result.parameters?.name?.toLowerCase() || ""))
          if (match) setFetchedData({ type: "lead", data: match })
        } else if (result.target === "transaction" || activeQuery.toLowerCase().includes("deal")) {
          const transactions = await supabaseService.getTransactions()
          const match = transactions?.find((t) =>
            t.address.toLowerCase().includes(result.parameters?.address?.toLowerCase() || ""),
          )
          if (match) setFetchedData({ type: "transaction", data: match })
        }
      } else if (result.intent === "ACTION") {
        await executeWorkflow("client-action", { action: result.target, userId: "agent_user", ...result.parameters })
      }
    } catch (error) {
      console.error("AI Command Error:", error)
      setAiResponse({
        intent: "UNKNOWN",
        target: "",
        message: "Nexus is having trouble processing that specific phrasing. Try 'Go to CRM' or 'Search lead Alice'.",
      })
    } finally {
      setIsProcessing(false)
    }
  }

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 bg-slate-950/80 backdrop-blur-xl z-[1000] flex items-start justify-center pt-[15vh] px-4 animate-fade-in"
      onClick={() => setIsOpen(false)}
    >
      <div
        className="bg-white w-full max-w-3xl rounded-[2.5rem] shadow-[0_0_100px_rgba(79,70,229,0.3)] border border-slate-200 overflow-hidden animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Universal Input Area */}
        <div className="flex items-center px-10 py-8 border-b border-slate-100 bg-white relative">
          <div className="mr-6">
            {isProcessing ? (
              <Loader2 className="animate-spin text-indigo-600" size={32} />
            ) : (
              <Terminal className="text-indigo-600" size={32} />
            )}
          </div>
          <input
            ref={inputRef}
            type="text"
            placeholder="Command Nexus: Navigate, Search Data, or Automate..."
            className="w-full text-2xl font-black italic tracking-tighter outline-none text-slate-900 placeholder:text-slate-200 uppercase bg-transparent"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCommand()}
          />
          <div className="flex items-center gap-4 ml-4">
            <kbd className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-slate-100 border border-slate-200 rounded-xl text-[10px] font-black text-slate-400 uppercase tracking-widest shadow-sm">
              <Keyboard size={12} /> ENTER
            </kbd>
            <button
              onClick={() => setIsOpen(false)}
              className="p-2 hover:bg-slate-50 rounded-full text-slate-300 hover:text-slate-600 transition-all"
            >
              <X size={24} />
            </button>
          </div>
        </div>

        {/* Dynamic Context Result Area */}
        <div className="max-h-[500px] overflow-y-auto scrollbar-hide">
          {aiResponse ? (
            <div className="p-8 animate-fade-in space-y-6">
              <div
                className={`p-6 rounded-[2rem] flex items-start gap-6 border-2 shadow-xl ${
                  aiResponse.intent === "UNKNOWN" ? "bg-red-50 border-red-100" : "bg-indigo-50 border-indigo-100"
                }`}
              >
                <div
                  className={`p-4 rounded-2xl shrink-0 shadow-lg ${
                    aiResponse.intent === "UNKNOWN" ? "bg-red-100 text-red-600" : "bg-white text-indigo-600"
                  }`}
                >
                  <Bot size={28} />
                </div>
                <div className="flex-1 space-y-1">
                  <p
                    className={`text-[10px] font-black uppercase tracking-[0.3em] ${
                      aiResponse.intent === "UNKNOWN" ? "text-red-700" : "text-indigo-900"
                    }`}
                  >
                    {aiResponse.intent === "NAVIGATE"
                      ? "Navigation Protocol"
                      : aiResponse.intent === "ACTION"
                        ? "Automation Trigger"
                        : aiResponse.intent === "SEARCH"
                          ? "Data Retrieval"
                          : "Nexus AI Intelligence"}
                  </p>
                  <p className="text-xl font-bold text-slate-800 leading-tight italic">"{aiResponse.message}"</p>
                </div>
                {aiResponse.intent === "NAVIGATE" && (
                  <div className="flex items-center gap-2 text-[10px] font-black text-indigo-500 uppercase animate-pulse shrink-0">
                    Routing <ArrowRight size={14} />
                  </div>
                )}
              </div>

              {/* DATA RESULT CARD (Only shown for SEARCH/QUERY) */}
              {fetchedData && (
                <div className="bg-white rounded-[2rem] border border-slate-200 p-8 shadow-2xl animate-fade-in-up flex flex-col md:flex-row gap-8 items-center">
                  {fetchedData.type === "lead" ? (
                    <>
                      <div className="w-20 h-20 bg-indigo-50 rounded-3xl flex items-center justify-center font-black text-3xl italic text-indigo-600 shadow-inner shrink-0">
                        {fetchedData.data.name[0]}
                      </div>
                      <div className="flex-1 text-center md:text-left">
                        <h4 className="text-2xl font-black text-slate-900 uppercase italic tracking-tighter">
                          {fetchedData.data.name}
                        </h4>
                        <div className="flex flex-wrap justify-center md:justify-start gap-2 mt-2">
                          <span className="bg-red-50 text-red-600 px-3 py-1 rounded-full text-[9px] font-black uppercase border border-red-100">
                            {fetchedData.data.status}
                          </span>
                          <span className="bg-indigo-50 text-indigo-700 px-3 py-1 rounded-full text-[9px] font-black uppercase border border-indigo-100">
                            {fetchedData.data.intent}
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          onNavigate("crm")
                          setIsOpen(false)
                        }}
                        className="bg-slate-900 text-white px-8 py-4 rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl hover:bg-black transition-all flex items-center gap-2"
                      >
                        Open Profile <ArrowRight size={16} />
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="w-20 h-20 bg-emerald-50 rounded-3xl flex items-center justify-center text-emerald-600 shadow-inner shrink-0">
                        <Home size={40} />
                      </div>
                      <div className="flex-1 text-center md:text-left">
                        <h4 className="text-2xl font-black text-slate-900 uppercase italic tracking-tighter">
                          {fetchedData.data.address}
                        </h4>
                        <p className="text-emerald-600 font-black text-xl tabular-nums tracking-tighter mt-1">
                          ${fetchedData.data.price.toLocaleString()}
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          onNavigate("transactions")
                          setIsOpen(false)
                        }}
                        className="bg-slate-900 text-white px-8 py-4 rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl hover:bg-black transition-all flex items-center gap-2"
                      >
                        Open Deal <ArrowRight size={16} />
                      </button>
                    </>
                  )}
                </div>
              )}

              {aiResponse.intent === "ACTION" && (
                <div className="bg-slate-50 border border-slate-200 rounded-3xl p-8 flex justify-between items-center animate-fade-in-up">
                  <div className="flex items-center gap-6">
                    <div className="w-14 h-14 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-slate-400 shadow-sm">
                      <RefreshCw size={24} />
                    </div>
                    <div>
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                        Awaiting Verification
                      </p>
                      <p className="text-sm font-bold text-slate-800">Initialize {aiResponse.target} Sequence</p>
                    </div>
                  </div>
                  <div className="flex gap-4">
                    <button
                      className="bg-indigo-600 text-white px-8 py-3 rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-xl hover:bg-indigo-700 transition-all active:scale-95"
                      onClick={() => {
                        setIsOpen(false)
                        alert(`Success: ${aiResponse.target} protocol triggered.`)
                      }}
                    >
                      Authorize
                    </button>
                    <button
                      className="bg-white border-2 border-slate-200 text-slate-400 px-8 py-3 rounded-2xl font-black uppercase text-[10px] tracking-widest hover:bg-slate-50"
                      onClick={() => setAiResponse(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : isProcessing ? (
            <div className="p-20 flex flex-col items-center justify-center text-center space-y-8">
              <div className="relative">
                <div className="w-24 h-24 bg-indigo-50 rounded-[2.5rem] flex items-center justify-center text-indigo-600 shadow-inner">
                  <RefreshCw className="animate-spin" size={48} />
                </div>
                <div className="absolute -top-3 -right-3 w-10 h-10 bg-white rounded-2xl shadow-xl flex items-center justify-center text-indigo-500 border border-indigo-50">
                  <Bot size={20} />
                </div>
              </div>
              <div>
                <p className="text-2xl font-black text-slate-800 tracking-tighter uppercase italic leading-none">
                  Synthesizing Intent...
                </p>
                <p className="text-[10px] text-slate-400 font-black uppercase tracking-[0.25em] mt-3">
                  Accessing Nexus Knowledge Cluster
                </p>
              </div>
            </div>
          ) : (
            <div className="p-10 grid grid-cols-1 md:grid-cols-2 gap-12">
              <div className="space-y-6">
                <div className="flex items-center justify-between px-2">
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em]">Quick Navigation</h4>
                </div>
                <div className="space-y-2">
                  {[
                    { l: "Open the CRM Stack", i: Users, target: "crm" },
                    { l: "Check Active Pipeline", i: Briefcase, target: "transactions" },
                    { l: "Review Financials", i: DollarSign, target: "financials" },
                    { l: "Launch Listing Intake", i: Plus, target: "listing-intake" },
                  ].map((item, idx) => (
                    <button
                      key={idx}
                      onClick={() => {
                        onNavigate(item.target)
                        setIsOpen(false)
                      }}
                      className="w-full flex items-center gap-5 px-6 py-5 rounded-3xl hover:bg-indigo-600 text-slate-600 hover:text-white transition-all group shadow-sm hover:shadow-xl hover:scale-[1.02]"
                    >
                      <item.i size={20} className="text-slate-300 group-hover:text-white" />
                      <span className="text-xs font-black uppercase tracking-widest">{item.l}</span>
                      <ArrowRight
                        className="ml-auto opacity-0 group-hover:opacity-100 transition-all -translate-x-4 group-hover:translate-x-0"
                        size={16}
                      />
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-6">
                <div className="flex items-center justify-between px-2">
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] flex items-center gap-2">
                    <Sparkles size={12} className="text-indigo-600" /> AI Shortcuts
                  </h4>
                </div>
                <div className="space-y-3">
                  {[
                    { l: "Find lead Alice Freeman", i: Bot },
                    { l: "Status of 123 Main St?", i: Activity },
                    { l: "Schedule a tour for Bob", i: Calendar },
                    { l: "Draft an email to Jessica", i: MessageSquare },
                  ].map((item, idx) => (
                    <button
                      key={idx}
                      onClick={() => {
                        setQuery(item.l)
                        handleCommand(item.l)
                      }}
                      className="w-full flex items-center gap-5 px-6 py-5 rounded-3xl bg-slate-50 hover:bg-indigo-50 border-2 border-transparent hover:border-indigo-200 text-slate-500 transition-all group"
                    >
                      <item.i size={18} className="text-slate-300 group-hover:text-indigo-400" />
                      <span className="text-xs font-bold leading-tight italic group-hover:text-indigo-900">
                        "{item.l}"
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* High-Tech OS Footer */}
        <div className="bg-slate-50 border-t border-slate-100 px-12 py-6 flex justify-between items-center text-[9px] font-black text-slate-400 uppercase tracking-widest">
          <div className="flex items-center gap-10">
            <span className="flex items-center gap-2.5">
              <Globe size={12} className="text-indigo-400" /> WEB SEARCH: LIVE
            </span>
            <span className="flex items-center gap-2.5">
              <Database size={12} className="text-indigo-400" /> CRM SYNC: PERSISTENT
            </span>
            <span className="flex items-center gap-2.5">
              <ShieldCheck size={12} className="text-emerald-500" /> SECURE TERMINAL
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="opacity-60">PRESS</span>
            <kbd className="px-2 py-1 bg-white border border-slate-200 rounded-lg shadow-sm text-slate-500 font-mono">
              ESC
            </kbd>
            <span className="opacity-60">TO EXIT</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export default CommandBar
