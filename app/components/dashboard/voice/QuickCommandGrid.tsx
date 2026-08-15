"use client"

import {
  ClipboardList,
  CheckSquare,
  Home,
  MessageSquare,
  Search,
  FileEdit,
  BarChart2,
  TrendingUp,
  Mic,
  ShieldCheck,
  Navigation,
  Tag,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

interface QuickCommandTile {
  id: number
  icon: React.ElementType
  label: string
  command: string
}

const TILES: QuickCommandTile[] = [
  { id: 1, icon: ClipboardList, label: "Daily Briefing", command: "Give me my daily briefing" },
  { id: 2, icon: CheckSquare, label: "Create Task", command: "Create a new task" },
  { id: 3, icon: Home, label: "Schedule Showing", command: "Schedule a showing" },
  { id: 4, icon: MessageSquare, label: "Send Message", command: "Send a message" },
  { id: 5, icon: Search, label: "Find Contact", command: "Find a contact" },
  { id: 6, icon: FileEdit, label: "Log Activity", command: "Log an activity" },
  { id: 7, icon: BarChart2, label: "Pipeline View", command: "Show my pipeline" },
  { id: 8, icon: TrendingUp, label: "Pull Report", command: "Pull a report" },
  { id: 9, icon: Mic, label: "Dictate Note", command: "Dictate a note" },
  { id: 10, icon: ShieldCheck, label: "Check Compliance", command: "Check compliance status" },
  { id: 11, icon: Navigation, label: "Navigate To", command: "Navigate to dashboard" },
  { id: 12, icon: Tag, label: "Update Lead", command: "Update lead status" },
]

interface QuickCommandGridProps {
  onCommand: (command: string) => void
  isDisabled?: boolean
}

export function QuickCommandGrid({ onCommand, isDisabled }: QuickCommandGridProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold">Quick Commands</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {TILES.map((tile) => {
            const Icon = tile.icon
            return (
              <button
                key={tile.id}
                onClick={() => onCommand(tile.command)}
                disabled={isDisabled}
                className={cn(
                  "flex flex-col items-center gap-2 rounded-lg border border-border bg-background p-3 text-center transition-colors hover:bg-muted hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  "disabled:opacity-50 disabled:cursor-not-allowed"
                )}
              >
                <Icon className="h-5 w-5 text-primary" />
                <span className="text-[10px] font-medium leading-tight text-foreground">{tile.label}</span>
              </button>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
