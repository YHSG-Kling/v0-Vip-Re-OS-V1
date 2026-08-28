"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { reviewAuditFlag, runWeeklyAIAudit } from "@/app/actions/conversation-analytics"
import FairHousingReviewCard, { type ReviewContact } from "./FairHousingReviewCard"

interface AuditFlag {
  id: string
  conversation_id: string
  risk_type: string
  risk_score: number
  explanation: string
  flagged_text: string | null
  recommended_action: string | null
  review_status: string
  created_at: string
  conversation?: {
    contact_id: string | null
    agent_id: string | null
    start_time: string | null
    topics_discussed: string[] | null
  } | null
}

interface ComplianceTabProps {
  flags: AuditFlag[]
  reviewerId: string
  /** Contacts for the Fair-Housing Review card — the restored contact-linked
   *  post-hoc review (analyzeFairHousingRisk, lane F2 2026-08-28). */
  reviewContacts: ReviewContact[]
}

const RISK_TYPE_COLORS: Record<string, string> = {
  fair_housing:            "bg-red-100 text-red-700 border-red-200",
  compliance:              "bg-orange-100 text-orange-700 border-orange-200",
  hallucination:           "bg-yellow-100 text-yellow-700 border-yellow-200",
  missed_opportunity:      "bg-blue-100 text-blue-700 border-blue-200",
  inappropriate_language:  "bg-red-100 text-red-700 border-red-200",
  data_leak:               "bg-red-100 text-red-700 border-red-200",
}

function riskScoreBadge(score: number) {
  if (score >= 8) return "bg-red-600 text-white"
  if (score >= 5) return "bg-orange-400 text-white"
  return "bg-blue-500 text-white"
}

function riskScoreLabel(score: number) {
  if (score >= 8) return "CRITICAL"
  if (score >= 5) return "WARNING"
  return "INFO"
}

