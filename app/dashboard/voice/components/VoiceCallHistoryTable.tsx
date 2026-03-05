"use client"

import { useState } from "react"
import { Play, ShieldCheck, ShieldX, ChevronDown, ChevronUp } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export interface VoiceCallRow {
  id: string
  contact_name: string | null
  phone_to: string | null
  phone_from: string | null
  direction: string | null
  call_type: string | null
  duration_seconds: number | null
  outcome: string | null
  sentiment: string | null
  recording_url: string | null
  compliance_passed: boolean | null
  transcription: string | null
  created_at: string
}

function formatDuration(secs: number | null): string {
  if (secs === null || secs === 0) return "—"
  const m = Math.floor(secs / 60).toString().padStart(2, "0")
  const s = (secs % 60).toString().padStart(2, "0")
  return `${m}:${s}`
}

const DIRECTION_BADGE: Record<string, string> = {
  inbound: "bg-blue-500/10 text-blue-700 border-blue-200",
  outbound: "bg-green-500/10 text-green-700 border-green-200",
}

const OUTCOME_BADGE: Record<string, string> = {
  appointment_set: "bg-green-500/10 text-green-700 border-green-200",
  not_interested: "bg-red-500/10 text-red-700 border-red-200",
  voicemail_left: "bg-slate-200 text-slate-600 border-slate-300",
  no_answer: "bg-slate-200 text-slate-600 border-slate-300",
  authority_blocked: "bg-orange-500/10 text-orange-700 border-orange-200",
  completed: "bg-green-500/10 text-green-700 border-green-200",
}

const SENTIMENT_BADGE: Record<string, string> = {
  positive: "bg-green-500/10 text-green-700 border-green-200",
  neutral: "bg-slate-200 text-slate-600 border-slate-300",
  negative: "bg-red-500/10 text-red-700 border-red-200",
}

interface VoiceCallHistoryTableProps {
  calls: VoiceCallRow[]
}

export function VoiceCallHistoryTable({ calls }: VoiceCallHistoryTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold">Voice Call History</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {calls.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground px-4">
            No calls recorded yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="px-4 py-2 text-left font-medium text-muted-foreground">Contact</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Dir</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Type</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Duration</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Outcome</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Sentiment</th>
                  <th className="px-3 py-2 text-center font-medium text-muted-foreground">Compliance</th>
                  <th className="px-3 py-2 text-center font-medium text-muted-foreground">Audio</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {calls.map((call) => {
                  const isExpanded = expanded.has(call.id)
                  const displayName = call.contact_name || call.phone_to || call.phone_from || "Unknown"
                  return (
                    <>
                      <tr
                        key={call.id}
                        className="border-b border-border hover:bg-muted/20 transition-colors"
                      >
                        <td className="px-4 py-2.5 font-medium text-foreground max-w-[120px] truncate">
                          {displayName}
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[10px] px-1.5 py-0",
                              DIRECTION_BADGE[call.direction ?? ""] ?? ""
                            )}
                          >
                            {call.direction ?? "—"}
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground">
                          {call.call_type ?? "—"}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-muted-foreground">
                          {formatDuration(call.duration_seconds)}
                        </td>
                        <td className="px-3 py-2.5">
                          {call.outcome ? (
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px] px-1.5 py-0 capitalize",
                                OUTCOME_BADGE[call.outcome] ?? ""
                              )}
                            >
                              {call.outcome.replace(/_/g, " ")}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          {call.sentiment ? (
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px] px-1.5 py-0 capitalize",
                                SENTIMENT_BADGE[call.sentiment] ?? ""
                              )}
                            >
                              {call.sentiment}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          {call.compliance_passed === true ? (
                            <ShieldCheck className="h-4 w-4 text-green-500 mx-auto" />
                          ) : call.compliance_passed === false ? (
                            <ShieldX className="h-4 w-4 text-red-500 mx-auto" />
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          {call.recording_url ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              asChild
                            >
                              <a href={call.recording_url} target="_blank" rel="noreferrer">
                                <Play className="h-3 w-3" />
                                <span className="sr-only">Play recording</span>
                              </a>
                            </Button>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          {call.transcription && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => toggle(call.id)}
                              aria-label={isExpanded ? "Collapse transcript" : "Expand transcript"}
                            >
                              {isExpanded ? (
                                <ChevronUp className="h-3 w-3" />
                              ) : (
                                <ChevronDown className="h-3 w-3" />
                              )}
                            </Button>
                          )}
                        </td>
                      </tr>

                      {isExpanded && call.transcription && (
                        <tr key={`${call.id}-transcript`} className="border-b border-border bg-muted/10">
                          <td colSpan={9} className="px-4 py-3">
                            <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
                              {call.transcription}
                            </p>
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
