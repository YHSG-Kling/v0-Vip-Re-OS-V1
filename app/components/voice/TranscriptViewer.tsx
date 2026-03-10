"use client"

import { useState, useMemo } from "react"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Search, MessageSquare } from "lucide-react"
import { cn } from "@/lib/utils"

interface SpeakerTurn {
  speaker: "agent" | "contact" | "ai"
  text: string
  timestamp?: string
}

interface TranscriptViewerProps {
  fullText: string
  speakerTurns: SpeakerTurn[] | null
  whisperTimestamps?: { deliveredAt: string; text: string }[]
  onJumpToWhisper?: (timestamp: string) => void
}

export function TranscriptViewer({
  fullText,
  speakerTurns,
  whisperTimestamps = [],
  onJumpToWhisper,
}: TranscriptViewerProps) {
  const [searchQuery, setSearchQuery] = useState("")

  const turns = useMemo(() => {
    if (speakerTurns && speakerTurns.length > 0) {
      return speakerTurns
    }
    // Fallback: split full text into paragraphs if no speaker turns
    if (fullText) {
      return fullText.split("\n").filter(Boolean).map((text, i) => ({
        speaker: i % 2 === 0 ? "agent" : "contact",
        text,
        timestamp: undefined,
      })) as SpeakerTurn[]
    }
    return []
  }, [speakerTurns, fullText])

  const filteredTurns = useMemo(() => {
    if (!searchQuery.trim()) return turns
    return turns.filter((turn) =>
      turn.text.toLowerCase().includes(searchQuery.toLowerCase())
    )
  }, [turns, searchQuery])

  const getSpeakerLabel = (speaker: string) => {
    switch (speaker) {
      case "agent":
        return "Agent"
      case "contact":
        return "Contact"
      case "ai":
        return "AI"
      default:
        return speaker
    }
  }

  const getSpeakerColor = (speaker: string) => {
    switch (speaker) {
      case "agent":
        return "bg-blue-500/10 text-blue-700 border-blue-200"
      case "contact":
        return "bg-muted text-muted-foreground border-muted"
      case "ai":
        return "bg-purple-500/10 text-purple-700 border-purple-200"
      default:
        return "bg-muted text-muted-foreground"
    }
  }

  if (!fullText && (!speakerTurns || speakerTurns.length === 0)) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <MessageSquare className="h-12 w-12 text-muted-foreground/50 mb-4" />
        <p className="text-muted-foreground">
          Transcript not yet available — check back in a few minutes
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search within transcript..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {whisperTimestamps.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <span className="text-sm text-muted-foreground">Jump to whisper:</span>
          {whisperTimestamps.map((whisper, i) => (
            <Badge
              key={i}
              variant="outline"
              className="cursor-pointer hover:bg-accent"
              onClick={() => onJumpToWhisper?.(whisper.deliveredAt)}
            >
              {new Date(whisper.deliveredAt).toLocaleTimeString()}
            </Badge>
          ))}
        </div>
      )}

      <div className="space-y-3 max-h-[500px] overflow-y-auto pr-2">
        {filteredTurns.map((turn, index) => (
          <div
            key={index}
            className={cn(
              "flex flex-col gap-1",
              turn.speaker === "agent" ? "items-end" : "items-start"
            )}
          >
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium">{getSpeakerLabel(turn.speaker)}</span>
              {turn.timestamp && <span>{turn.timestamp}</span>}
            </div>
            <div
              className={cn(
                "max-w-[80%] rounded-lg px-4 py-2 border",
                getSpeakerColor(turn.speaker)
              )}
            >
              <p className="text-sm whitespace-pre-wrap">
                {searchQuery
                  ? highlightMatch(turn.text, searchQuery)
                  : turn.text}
              </p>
            </div>
          </div>
        ))}
      </div>

      {searchQuery && filteredTurns.length === 0 && (
        <p className="text-center text-muted-foreground py-4">
          No matches found for &quot;{searchQuery}&quot;
        </p>
      )}
    </div>
  )
}

function highlightMatch(text: string, query: string) {
  const parts = text.split(new RegExp(`(${query})`, "gi"))
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <mark key={i} className="bg-yellow-200 rounded px-0.5">
        {part}
      </mark>
    ) : (
      part
    )
  )
}
