"use client"

import type React from "react"
import { useState, useEffect } from "react"
import {
  Calculator,
  CheckSquare,
  FileText,
  Book,
  Clipboard,
  DollarSign,
  Home,
  Shield,
  Wrench,
  ChevronDown,
  Sparkles,
  TrendingUp,
  CheckCircle2,
} from "lucide-react"
import { supabaseService } from "@/services/supabaseService"
import type { PersonaType, JourneyStage, JourneyTool } from "@/types"
import { toast } from "sonner"

interface PersonaToolsProps {
  userId: string
  persona: PersonaType
  stage: JourneyStage
}

export const PersonaTools: React.FC<PersonaToolsProps> = ({ userId, persona, stage }) => {
  const [tools, setTools] = useState<JourneyTool[]>([])
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    loadTools()
  }, [persona, stage])

  const loadTools = async () => {
    setIsLoading(true)
    const toolsData = await supabaseService.getRecordsByField("journey_tools", "persona", persona)
    const filteredTools = toolsData.filter((t: any) => t.stage === stage)
    setTools(filteredTools as JourneyTool[])
    setIsLoading(false)
  }

  if (isLoading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-6 bg-slate-200 rounded w-1/4 mb-4"></div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="h-24 bg-slate-100 rounded-2xl"></div>
          <div className="h-24 bg-slate-100 rounded-2xl"></div>
        </div>
      </div>
    )
  }

  if (tools.length === 0) {
    return null
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 px-2">
        <h2 className="text-xl font-black text-slate-800 uppercase italic tracking-tighter leading-none">
          Your Tools.
        </h2>
        <div className="h-px flex-1 bg-slate-100"></div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {tools.map((tool) => (
          <ToolCard
            key={tool.id}
            tool={tool}
            userId={userId}
            isExpanded={expandedToolId === tool.id}
            onToggle={() => setExpandedToolId(expandedToolId === tool.id ? null : tool.id)}
          />
        ))}
      </div>
    </div>
  )
}

interface ToolCardProps {
  tool: JourneyTool
  userId: string
  isExpanded: boolean
  onToggle: () => void
}

const ToolCard: React.FC<ToolCardProps> = ({ tool, userId, isExpanded, onToggle }) => {
  const config = JSON.parse(tool.configJson || "{}")

  const getIcon = (iconName: string) => {
    const icons: Record<string, any> = {
      calculator: Calculator,
      check_square: CheckSquare,
      file_text: FileText,
      book: Book,
      clipboard: Clipboard,
      dollar_sign: DollarSign,
      home: Home,
      shield: Shield,
      wrench: Wrench,
      trending_up: TrendingUp,
    }
    return icons[iconName] || Calculator
  }

  const Icon = getIcon(tool.iconName)

  return (
    <div
      className={`bg-white border transition-all duration-300 rounded-[2rem] overflow-hidden ${
        isExpanded
          ? "border-indigo-500 shadow-xl ring-4 ring-indigo-50"
          : "border-slate-200 shadow-sm hover:border-indigo-300"
      }`}
    >
      {/* Tool Header */}
      <button
        onClick={onToggle}
        className="w-full p-6 flex items-center justify-between hover:bg-slate-50 transition-colors text-left"
      >
        <div className="flex items-center gap-4">
          <div
            className={`p-3 rounded-2xl transition-colors ${isExpanded ? "bg-indigo-600 text-white" : "bg-indigo-50 text-indigo-600"}`}
          >
            <Icon size={24} />
          </div>
          <div>
            <h3 className="font-black text-slate-900 uppercase tracking-tight italic leading-none mb-1">{tool.name}</h3>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{tool.description}</p>
          </div>
        </div>
        <ChevronDown
          className={`w-5 h-5 text-slate-400 transition-transform duration-500 ${
            isExpanded ? "rotate-180 text-indigo-600" : ""
          }`}
        />
      </button>

      {/* Tool Content (Expanded) */}
      {isExpanded && (
        <div className="p-8 border-t border-slate-100 bg-slate-50/50 animate-fade-in">
          {tool.type === "calculator" && <CalculatorTool config={config} tool={tool} />}
          {tool.type === "checklist" && <ChecklistTool config={config} tool={tool} userId={userId} />}
          {tool.type === "guide" && <GuideTool config={config} />}
        </div>
      )}
    </div>
  )
}

