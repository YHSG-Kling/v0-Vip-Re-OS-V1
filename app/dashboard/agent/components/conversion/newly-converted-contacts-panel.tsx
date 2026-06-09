"use client"

import { useEffect, useState, useTransition } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { createClient } from "@/lib/supabase/client"
import {
  UserCheck,
  Clock,
  ArrowRight,
  Phone,
  Mail,
  Star,
  AlertTriangle,
  Sparkles,
} from "lucide-react"

interface ConvertedContact {
  id: string
  contact_id: string
  lead_id: string | null
  first_name: string
  last_name: string
  email: string | null
  phone: string | null
  lifecycle_state: string
  qualification_reason: string | null
  urgency_level: "low" | "medium" | "high" | "urgent"
  next_action: string | null
  source_lead_name: string | null
  converted_at: string
  ai_summary: string | null
}

interface NewlyConvertedContactsPanelProps {
  agentId: string
  brokerageId: string
}

export function NewlyConvertedContactsPanel({ agentId, brokerageId }: NewlyConvertedContactsPanelProps) {
  const [contacts, setContacts] = useState<ConvertedContact[]>([])
  const [loading, setLoading] = useState(true)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    async function loadConvertedContacts() {
      const supabase = createClient()

      // Get recently converted contacts (promoted from leads in last 7 days)
      const sevenDaysAgo = new Date()
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

      const { data: conversions, error } = await supabase
        .from("contacts")
        .select(`
          id,
          first_name,
          last_name,
          email,
          phone,
          lifecycle_state,
          created_at,
          source_lead_id,
          ai_isa_qualifications (
            qualification_reason,
            urgency_level,
            next_action,
            qualification_signals,
            created_at
          )
        `)
        .eq("brokerage_id", brokerageId)
        .eq("assigned_agent_id", agentId)
        .in("lifecycle_state", ["qualified", "active_buyer", "active_seller", "under_contract"])
        .gte("created_at", sevenDaysAgo.toISOString())
        .order("created_at", { ascending: false })
        .limit(10)

      if (error) {
        console.error("[v0] Error loading converted contacts:", error)
        setLoading(false)
        return
      }

      // Enrich with lead source data if available
      const enrichedContacts: ConvertedContact[] = await Promise.all(
        (conversions || []).map(async (c: any) => {
          let sourceLead = null
          if (c.source_lead_id) {
            // leads' source column is `source` (lead_source doesn't exist — the old
            // select errored, so the panel never showed where a conversion came from).
            const { data: leadData } = await supabase
              .from("leads")
              .select("first_name, last_name, source")
              .eq("id", c.source_lead_id)
              .maybeSingle()
            sourceLead = leadData
          }

          const qualification = c.ai_isa_qualifications?.[0]

          return {
            id: c.id,
            contact_id: c.id,
            lead_id: c.source_lead_id,
            first_name: c.first_name || "",
            last_name: c.last_name || "",
            email: c.email,
            phone: c.phone,
            lifecycle_state: c.lifecycle_state,
            qualification_reason: qualification?.qualification_reason || "Qualified via ISA",
            urgency_level: qualification?.urgency_level || "medium",
            next_action: qualification?.next_action || "Initial outreach",
            source_lead_name: sourceLead
              ? `${sourceLead.first_name || ""} ${sourceLead.last_name || ""}`.trim() || sourceLead.source
              : null,
            converted_at: c.created_at,
            ai_summary: qualification?.qualification_signals?.summary || null,
          }
        })
      )

      setContacts(enrichedContacts)
      setLoading(false)
    }

    if (agentId && brokerageId) {
      loadConvertedContacts()
    }
  }, [agentId, brokerageId])

  const getUrgencyColor = (urgency: string) => {
    switch (urgency) {
      case "urgent":
        return "bg-red-100 text-red-700 border-red-200"
      case "high":
        return "bg-orange-100 text-orange-700 border-orange-200"
      case "medium":
        return "bg-amber-100 text-amber-700 border-amber-200"
      default:
        return "bg-gray-100 text-gray-700 border-gray-200"
    }
  }

  const formatTimeAgo = (dateStr: string) => {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffHrs = Math.floor(diffMs / (1000 * 60 * 60))
    const diffDays = Math.floor(diffHrs / 24)

    if (diffDays > 0) return `${diffDays}d ago`
    if (diffHrs > 0) return `${diffHrs}h ago`
    return "Just now"
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserCheck className="h-4 w-4 text-green-600" />
            Newly Converted Contacts
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </CardContent>
      </Card>
    )
  }

  if (contacts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserCheck className="h-4 w-4 text-green-600" />
            Newly Converted Contacts
          </CardTitle>
          <CardDescription>Qualified handoffs from AI ISA</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <UserCheck className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No new conversions in the last 7 days</p>
            <p className="text-xs mt-1">AI ISA handoffs will appear here</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <UserCheck className="h-4 w-4 text-green-600" />
              Newly Converted Contacts
            </CardTitle>
            <CardDescription>
              {contacts.length} qualified {contacts.length === 1 ? "handoff" : "handoffs"} ready for your first touch
            </CardDescription>
          </div>
          <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
            {contacts.filter((c) => c.urgency_level === "urgent" || c.urgency_level === "high").length} High Priority
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {contacts.map((contact) => (
          <div
            key={contact.id}
            className="p-3 border rounded-lg hover:bg-muted/30 transition-colors"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <Link
                    href={`/crm/contacts/${contact.contact_id}`}
                    className="font-medium text-sm hover:underline truncate"
                  >
                    {contact.first_name} {contact.last_name}
                  </Link>
                  <Badge variant="outline" className={`text-xs ${getUrgencyColor(contact.urgency_level)}`}>
                    {contact.urgency_level === "urgent" && <AlertTriangle className="h-3 w-3 mr-1" />}
                    {contact.urgency_level}
                  </Badge>
                </div>

                <p className="text-xs text-muted-foreground mb-2 line-clamp-1">
                  {contact.qualification_reason}
                </p>

                {contact.ai_summary && (
                  <div className="flex items-start gap-1.5 p-2 bg-violet-50 rounded text-xs text-violet-700 mb-2">
                    <Sparkles className="h-3 w-3 mt-0.5 shrink-0" />
                    <span className="line-clamp-2">{contact.ai_summary}</span>
                  </div>
                )}

                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {formatTimeAgo(contact.converted_at)}
                  </span>
                  {contact.source_lead_name && (
                    <span className="truncate">From: {contact.source_lead_name}</span>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-1.5 shrink-0">
                {contact.phone && (
                  <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
                    <a href={`tel:${contact.phone}`}>
                      <Phone className="h-3 w-3 mr-1" />
                      Call
                    </a>
                  </Button>
                )}
                {contact.email && (
                  <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
                    <a href={`mailto:${contact.email}`}>
                      <Mail className="h-3 w-3 mr-1" />
                      Email
                    </a>
                  </Button>
                )}
              </div>
            </div>

            {contact.next_action && (
              <div className="mt-2 pt-2 border-t flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  <Star className="h-3 w-3 inline mr-1 text-amber-500" />
                  Next: {contact.next_action}
                </span>
                <Link href={`/crm/contacts/${contact.contact_id}`}>
                  <Button size="sm" variant="ghost" className="h-6 text-xs">
                    View Details
                    <ArrowRight className="h-3 w-3 ml-1" />
                  </Button>
                </Link>
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
