"use client"

import { CheckCircle2, XCircle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export interface VoiceCommandRow {
  id: string
  command_type: string | null
  raw_transcript: string | null
  action_taken: string | null
  success: boolean | null
  confidence_score: number | null
  created_at: string
}

interface RecentCommandsFeedProps {
  commands: VoiceCommandRow[]
}

function confidenceColor(score: number | null): string {
  if (score === null) return "text-muted-foreground"
  if (score >= 0.8) return "text-green-600"
  if (score >= 0.6) return "text-amber-500"
  return "text-red-500"
}

function relativeTime(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export function RecentCommandsFeed({ commands }: RecentCommandsFeedProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold">Recent Commands</CardTitle>
      </CardHeader>
      <CardContent>
        {commands.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            No voice commands yet. Tap the mic or use a quick command above.
          </p>
        ) : (
          <ul className="space-y-2">
            {commands.map((cmd) => (
              <li
                key={cmd.id}
                className="flex items-start gap-3 rounded-lg border border-border bg-background p-3 text-xs"
              >
                {/* Success/fail icon */}
                <div className="mt-0.5 shrink-0">
                  {cmd.success ? (
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-500" />
                  )}
                </div>

                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-1">
                    {cmd.command_type && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        {cmd.command_type}
                      </Badge>
                    )}
                    <span className="text-muted-foreground truncate max-w-[180px]">
                      {cmd.raw_transcript
                        ? cmd.raw_transcript.length > 80
                          ? cmd.raw_transcript.slice(0, 80) + "…"
                          : cmd.raw_transcript
                        : "—"}
                    </span>
                  </div>

                  {cmd.action_taken && (
                    <p className="text-muted-foreground italic">{cmd.action_taken}</p>
                  )}

                  <div className="flex items-center gap-2 text-muted-foreground">
                    {cmd.confidence_score !== null && (
                      <span className={cn("font-medium", confidenceColor(cmd.confidence_score))}>
                        {Math.round(cmd.confidence_score * 100)}% confidence
                      </span>
                    )}
                    <span>{relativeTime(cmd.created_at)}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
