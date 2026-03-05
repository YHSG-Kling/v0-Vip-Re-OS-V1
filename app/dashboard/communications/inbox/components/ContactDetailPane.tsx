"use client"

import { Mail, Phone, User, TrendingUp, Circle } from "lucide-react"
import { cn } from "@/lib/utils"

type ConversationContact = {
  id: string
  first_name?: string
  last_name?: string
  email?: string
  phone?: string
  lifecycle_state?: string
  lead_score?: number
}

interface ContactDetailPaneProps {
  contact: ConversationContact | null
  sentimentSummary?: {
    sentiment: string
    urgency: string
    keyTopics?: string[]
    requiresImmediateAction?: boolean
  } | null
}

const LIFECYCLE_COLOR: Record<string, string> = {
  lead:               "text-blue-600",
  prospect:           "text-purple-600",
  new_contact:        "text-green-600",
  representation:     "text-orange-600",
  active_transaction: "text-red-600",
  isa_qualifying:     "text-indigo-600",
  assigned:           "text-teal-600",
}

const SENTIMENT_COLOR: Record<string, string> = {
  very_positive: "text-emerald-600",
  positive:      "text-green-600",
  neutral:       "text-muted-foreground",
  negative:      "text-orange-600",
  very_negative: "text-destructive",
  urgent:        "text-destructive",
}

const URGENCY_COLOR: Record<string, string> = {
  low:      "text-green-600",
  medium:   "text-amber-600",
  high:     "text-orange-600",
  critical: "text-destructive",
}

function scoreColor(score?: number) {
  if (!score) return "text-muted-foreground"
  if (score >= 80) return "text-green-600"
  if (score >= 50) return "text-amber-600"
  return "text-destructive"
}

export default function ContactDetailPane({ contact, sentimentSummary }: ContactDetailPaneProps) {
  if (!contact) {
    return (
      <div className="w-64 border-l border-border bg-background flex items-center justify-center text-sm text-muted-foreground p-4 text-center">
        Select a conversation to see contact details
      </div>
    )
  }

  const name = `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Unknown"
  const lc = contact.lifecycle_state ?? ""

  return (
    <div className="w-64 border-l border-border bg-background overflow-y-auto shrink-0">
      <div className="p-4 space-y-4">
        {/* Contact header */}
        <div className="flex flex-col items-center text-center gap-2 pt-2">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
            <User size={22} className="text-primary" />
          </div>
          <div>
            <p className="font-semibold text-sm text-foreground">{name}</p>
            {lc && (
              <span className={cn("text-xs font-medium capitalize", LIFECYCLE_COLOR[lc] ?? "text-muted-foreground")}>
                {lc.replace(/_/g, " ")}
              </span>
            )}
          </div>
        </div>

        {/* Score */}
        {contact.lead_score !== undefined && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground flex items-center gap-1"><TrendingUp size={13} /> Lead Score</span>
            <span className={cn("font-bold text-base", scoreColor(contact.lead_score))}>
              {contact.lead_score}
            </span>
          </div>
        )}

        {/* Contact info */}
        <div className="space-y-2">
          {contact.email && (
            <a href={`mailto:${contact.email}`} className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors truncate">
              <Mail size={12} className="shrink-0" />
              <span className="truncate">{contact.email}</span>
            </a>
          )}
          {contact.phone && (
            <a href={`tel:${contact.phone}`} className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors">
              <Phone size={12} className="shrink-0" />
              <span>{contact.phone}</span>
            </a>
          )}
        </div>

        {/* Sentiment */}
        {sentimentSummary && (
          <div className="border border-border rounded-lg p-3 space-y-2">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">AI Sentiment</p>

            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Sentiment</span>
              <span className={cn("font-medium capitalize", SENTIMENT_COLOR[sentimentSummary.sentiment] ?? "text-foreground")}>
                {sentimentSummary.sentiment?.replace(/_/g, " ")}
              </span>
            </div>

            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Urgency</span>
              <span className={cn("font-medium capitalize", URGENCY_COLOR[sentimentSummary.urgency] ?? "text-foreground")}>
                {sentimentSummary.urgency}
              </span>
            </div>

            {sentimentSummary.requiresImmediateAction && (
              <div className="flex items-center gap-1.5 text-xs text-destructive bg-destructive/5 rounded px-2 py-1">
                <Circle size={6} className="fill-destructive" />
                Requires immediate action
              </div>
            )}

            {sentimentSummary.keyTopics && sentimentSummary.keyTopics.length > 0 && (
              <div>
                <p className="text-[10px] text-muted-foreground mb-1">Key Topics</p>
                <div className="flex flex-wrap gap-1">
                  {sentimentSummary.keyTopics.slice(0, 5).map(t => (
                    <span key={t} className="text-[10px] bg-muted px-1.5 py-0.5 rounded-full text-foreground">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* View profile link */}
        <a
          href={`/dashboard/contacts/${contact.id}`}
          className="block text-center text-xs text-primary hover:underline pt-1"
        >
          View full profile →
        </a>
      </div>
    </div>
  )
}
