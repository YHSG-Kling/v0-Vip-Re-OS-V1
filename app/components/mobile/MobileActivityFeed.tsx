"use client"

import Link from "next/link"
import { formatDistanceToNow } from "date-fns"
import {
  Phone,
  Mail,
  Home,
  FileText,
  Calendar,
  MessageSquare,
  DollarSign,
  User,
  CheckCircle,
  AlertCircle,
} from "lucide-react"

interface LifecycleEvent {
  id: string
  entity_type: string
  entity_id: string
  event_type: string
  metadata: {
    contact_name?: string
    contact_id?: string
    transaction_id?: string
    listing_id?: string
    summary?: string
  } | null
  created_at: string
}

interface MobileActivityFeedProps {
  events: LifecycleEvent[]
}

function getEventIcon(eventType: string) {
  const iconClass = "h-4 w-4"
  switch (eventType) {
    case "call_completed":
    case "call_started":
      return <Phone className={iconClass} />
    case "email_sent":
    case "email_received":
      return <Mail className={iconClass} />
    case "showing_scheduled":
    case "showing_completed":
      return <Home className={iconClass} />
    case "document_uploaded":
    case "document_signed":
      return <FileText className={iconClass} />
    case "appointment_scheduled":
    case "event_created":
      return <Calendar className={iconClass} />
    case "message_sent":
    case "message_received":
      return <MessageSquare className={iconClass} />
    case "offer_received":
    case "offer_accepted":
      return <DollarSign className={iconClass} />
    case "contact_created":
    case "lead_created":
      return <User className={iconClass} />
    case "task_completed":
    case "milestone_completed":
      return <CheckCircle className={iconClass} />
    case "alert":
    case "warning":
      return <AlertCircle className={iconClass} />
    default:
      return <CheckCircle className={iconClass} />
  }
}

function getEventColor(eventType: string): string {
  if (eventType.includes("completed") || eventType.includes("accepted")) {
    return "bg-emerald-100 text-emerald-700"
  }
  if (eventType.includes("alert") || eventType.includes("warning")) {
    return "bg-red-100 text-red-700"
  }
  if (eventType.includes("scheduled") || eventType.includes("created")) {
    return "bg-blue-100 text-blue-700"
  }
  return "bg-muted text-muted-foreground"
}

function getEventLink(event: LifecycleEvent): string | null {
  const { entity_type, entity_id, metadata } = event
  
  if (metadata?.contact_id) {
    return `/dashboard/contacts/${metadata.contact_id}`
  }
  if (metadata?.transaction_id) {
    return `/dashboard/transactions/${metadata.transaction_id}`
  }
  if (metadata?.listing_id) {
    return `/dashboard/listings/${metadata.listing_id}`
  }
  
  switch (entity_type) {
    case "contact":
      return `/dashboard/contacts/${entity_id}`
    case "transaction":
      return `/dashboard/transactions/${entity_id}`
    case "listing":
      return `/dashboard/listings/${entity_id}`
    default:
      return null
  }
}

function formatEventSummary(event: LifecycleEvent): string {
  const { event_type, metadata } = event
  const contactName = metadata?.contact_name || "Someone"
  
  switch (event_type) {
    case "call_completed":
      return `Call with ${contactName} completed`
    case "email_sent":
      return `Email sent to ${contactName}`
    case "showing_scheduled":
      return `Showing scheduled with ${contactName}`
    case "document_signed":
      return `${contactName} signed a document`
    case "offer_received":
      return `Offer received from ${contactName}`
    case "task_completed":
      return metadata?.summary || "Task completed"
    default:
      return metadata?.summary || event_type.replace(/_/g, " ")
  }
}

export function MobileActivityFeed({ events }: MobileActivityFeedProps) {
  if (events.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <p>No recent activity</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {events.map((event) => {
        const link = getEventLink(event)
        const content = (
          <div className="flex items-start gap-3 p-3 rounded-lg bg-card border min-h-[56px]">
            <div
              className={`h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0 ${getEventColor(event.event_type)}`}
            >
              {getEventIcon(event.event_type)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {formatEventSummary(event)}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
              </p>
            </div>
          </div>
        )

        if (link) {
          return (
            <Link key={event.id} href={link} className="block active:opacity-70">
              {content}
            </Link>
          )
        }

        return <div key={event.id}>{content}</div>
      })}
    </div>
  )
}
