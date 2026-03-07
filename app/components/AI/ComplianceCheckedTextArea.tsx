"use client"

import type React from "react"
import { useState } from "react"
import { AlertTriangle, CheckCircle2, Loader2, Sparkles, Wand2 } from "lucide-react"
import { workflowService } from "../../services/workflowService"
import { supabaseService } from "../../services/supabaseService"
import { useAuth } from "@/lib/auth/client"
import type { ComplianceContentType, FlaggedPhrase } from "../../types"

interface ComplianceCheckedTextAreaProps {
  value: string
  onChange: (val: string) => void
  onSend: (val: string) => void
  contentType: ComplianceContentType
  placeholder?: string
  className?: string
  rows?: number
  sendLabel?: string
}

export const ComplianceCheckedTextArea: React.FC<ComplianceCheckedTextAreaProps> = ({
  value,
  onChange,
  onSend,
  contentType,
  placeholder,
  className,
  rows = 5,
  sendLabel = "Send Securely",
}) => {
  const { user } = useAuth()
  const [complianceResult, setComplianceResult] = useState<any>(null)
  const [isChecking, setIsChecking] = useState(false)
  const [showWarning, setShowWarning] = useState(false)

  const checkCompliance = async () => {
    if (!value || value.length < 10) return { blocked: false }

    setIsChecking(true)
    const result = await workflowService.checkFairHousingCompliance(user?.id || "agent_1", contentType, value)

    setIsChecking(false)
    setComplianceResult(result)

    if (result.blocked) {
      setShowWarning(true)
    }

    return result
  }

  const handleSend = async () => {
    const result = await checkCompliance()
    if (result.blocked) return
    onSend(value)
  }

  const handleOverride = async () => {
    const reason = prompt("Why are you overriding this Fair Housing warning? (Required for brokerage audit trail)")
    if (!reason) return

    if (complianceResult?.flagId) {
      await supabaseService.updateComplianceFlag(complianceResult.flagId, "overridden", reason)
    }

    setShowWarning(false)
    onSend(value)
  }

  const useReplacement = (original: string, replacement: string) => {
    const newText = value.replace(original, replacement)
    onChange(newText)
    setComplianceResult(null)
    setShowWarning(false)
  }

  return (
    <div className="space-y-3">
      <div className="relative group">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={checkCompliance}
          placeholder={placeholder}
          className={`w-full p-6 bg-slate-50 border-2 border-slate-200 rounded-[2rem] font-medium text-sm focus:ring-2 focus:ring-indigo-600 outline-none transition-all shadow-inner resize-none ${className}`}
          rows={rows}
        />
        <div className="absolute top-4 right-4 flex items-center gap-2">
          {isChecking ? (
            <div className="bg-white/80 backdrop-blur-md px-3 py-1.5 rounded-xl flex items-center gap-2 border border-indigo-100 shadow-lg">
              <Loader2 size={14} className="animate-spin text-indigo-600" />
              <span className="text-[9px] font-black uppercase text-indigo-600 tracking-widest">AI Audit...</span>
            </div>
          ) : complianceResult && !complianceResult.blocked ? (
            <div className="bg-emerald-50 px-3 py-1.5 rounded-xl flex items-center gap-2 border border-emerald-200 shadow-sm animate-fade-in">
              <CheckCircle2 size={14} className="text-emerald-600" />
              <span className="text-[9px] font-black uppercase text-emerald-600 tracking-widest">Compliant</span>
            </div>
          ) : null}
        </div>
      </div>

      {showWarning && complianceResult?.blocked && (
        <div className="p-6 bg-red-50 border-2 border-red-300 rounded-[2rem] animate-fade-in shadow-xl ring-4 ring-red-100">
          <div className="flex items-start gap-4">
            <div className="p-3 bg-red-600 text-white rounded-2xl shadow-lg shrink-0">
              <AlertTriangle size={24} />
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="font-black text-red-900 uppercase tracking-tighter italic text-lg mb-2 leading-none">
                Fair Housing Violation Detected.
              </h4>
              <p className="text-xs text-red-700 font-bold uppercase tracking-widest mb-4">
                Risk Level: {complianceResult.overall_severity}
              </p>

              <div className="space-y-3">
                {complianceResult.flaggedPhrases?.map((phrase: FlaggedPhrase, idx: number) => (
                  <div
                    key={idx}
                    className="bg-white p-4 rounded-2xl border border-red-100 shadow-sm flex flex-col gap-3"
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">
                          Flagged Phrase
                        </p>
                        <p className="text-sm font-black text-red-600 uppercase tracking-tight italic leading-none">
                          "{phrase.phrase}"
                        </p>
                      </div>
                      <span className="bg-red-50 text-red-600 px-2 py-0.5 rounded text-[8px] font-black uppercase border border-red-100">
                        {phrase.violation_type}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 italic font-medium leading-relaxed">"{phrase.reason}"</p>

                    {phrase.suggested_replacement && (
                      <div className="pt-3 border-t border-slate-50">
                        <p className="text-[9px] font-black text-emerald-600 uppercase tracking-[0.2em] mb-2 flex items-center gap-1.5">
                          <Sparkles size={10} /> AI Alternative
                        </p>
                        <div
                          className="flex items-center justify-between gap-4 p-3 bg-emerald-50/50 border border-emerald-100 rounded-xl group/alt hover:bg-emerald-50 transition-all cursor-pointer"
                          onClick={() => {
                            const newText = value.replace(phrase.phrase, phrase.suggested_replacement)
                            onChange(newText)
                            setComplianceResult(null)
                            setShowWarning(false)
                          }}
                        >
                          <p className="text-xs font-bold text-emerald-900 italic">"{phrase.suggested_replacement}"</p>
                          <button className="bg-emerald-600 text-white p-1.5 rounded-lg shadow-md group-hover/alt:scale-110 transition-transform">
                            <Wand2 size={12} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="mt-8 flex gap-3">
                <button
                  onClick={() => setShowWarning(false)}
                  className="flex-1 py-3 bg-white border-2 border-slate-200 text-slate-700 rounded-xl font-black uppercase text-[10px] tracking-widest hover:bg-slate-50 transition-all"
                >
                  Edit Manually
                </button>
                <button
                  onClick={handleOverride}
                  className="flex-1 py-3 bg-red-600 text-white rounded-xl font-black uppercase text-[10px] tracking-widest hover:bg-red-700 shadow-lg active:scale-95 transition-all border-b-4 border-red-900"
                >
                  Override & Send
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <button
        onClick={handleSend}
        disabled={isChecking}
        className={`w-full py-4 rounded-[1.5rem] font-black uppercase text-xs tracking-[0.25em] shadow-xl transition-all active:scale-95 border-b-4 ${
          isChecking
            ? "bg-slate-200 text-slate-400 border-slate-300"
            : "bg-slate-900 text-white hover:bg-black border-indigo-600"
        }`}
      >
        {isChecking ? (
          <div className="flex items-center justify-center gap-2">
            <Loader2 size={18} className="animate-spin" /> Verifying Compliance...
          </div>
        ) : (
          sendLabel
        )}
      </button>
    </div>
  )
}
