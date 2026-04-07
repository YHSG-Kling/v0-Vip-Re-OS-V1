"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Clock, Globe, Users, FileText, AlertCircle, Mail, Phone, RefreshCw, User } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { toast } from "sonner"

interface OSINTLead {
  id: string
  contact_id: string
  first_name: string
  last_name: string
  email: string
  phone: string
  source: string
  type: string
  priority: string
  content: string
  signals: string[]
  timestamp: string
  ai_intent_score: number
  assigned_agent_id?: string
}

export default function OSINTTimeline() {
  const [leads, setLeads] = useState<OSINTLead[]>([])
  const [agents, setAgents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [assigningLead, setAssigningLead] = useState<string | null>(null)

  useEffect(() => {
    loadOSINTData()
    loadAgents()
  }, [])

  const loadOSINTData = async () => {
    setLoading(true)
    try {
      const supabase = createClient()

      const { data: osintData, error } = await supabase
        .from("social_intelligence")
        .select(`
          id,
          contact_id,
          source,
          post_content,
          intent_keywords_matched,
          ai_intent_score,
          urgency_level,
          intent_summary,
          posted_date,
          contacts (
            id,
            first_name,
            last_name,
            email,
            phone,
            agent_id
          )
        `)
        .order("posted_date", { ascending: false })
        .limit(50)

      if (error) throw error

      // Transform data for display
      const transformedLeads: OSINTLead[] = (osintData || []).map((item: any) => ({
        id: item.id,
        contact_id: item.contact_id,
        first_name: item.contacts?.first_name || "Unknown",
        last_name: item.contacts?.last_name || "Lead",
        email: item.contacts?.email || "",
        phone: item.contacts?.phone || "",
        source: item.source || "Unknown",
        type: item.source?.includes("nextdoor")
          ? "social_media"
          : item.source?.includes("google")
            ? "search_activity"
            : "web_activity",
        priority: item.urgency_level || "medium",
        content: item.intent_summary || item.post_content || "",
        signals: item.intent_keywords_matched || [],
        timestamp: item.posted_date,
        ai_intent_score: item.ai_intent_score || 0,
        assigned_agent_id: item.contacts?.agent_id,
      }))

      setLeads(transformedLeads)
    } catch (error) {
      console.error("[v0] Error loading OSINT data:", error)
    } finally {
      setLoading(false)
    }
  }

  const loadAgents = async () => {
    try {
      const supabase = createClient()
      const { data } = await supabase
        .from("users")
        .select("id, first_name, last_name")
        .in("role", ["agent", "broker"])
        .order("first_name")
      setAgents(data || [])
    } catch (error) {
      console.error("[v0] Error loading agents:", error)
    }
  }

  const assignLeadToAgent = async (contactId: string, agentId: string) => {
    if (!contactId) {
      toast.error("No contact associated with this signal")
      return
    }

    setAssigningLead(contactId)
    try {
      const supabase = createClient()
      const { error } = await supabase.from("contacts").update({ agent_id: agentId }).eq("id", contactId)

      if (error) throw error

      toast.success("Lead assigned")
      loadOSINTData()
    } catch (error) {
      console.error("[v0] Error assigning lead:", error)
      toast.error("Failed to assign lead")
    } finally {
      setAssigningLead(null)
    }
  }

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case "urgent":
      case "high":
        return "border-l-red-500 bg-red-50"
      case "medium":
        return "border-l-orange-500 bg-orange-50"
      case "low":
        return "border-l-blue-500 bg-blue-50"
      default:
        return "border-l-gray-500 bg-gray-50"
    }
  }

  const getSourceIcon = (type: string) => {
    switch (type) {
      case "social_media":
        return <Users className="w-4 h-4" />
      case "property_ownership":
        return <FileText className="w-4 h-4" />
      case "search_activity":
        return <Globe className="w-4 h-4" />
      case "web_activity":
        return <Globe className="w-4 h-4" />
      default:
        return <AlertCircle className="w-4 h-4" />
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="animate-spin text-blue-600" size={32} />
      </div>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="w-5 h-5 text-blue-600" />
          OSINT Discovery Timeline
        </CardTitle>
        <p className="text-sm text-muted-foreground">Intelligence gathered from open source data with lead profiles</p>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[600px] pr-4">
          <div className="space-y-4">
            {leads.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <User className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No OSINT data found. Intelligence will appear as signals are collected.</p>
              </div>
            ) : (
              leads.map((lead) => (
                <Card key={lead.id} className={`border-l-4 ${getPriorityColor(lead.priority)}`}>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        {getSourceIcon(lead.type)}
                        <div>
                          <h4 className="text-sm font-semibold">{lead.source}</h4>
                          <p className="text-xs text-muted-foreground">
                            {lead.timestamp ? new Date(lead.timestamp).toLocaleString() : "Unknown date"}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                          Score: {lead.ai_intent_score}
                        </Badge>
                        <Badge
                          variant={
                            lead.priority === "high" || lead.priority === "urgent"
                              ? "destructive"
                              : lead.priority === "medium"
                                ? "default"
                                : "secondary"
                          }
                        >
                          {lead.priority}
                        </Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center gap-3 p-2 bg-slate-100 rounded">
                      <User className="w-5 h-5 text-slate-600" />
                      <div className="flex-1">
                        <p className="font-medium text-slate-900">
                          {lead.first_name} {lead.last_name}
                        </p>
                        <div className="flex gap-3 text-xs text-slate-600">
                          {lead.email && <span>{lead.email}</span>}
                          {lead.phone && <span>{lead.phone}</span>}
                        </div>
                      </div>

                      {/* Agent Assignment */}
                      <select
                        className="text-sm border border-slate-300 rounded px-2 py-1"
                        value={lead.assigned_agent_id || ""}
                        onChange={(e) => assignLeadToAgent(lead.contact_id, e.target.value)}
                        disabled={assigningLead === lead.contact_id || !lead.contact_id}
                      >
                        <option value="">Assign...</option>
                        {agents.map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.first_name} {agent.last_name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <p className="text-sm">{lead.content}</p>

                    <div className="flex flex-wrap gap-2">
                      {lead.signals.map((signal, idx) => (
                        <Badge key={idx} variant="outline" className="text-xs">
                          {signal.replace(/_/g, " ")}
                        </Badge>
                      ))}
                    </div>

                    <div className="flex gap-2 pt-2">
                      <Button size="sm" variant="outline" disabled={!lead.email}>
                        <Mail size={14} className="mr-1" /> Email
                      </Button>
                      <Button size="sm" className="bg-blue-600 hover:bg-blue-700" disabled={!lead.phone}>
                        <Phone size={14} className="mr-1" /> Call
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