function FlagRow({ flag, reviewerId, onUpdated }: { flag: AuditFlag; reviewerId: string; onUpdated: (id: string, newStatus: string, notes: string) => void }) {
  const [status, setStatus] = useState(flag.review_status)
  const [notes, setNotes] = useState("")
  const [showNotes, setShowNotes] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [saved, setSaved] = useState(false)

  function handleStatusChange(val: string) {
    setStatus(val)
    setShowNotes(val === "dismissed" || val === "reviewed")
  }

  function handleSave() {
    if ((status === "dismissed" || status === "reviewed") && !notes.trim()) return
    startTransition(async () => {
      const res = await reviewAuditFlag({
        flagId: flag.id,
        reviewerId,
        status: status as "reviewed" | "dismissed" | "escalated",
        resolutionNotes: notes || undefined,
      })
      if (res.success) {
        setSaved(true)
        onUpdated(flag.id, status, notes)
      }
    })
  }

  const isFH = flag.risk_type === "fair_housing"

  return (
    <div className={`border-l-4 rounded-r-lg bg-card p-4 space-y-3 ${isFH ? "border-l-red-500" : "border-l-orange-400"}`}>
      <div className="flex flex-wrap items-start gap-2">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${RISK_TYPE_COLORS[flag.risk_type] ?? "bg-gray-100 text-gray-700 border-gray-200"}`}>
          {isFH && "⚠ "}
          {flag.risk_type.replace(/_/g, " ")}
        </span>
        <span className={`px-2 py-0.5 rounded text-xs font-bold ${riskScoreBadge(flag.risk_score)}`}>
          {riskScoreLabel(flag.risk_score)} · {flag.risk_score}/10
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {new Date(flag.created_at).toLocaleDateString()}
        </span>
      </div>

      {flag.flagged_text && (
        <p className="text-sm italic text-muted-foreground border-l-2 border-border pl-3">
          &ldquo;{flag.flagged_text}&rdquo;
        </p>
      )}

      <p className="text-sm text-foreground">{flag.explanation}</p>

      {flag.recommended_action && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">Recommended: </span>{flag.recommended_action}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-muted-foreground">Status:</label>
          <select
            value={status}
            onChange={(e) => handleStatusChange(e.target.value)}
            disabled={saved}
            className="text-xs border border-border rounded px-2 py-1 bg-background text-foreground"
          >
            <option value="pending">Pending</option>
            <option value="reviewed">Reviewed</option>
            <option value="dismissed">Dismissed</option>
            <option value="escalated">Escalated</option>
          </select>
        </div>
        {!saved && (
          <button
            onClick={handleSave}
            disabled={isPending || (showNotes && !notes.trim())}
            className="text-xs px-3 py-1 bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-40"
          >
            {isPending ? "Saving…" : "Save"}
          </button>
        )}
        {saved && <span className="text-xs text-green-600 font-medium">Saved</span>}
      </div>

      {showNotes && !saved && (
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Resolution notes (required)"
          rows={2}
          className="w-full text-xs border border-border rounded px-2 py-1.5 bg-background text-foreground resize-none"
        />
      )}
    </div>
  )
}

export default function ComplianceTab({ flags, reviewerId, reviewContacts }: ComplianceTabProps) {
  const router = useRouter()
  const [localFlags, setLocalFlags] = useState(flags)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkPending, startBulk] = useTransition()
  // Wired (lane E2 2026-08-28): runWeeklyAIAudit had no caller anywhere — the
  // re-scan that CREATES audit flags was unreachable while this tab reviewed
  // them. The button runs it on demand for the caller's own scope (RLS-bound
  // session client inside the action) and reports the result honestly.
  const [auditPending, startAudit] = useTransition()
  const [auditResult, setAuditResult] = useState<string | null>(null)

  function handleRunAudit() {
    setAuditResult(null)
    startAudit(async () => {
      const res = await runWeeklyAIAudit()
      if (res.success) {
        setAuditResult(`Audited ${res.conversations_audited ?? 0} conversation${(res.conversations_audited ?? 0) === 1 ? "" : "s"}, ${res.flags_created ?? 0} new flag${(res.flags_created ?? 0) === 1 ? "" : "s"}.`)
        router.refresh()
      } else {
        setAuditResult(`Audit failed: ${res.error ?? "unknown error"}`)
      }
    })
  }

  const fairHousingFlags = localFlags.filter(f => f.risk_type === "fair_housing" && f.review_status === "pending")
  const allFlags = localFlags

  function handleUpdated(id: string, newStatus: string, notes: string) {
    setLocalFlags(prev => prev.map(f => f.id === id ? { ...f, review_status: newStatus, resolution_notes: notes } : f))
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function handleBulkAction(action: "reviewed" | "escalated") {
    startBulk(async () => {
      await Promise.all(
        Array.from(selectedIds).map(id =>
          reviewAuditFlag({ flagId: id, reviewerId, status: action })
        )
      )
      setLocalFlags(prev =>
        prev.map(f => selectedIds.has(f.id) ? { ...f, review_status: action } : f)
      )
      setSelectedIds(new Set())
    })
  }

  return (
    <div className="space-y-6">
      {/* Always-visible compliance notice — cannot be dismissed */}
      <div className="rounded-lg border border-orange-400 bg-orange-50 px-4 py-3 text-sm text-orange-800">
        <span className="font-semibold">{"⚠️ Fair Housing Compliance: "}</span>
        All flagged conversations require review within 24 hours of flagging. Violations must be reported to the supervising broker.
      </div>

      {/* Fair-Housing Review — contact-linked post-hoc review of one
          communication. Findings land in compliance_flags (the command
          center's flagged-content queue), distinct from the conversation
          audit flags reviewed below. */}
      <FairHousingReviewCard contacts={reviewContacts} />

      {/* Run the last-7-days compliance re-scan on demand */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={handleRunAudit}
          disabled={auditPending}
          className="text-xs px-3 py-1.5 bg-primary text-primary-foreground rounded hover:opacity-90 disabled:opacity-40"
        >
          {auditPending ? "Running audit…" : "Run AI audit (last 7 days)"}
        </button>
        {auditResult && <span className="text-xs text-muted-foreground">{auditResult}</span>}
      </div>

      {/* Fair Housing section */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-sm font-semibold text-foreground">Fair Housing Flags</h3>
          <span className="inline-flex items-center justify-center h-5 min-w-5 px-1.5 rounded-full bg-red-600 text-white text-[10px] font-bold">
            {fairHousingFlags.length}
          </span>
        </div>

        {fairHousingFlags.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center border border-border rounded-lg">
            No pending fair housing flags.
          </p>
        ) : (
          <div className="space-y-3">
            {fairHousingFlags.map(flag => (
              <FlagRow key={flag.id} flag={flag} reviewerId={reviewerId} onUpdated={handleUpdated} />
            ))}
          </div>
        )}
      </section>

      {/* All Flags table */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">
            All Flags
            <span className="ml-2 text-muted-foreground font-normal">({allFlags.length})</span>
          </h3>
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{selectedIds.size} selected</span>
              <button
                onClick={() => handleBulkAction("reviewed")}
                disabled={bulkPending}
                className="text-xs px-3 py-1 bg-green-600 text-white rounded hover:opacity-90 disabled:opacity-40"
              >
                Mark Reviewed
              </button>
              <button
                onClick={() => handleBulkAction("escalated")}
                disabled={bulkPending}
                className="text-xs px-3 py-1 bg-orange-600 text-white rounded hover:opacity-90 disabled:opacity-40"
              >
                Escalate to Broker
              </button>
            </div>
          )}
        </div>

        {allFlags.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center border border-border rounded-lg">
            No audit flags found.
          </p>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 w-8">
                      <input
                        type="checkbox"
                        onChange={(e) => {
                          if (e.target.checked) setSelectedIds(new Set(allFlags.map(f => f.id)))
                          else setSelectedIds(new Set())
                        }}
                        checked={selectedIds.size === allFlags.length && allFlags.length > 0}
                        className="rounded"
                      />
                    </th>
                    {["Risk Type","Score","Flagged Text","Explanation","Recommended Action","Status","Date"].map(h => (
                      <th key={h} className="px-3 py-2 text-left text-xs font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border bg-card">
                  {allFlags.map(flag => (
                    <tr key={flag.id} className={`hover:bg-muted/40 transition-colors ${selectedIds.has(flag.id) ? "bg-muted/20" : ""}`}>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(flag.id)}
                          onChange={() => toggleSelect(flag.id)}
                          className="rounded"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border ${RISK_TYPE_COLORS[flag.risk_type] ?? "bg-gray-100 text-gray-700 border-gray-200"}`}>
                          {flag.risk_type.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${riskScoreBadge(flag.risk_score)}`}>
                          {flag.risk_score}
                        </span>
                      </td>
                      <td className="px-3 py-2 max-w-[180px]">
                        {flag.flagged_text
                          ? <span className="italic text-muted-foreground text-xs truncate block">&ldquo;{flag.flagged_text}&rdquo;</span>
                          : <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                      <td className="px-3 py-2 max-w-[200px]">
                        <span className="text-xs text-foreground line-clamp-2">{flag.explanation}</span>
                      </td>
                      <td className="px-3 py-2 max-w-[180px]">
                        <span className="text-xs text-muted-foreground line-clamp-2">{flag.recommended_action ?? "—"}</span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium capitalize ${
                          flag.review_status === "pending"   ? "bg-yellow-100 text-yellow-700" :
                          flag.review_status === "escalated" ? "bg-orange-100 text-orange-700" :
                          flag.review_status === "reviewed"  ? "bg-green-100 text-green-700" :
                                                               "bg-gray-100 text-gray-600"
                        }`}>
                          {flag.review_status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(flag.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