const CalculatorTool: React.FC<{ config: any; tool: JourneyTool }> = ({ config }) => {
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [result, setResult] = useState<number | null>(null)

  const handleInputChange = (fieldName: string, value: string) => {
    setInputs((prev) => ({
      ...prev,
      [fieldName]: value,
    }))
  }

  const calculate = () => {
    try {
      let calculation = config.formula

      Object.keys(inputs).forEach((key) => {
        const regex = new RegExp(key, "g")
        calculation = calculation.replace(regex, Number.parseFloat(inputs[key]) || 0)
      })

      // Simple evaluator for safe math strings provided in config
      // Note: In real production use a library like mathjs
      const resultValue = Function(`"use strict"; return (${calculation})`)()

      setResult(resultValue)
    } catch (error) {
      console.error("Calculation error:", error)
      toast.error("Calculation error — check your inputs")
    }
  }

  const formatResult = (value: number) => {
    if (config.result_format === "currency") {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(value)
    }
    if (config.result_format === "percentage") {
      return (value * 100).toFixed(1) + "%"
    }
    return value.toFixed(2)
  }

  return (
    <div className="space-y-6">
      {/* Input Fields */}
      <div className="space-y-4">
        {config.fields.map((field: any) => (
          <div key={field.name} className="space-y-1.5">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block px-1">
              {field.label}
              {field.required && <span className="text-red-500 ml-1">*</span>}
            </label>
            <div className="relative">
              <input
                type="number"
                value={inputs[field.name] || ""}
                onChange={(e) => handleInputChange(field.name, e.target.value)}
                placeholder={field.placeholder || "0"}
                className="w-full p-4 bg-white border border-slate-200 rounded-2xl font-black text-slate-800 outline-none focus:ring-2 focus:ring-indigo-600 transition-all shadow-inner"
                required={field.required}
              />
              {field.type === "currency" && (
                <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300 font-black">$</div>
              )}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={calculate}
        className="w-full py-4 bg-slate-900 text-white rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl hover:bg-black transition-all active:scale-95 border-b-4 border-indigo-600"
      >
        Execute Logic
      </button>

      {/* Result */}
      {result !== null && (
        <div className="p-6 bg-indigo-900 rounded-3xl text-white relative overflow-hidden group shadow-2xl border-b-4 border-indigo-600">
          <div className="absolute right-[-10px] top-[-10px] p-2 opacity-10 group-hover:rotate-12 transition-transform duration-700">
            <Sparkles size={100} />
          </div>
          <p className="text-[9px] font-black text-indigo-300 uppercase tracking-[0.3em] mb-2">{config.result_label}</p>
          <p className="text-4xl font-black italic tracking-tighter tabular-nums">{formatResult(result)}</p>
          {config.explanation && (
            <div className="mt-4 pt-4 border-t border-white/10">
              <p className="text-[10px] text-indigo-100 font-medium leading-relaxed italic">"{config.explanation}"</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const ChecklistTool: React.FC<{ config: any; tool: JourneyTool; userId: string }> = ({ config, tool }) => {
  // safety rule #4: NO localStorage. Use state for session-persistence.
  // Real world would save this to the User metadata field in Airtable.
  const [completedSteps, setCompletedSteps] = useState<string[]>([])

  const handleToggleStep = (stepId: string) => {
    setCompletedSteps((prev) => (prev.includes(stepId) ? prev.filter((id) => id !== stepId) : [...prev, stepId]))
  }

  const progress = Math.round((completedSteps.length / config.steps.length) * 100)

  return (
    <div className="space-y-6">
      {/* Progress Monitor */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-inner">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Protocol Completion</span>
          <span className="text-xs font-black text-indigo-600 tabular-nums">
            {completedSteps.length} / {config.steps.length}
          </span>
        </div>
        <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden p-0.5">
          <div
            className="bg-indigo-600 h-full rounded-full transition-all duration-700"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Checklist Steps */}
      <div className="space-y-2">
        {config.steps.map((step: any) => {
          const isCompleted = completedSteps.includes(step.id)

          return (
            <div
              key={step.id}
              onClick={() => handleToggleStep(step.id)}
              className={`flex items-start gap-4 p-4 rounded-2xl border transition-all cursor-pointer group ${
                isCompleted
                  ? "bg-slate-100 border-transparent"
                  : "bg-white border-slate-200 hover:border-indigo-400 shadow-sm"
              }`}
            >
              <div
                className={`mt-0.5 w-6 h-6 rounded-lg flex items-center justify-center transition-all ${
                  isCompleted
                    ? "bg-indigo-600 text-white rotate-0 scale-100"
                    : "bg-slate-50 text-slate-200 rotate-45 group-hover:text-indigo-400"
                }`}
              >
                {isCompleted ? <CheckSquare size={16} /> : <div className="w-1.5 h-1.5 bg-slate-200 rounded-full" />}
              </div>
              <div className="flex-1 min-w-0">
                <p
                  className={`text-sm font-bold leading-tight uppercase tracking-tight transition-all ${
                    isCompleted ? "line-through text-slate-300" : "text-slate-700"
                  }`}
                >
                  {step.text}
                </p>
                {step.help && (
                  <p className="text-[10px] text-slate-400 font-medium italic leading-relaxed mt-1 group-hover:text-slate-500 transition-colors">
                    "{step.help}"
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {progress === 100 && (
        <div className="p-4 bg-emerald-50 border border-emerald-100 rounded-2xl text-center flex items-center justify-center gap-2 animate-bounce-subtle">
          {/* Missing CheckCircle2 import was the cause of error on line 316 */}
          <CheckCircle2 className="text-emerald-600" size={18} />
          <p className="text-[10px] font-black text-emerald-800 uppercase tracking-widest">
            Protocol Verified & Complete
          </p>
        </div>
      )}
    </div>
  )
}

const GuideTool: React.FC<{ config: any }> = ({ config }) => {
  return (
    <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-inner">
      <div className="prose prose-sm max-w-none text-slate-600 text-sm font-medium leading-relaxed italic">
        <div dangerouslySetInnerHTML={{ __html: config.content }} />
      </div>
      <div className="mt-6 flex justify-end">
        <button className="text-[10px] font-black text-indigo-600 uppercase tracking-widest flex items-center gap-1 hover:underline">
          Download Resource <DownloadIcon size={12} />
        </button>
      </div>
    </div>
  )
}

const DownloadIcon = ({ size }: { size: number }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" x2="12" y1="15" y2="3" />
  </svg>
)
