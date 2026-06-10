"use client"

import { useState, useTransition, useCallback } from "react"
import { Mail, MessageSquare, Video, FileText, Phone, ExternalLink } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { getEngagementFeed, type EngagementFeedItem } from "@/app/actions/ai-isa"
import type { ISACampaignRow } from "@/app/actions/ai-isa"

const CHANNEL_ICON: Record<string, React.ReactNode> = {
  email:       <Mail className="h-3.5 w-3.5 text-blue-500" />,
  sms:         <MessageSquare className="h-3.5 w-3.5 text-green-500" />,
  video:       <Video className="h-3.5 w-3.5 text-purple-500" />,
  direct_mail: <FileText className="h-3.5 w-3.5 text-orange-500" />,
  phone:       <Phone className="h-3.5 w-3.5 text-gray-500" />,
}

const EVENT_BADGE: Record<string, string> = {
  sent:         "bg-gray-100 text-gray-700",
  delivered:    "bg-slate-100 text-slate-700",
  opened:       "bg-blue-100 text-blue-700",
  clicked:      "bg-green-100 text-green-700",
  replied:      "bg-emerald-100 text-emerald-700",
  bounced:      "bg-red-100 text-red-700",
  unsubscribed: "bg-orange-100 text-orange-700",
}

// Deterministic color from name hash for avatar
function nameColor(name: string): string {
  const colors = ["bg-blue-500","bg-purple-500","bg-green-500","bg-orange-500","bg-pink-500","bg-teal-500","bg-red-500","bg-indigo-500"]
  let hash = 0
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff
  return colors[Math.abs(hash) % colors.length]
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1)  return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

interface Props {
  brokerageId: string
  campaigns:   ISACampaignRow[]
  initialItems: EngagementFeedItem[]
}

export function EngagementFeed({ brokerageId, campaigns, initialItems }: Props) {
  const [items, setItems]           = useState<EngagementFeedItem[]>(initialItems)
  const [filterCampaign, setFilterCampaign] = useState("all")
  const [filterChannel, setFilterChannel]   = useState("all")
  const [filterEvent, setFilterEvent]       = useState("all")
  const [dateFrom, setDateFrom]             = useState("")
  const [dateTo, setDateTo]                 = useState("")
  const [isPending, startTransition]        = useTransition()

  const applyFilters = useCallback(() => {
    startTransition(async () => {
      const result = await getEngagementFeed({
        brokerageId,
        campaignId: filterCampaign !== "all" ? filterCampaign : undefined,
        channel:    filterChannel  !== "all" ? filterChannel  : undefined,
        eventType:  filterEvent    !== "all" ? filterEvent    : undefined,
        dateFrom:   dateFrom || undefined,
        dateTo:     dateTo   || undefined,
        limit:      150,
      })
      if (result.success) setItems(result.items)
    })
  }, [brokerageId, filterCampaign, filterChannel, filterEvent, dateFrom, dateTo])

  return (
    <div className="flex flex-col gap-5">
      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-end">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Campaign</span>
          <Select value={filterCampaign} onValueChange={setFilterCampaign}>
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue placeholder="All Campaigns" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Campaigns</SelectItem>
              {campaigns.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Channel</span>
          <Select value={filterChannel} onValueChange={setFilterChannel}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue placeholder="All Channels" /></SelectTrigger>
            <SelectContent>
              {["all","email","sms","video","direct_mail","phone"].map(ch => (
                <SelectItem key={ch} value={ch}>{ch === "all" ? "All Channels" : ch.replace("_"," ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Event</span>
          <Select value={filterEvent} onValueChange={setFilterEvent}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue placeholder="All Events" /></SelectTrigger>
            <SelectContent>
              {["all","sent","delivered","opened","clicked","replied","bounced","unsubscribed"].map(ev => (
                <SelectItem key={ev} value={ev}>{ev === "all" ? "All Events" : ev}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">From</span>
          <Input type="date" className="h-8 w-36 text-xs" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">To</span>
          <Input type="date" className="h-8 w-36 text-xs" value={dateTo} onChange={e => setDateTo(e.target.value)} />
        </div>

        <Button size="sm" onClick={applyFilters} disabled={isPending} className="h-8">
          {isPending ? "Loading…" : "Apply"}
        </Button>
      </div>

      {/* Feed */}
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
        {items.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No engagement events found.</p>
        ) : items.map(item => {
          const contactName = [item.contact_first_name, item.contact_last_name].filter(Boolean).join(" ") || "Unknown Contact"
          const initials    = contactName.split(" ").map(w => w[0]).slice(0,2).join("").toUpperCase()
          return (
            <div key={item.id} className="flex items-start gap-3 px-4 py-3">
              {/* Avatar */}
              <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${nameColor(contactName)}`}>
                {initials}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <a
                    href={`/crm/contacts/${item.contact_id}`}
                    className="text-sm font-medium text-foreground hover:underline truncate"
                  >
                    {contactName}
                  </a>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    {CHANNEL_ICON[item.channel]}
                    {item.channel.replace("_"," ")}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${EVENT_BADGE[item.event_type] ?? "bg-gray-100 text-gray-700"}`}>
                    {item.event_type}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {item.campaign_name && <span>{item.campaign_name}</span>}
                  <span>{relativeTime(item.created_at)}</span>
                  {item.channel === "video" && item.video_id && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-purple-100 px-1.5 py-0.5 text-xs text-purple-700 font-medium">
                      <Video className="h-3 w-3" /> Video sent
                    </span>
                  )}
                  {item.channel === "direct_mail" && item.lob_letter_id && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-orange-100 px-1.5 py-0.5 text-xs text-orange-700 font-medium">
                      <FileText className="h-3 w-3" /> View Mailer
                    </span>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
