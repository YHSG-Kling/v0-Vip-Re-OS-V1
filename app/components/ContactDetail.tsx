"use client"

import { useState } from "react"
import type { Contact } from "@/types/contact"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import {
  User,
  Mail,
  MailOpen,
  Phone,
  PhoneCall,
  Calendar,
  Building,
  FileText,
  UserCheck,
  Send,
  Edit,
  Trash2,
  ExternalLink,
  MessageSquare,
  Activity,
  DollarSign,
  Home,
  Target,
  CheckCircle,
  XCircle,
  Pause,
  Play,
  RefreshCw,
  AlertTriangle,
  ShieldOff,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { getUrgencyColor, calculateDaysUntilTimeline, getPersonaDashboardRoute } from "@/lib/contact-utils"

interface ContactDetailProps {
  contact: Contact
  onEdit: () => void
  onQualify: () => void
  onDelete: () => void
  onSendEmail: () => void
  onAddNote: (note: string) => void
  agentInfo?: {
    name: string
    email: string
    phone: string
  }
  brokerageId?: string
  userId?: string
}

const TYPE_COLORS: Record<string, string> = {
  buyer: "bg-emerald-500",
  seller: "bg-blue-500",
  investor: "bg-purple-500",
  lender: "bg-amber-500",
  commercial: "bg-slate-500",
  agent: "bg-cyan-500",
  vendor: "bg-orange-500",
  TC: "bg-pink-500",
  other: "bg-gray-500",
}

const PERSONA_LABELS: Record<string, string> = {
  first_time_buyer: "First-Time Buyer",
  luxury_buyer: "Luxury Buyer",
  luxury_seller: "Luxury Seller",
  investor: "Investor",
  first_time_seller: "First-Time Seller",
  motivated_seller: "Motivated Seller",
  relocating: "Relocating",
  empty_nester: "Empty Nester",
  probate: "Probate",
  remote_seller: "Remote Seller",
  divorce: "Divorce",
  upsizers: "Upsizers",
  senior: "Senior",
  expired: "Expired",
  fsbo: "FSBO",
  other: "Other",
}

export function ContactDetail({
  contact,
  onEdit,
  onQualify,
  onDelete,
  onSendEmail,
  onAddNote,
  agentInfo,
  brokerageId,
  userId,
}: ContactDetailProps) {
  const router = useRouter()
  const [newNote, setNewNote] = useState("")
  const [isaLoading, setIsaLoading] = useState<string | null>(null)
  const urgencyColors = getUrgencyColor(contact.timeline || "unknown")
  const daysUntil = calculateDaysUntilTimeline(contact.timeline || "unknown")
  const portalUrl = getPersonaDashboardRoute(contact.id, contact.contact_persona)

  const handleAddNote = () => {
    if (newNote.trim()) {
      onAddNote(newNote)
      setNewNote("")
    }
  }

  // ── ISA action handlers ──────────────────────────────────────────────────

  async function handleAICallNow() {
    if (!contact.phone) { toast.error("No phone number on this contact"); return }
    if ((contact as any).call_stop_flag) { toast.error("Call stop flag is set on this contact"); return }
    setIsaLoading("call")
    try {
      const res = await fetch("/api/voice/initiate-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phoneNumber: contact.phone,
          contactId: contact.id,
          agentId: userId ?? "",
          brokerageId: brokerageId ?? (contact as any).brokerage_id ?? "",
          callPurpose: "isa_followup",
        }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.blocked ? `Call blocked: ${data.reason}` : (data.error ?? "Failed to initiate call")); return }
      toast.success(`AI call initiated — ID: ${data.callId}`)
      router.refresh()
    } catch { toast.error("Network error initiating AI call") }
    finally { setIsaLoading(null) }
  }

  async function handleSendEmailNow() {
    if (!contact.email) { toast.error("No email address on this contact"); return }
    setIsaLoading("email")
    try {
      const res = await fetch("/api/contacts/send-isa-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: contact.id }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? "Failed to send email"); return }
      toast.success("AI email queued for immediate send")
      router.refresh()
    } catch { toast.error("Failed to send email") }
    finally { setIsaLoading(null) }
  }

  async function handleSendDirectMail() {
    const address = (contact as any).mailing_address || (contact as any).address
    if (!address) { toast.error("No mailing address on this contact"); return }
    setIsaLoading("mail")
    try {
      const res = await fetch("/api/contacts/send-isa-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: contact.id, channel: "direct_mail" }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error ?? "Failed to queue direct mail"); return }
      toast.success("Direct mail piece queued for dispatch")
      router.refresh()
    } catch { toast.error("Failed to queue direct mail") }
    finally { setIsaLoading(null) }
  }

  async function handleHandOffToAgent() {
    setIsaLoading("handoff")
    try {
      const { acceptAIISAHandoff } = await import("@/app/actions/ai-isa/accept-handoff")
      const leadId = (contact as any).lead_id ?? contact.id
      await acceptAIISAHandoff({
        leadId,
        brokerageId: brokerageId ?? (contact as any).brokerage_id ?? "",
        actorUserId: userId ?? "system",
      })
      toast.success("Handed off to human agent")
      router.refresh()
    } catch (err: any) { toast.error(err?.message ?? "Handoff failed") }
    finally { setIsaLoading(null) }
  }

  async function handlePauseAI() {
    setIsaLoading("pause")
    try {
      const { createClient } = await import("@/lib/supabase/client")
      const supabase = createClient()
      await supabase.from("contacts").update({ ai_outreach_paused: true, updated_at: new Date().toISOString() }).eq("id", contact.id)
      toast.success("AI-ISA paused for this contact")
      router.refresh()
    } catch { toast.error("Failed to pause AI-ISA") }
    finally { setIsaLoading(null) }
  }

  async function handleResumeAI() {
    setIsaLoading("resume")
    try {
      const { createClient } = await import("@/lib/supabase/client")
      const supabase = createClient()
      await supabase.from("contacts").update({ ai_outreach_paused: false, updated_at: new Date().toISOString() }).eq("id", contact.id)
      toast.success("AI-ISA resumed for this contact")
      router.refresh()
    } catch { toast.error("Failed to resume AI-ISA") }
    finally { setIsaLoading(null) }
  }

  async function handleForceReassess() {
    setIsaLoading("reassess")
    try {
      const res = await fetch("/api/contacts/qualify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: contact.id }),
      })
      if (!res.ok) { toast.error("Reassessment failed"); return }
      toast.success("Qualification reassessment queued")
      router.refresh()
    } catch { toast.error("Failed to queue reassessment") }
    finally { setIsaLoading(null) }
  }

  async function handleEscalate() {
    setIsaLoading("escalate")
    try {
      const { createClient } = await import("@/lib/supabase/client")
      const supabase = createClient()
      await supabase.from("notifications").insert({
        brokerage_id: brokerageId ?? (contact as any).brokerage_id,
        type: "isa_escalation",
        title: "Contact escalated for immediate attention",
        message: `Contact ${contact.first_name} ${contact.last_name} has been escalated from the CRM.`,
        entity_type: "contact",
        entity_id: contact.id,
        is_read: false,
      })
      toast.success("Contact escalated — agent notified")
      router.refresh()
    } catch { toast.error("Failed to escalate contact") }
    finally { setIsaLoading(null) }
  }

  async function handleComplianceHold(hold: boolean) {
    setIsaLoading("hold")
    try {
      const { createClient } = await import("@/lib/supabase/client")
      const supabase = createClient()
      await supabase
        .from("contacts")
        .update({ aiisa_state: hold ? "compliance_hold" : "ai_active", updated_at: new Date().toISOString() })
        .eq("id", contact.id)
      toast.success(hold ? "Compliance hold placed" : "Compliance hold removed")
      router.refresh()
    } catch { toast.error("Failed to update compliance hold") }
    finally { setIsaLoading(null) }
  }

  const isAiPaused = (contact as any).ai_outreach_paused
  const isComplianceHold = (contact as any).aiisa_state === "compliance_hold"
  const hasPhone = !!contact.phone && !(contact as any).call_stop_flag
  const hasEmail = !!contact.email && !(contact as any).email_opt_out
  const hasAddress = !!((contact as any).mailing_address || (contact as any).address)

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Left Column - Contact Info */}
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Contact Information</CardTitle>
              <Button variant="ghost" size="sm" onClick={onEdit}>
                <Edit className="w-4 h-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <div
                className={`w-12 h-12 rounded-full ${TYPE_COLORS[contact.contact_type] || TYPE_COLORS.other} flex items-center justify-center text-white font-bold text-lg`}
              >
                {(contact.first_name || "?")[0]}
                {(contact.last_name || "?")[0]}
              </div>
              <div>
                <h3 className="font-semibold text-lg">
                  {contact.first_name || "Unknown"} {contact.last_name || "Contact"}
                </h3>
                <p className="text-sm text-slate-500">{PERSONA_LABELS[contact.contact_persona] || "Contact"}</p>
              </div>
            </div>

            <Separator />

            <div className="space-y-3">
              <div className="flex items-center gap-3 text-sm">
                <Mail className="w-4 h-4 text-slate-400" />
                <a href={`mailto:${contact.email}`} className="text-blue-600 hover:underline">
                  {contact.email}
                </a>
              </div>
              {contact.phone && (
                <div className="flex items-center gap-3 text-sm">
                  <Phone className="w-4 h-4 text-slate-400" />
                  <a href={`tel:${contact.phone}`} className="text-blue-600 hover:underline">
                    {contact.phone}
                  </a>
                </div>
              )}
              <div className="flex items-center gap-3 text-sm">
                <Building className="w-4 h-4 text-slate-400" />
                <span>Source: {contact.source}</span>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <Calendar className="w-4 h-4 text-slate-400" />
                <span>Created: {new Date(contact.created_at).toLocaleDateString()}</span>
              </div>
            </div>

            <Separator />

            {/* Badges */}
            <div className="flex flex-wrap gap-2">
              <Badge className={TYPE_COLORS[contact.contact_type || "other"] + " text-white"}>
                {contact.contact_type || "other"}
              </Badge>
              <Badge variant="outline">{contact.status ? contact.status.replace(/_/g, " ") : "Unknown"}</Badge>
              {contact.has_login ? (
                <Badge className="bg-green-100 text-green-800">
                  <CheckCircle className="w-3 h-3 mr-1" /> Has Login
                </Badge>
              ) : (
                <Badge className="bg-slate-100 text-slate-600">
                  <XCircle className="w-3 h-3 mr-1" /> No Login
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Timeline Card */}
        <Card className={urgencyColors.bg}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600">Timeline</p>
                <p className={`text-xl font-bold ${urgencyColors.text}`}>
                  {contact.timeline ? contact.timeline.replace(/_/g, " ") : "Unknown"}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-slate-600">Days Remaining</p>
                <p className={`text-2xl font-bold ${urgencyColors.text}`}>{daysUntil}</p>
              </div>
            </div>
            {daysUntil <= 90 && (
              <div className={`mt-3 p-2 rounded ${daysUntil <= 30 ? "bg-red-100" : "bg-amber-100"}`}>
                <p className={`text-sm font-medium ${daysUntil <= 30 ? "text-red-800" : "text-amber-800"}`}>
                  {daysUntil <= 30 ? "URGENT: Follow up immediately!" : "Priority contact - follow up soon"}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Property Interest */}
        {contact.property_interest && Object.keys(contact.property_interest).length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Home className="w-4 h-4" /> Property Interest
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {contact.property_interest.budget_min && contact.property_interest.budget_max && (
                <div className="flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-slate-400" />
                  <span>
                    Budget: ${contact.property_interest.budget_min.toLocaleString()} - $
                    {contact.property_interest.budget_max.toLocaleString()}
                  </span>
                </div>
              )}
              {contact.property_interest.desired_neighborhoods?.length > 0 && (
                <div className="flex items-start gap-2">
                  <Target className="w-4 h-4 text-slate-400 mt-0.5" />
                  <span>Areas: {contact.property_interest.desired_neighborhoods.join(", ")}</span>
                </div>
              )}
              {contact.property_interest.current_home_value && (
                <div className="flex items-center gap-2">
                  <Home className="w-4 h-4 text-slate-400" />
                  <span>Home Value: ${contact.property_interest.current_home_value.toLocaleString()}</span>
                </div>
              )}
              {contact.property_interest.reason_for_selling && (
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-slate-400" />
                  <span>Reason: {contact.property_interest.reason_for_selling}</span>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Center Column - Timeline/Activity */}
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Activity className="w-5 h-5" /> Activity Timeline
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {/* Activity items - would come from actual data */}
              <div className="flex gap-3">
                <div className="w-2 h-2 rounded-full bg-blue-500 mt-2" />
                <div>
                  <p className="text-sm font-medium">Contact Created</p>
                  <p className="text-xs text-slate-500">{new Date(contact.created_at).toLocaleString()}</p>
                </div>
              </div>

              {contact.last_contacted && (
                <div className="flex gap-3">
                  <div className="w-2 h-2 rounded-full bg-green-500 mt-2" />
                  <div>
                    <p className="text-sm font-medium">Last Contacted</p>
                    <p className="text-xs text-slate-500">{new Date(contact.last_contacted).toLocaleString()}</p>
                  </div>
                </div>
              )}

              {contact.has_login && contact.login_created_at && (
                <div className="flex gap-3">
                  <div className="w-2 h-2 rounded-full bg-purple-500 mt-2" />
                  <div>
                    <p className="text-sm font-medium">Login Created</p>
                    <p className="text-xs text-slate-500">{new Date(contact.login_created_at).toLocaleString()}</p>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Notes */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <MessageSquare className="w-5 h-5" /> Notes
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {contact.notes && <div className="p-3 bg-slate-50 rounded-lg text-sm">{contact.notes}</div>}
            <div className="space-y-2">
              <Textarea
                placeholder="Add a note..."
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                rows={3}
              />
              <Button size="sm" onClick={handleAddNote} disabled={!newNote.trim()}>
                Add Note
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Right Column - Actions & Dashboard Preview */}
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">

            {/* CRM actions */}
            {!contact.has_login && (
              <Button className="w-full justify-start" onClick={onQualify}>
                <UserCheck className="w-4 h-4 mr-2" /> Qualify &amp; Create Login
              </Button>
            )}
            <Button variant="outline" className="w-full justify-start" onClick={onEdit}>
              <Edit className="w-4 h-4 mr-2" /> Edit Contact
            </Button>
            <Button variant="outline" className="w-full justify-start" onClick={onSendEmail}>
              <Send className="w-4 h-4 mr-2" /> Compose Email
            </Button>

            <Separator className="my-2" />

            {/* AI-ISA outreach actions */}
            {hasPhone && (
              <Button
                variant="outline"
                className="w-full justify-start text-green-700 border-green-300 hover:bg-green-50"
                onClick={handleAICallNow}
                disabled={isaLoading === "call"}
              >
                <PhoneCall className="w-4 h-4 mr-2" />
                {isaLoading === "call" ? "Calling..." : "AI Call Now"}
              </Button>
            )}

            {hasEmail && (
              <Button
                variant="outline"
                className="w-full justify-start text-blue-700 border-blue-300 hover:bg-blue-50"
                onClick={handleSendEmailNow}
                disabled={isaLoading === "email"}
              >
                <Mail className="w-4 h-4 mr-2" />
                {isaLoading === "email" ? "Sending..." : "Send Email Now"}
              </Button>
            )}

            {hasAddress && (
              <Button
                variant="outline"
                className="w-full justify-start text-purple-700 border-purple-300 hover:bg-purple-50"
                onClick={handleSendDirectMail}
                disabled={isaLoading === "mail"}
              >
                <MailOpen className="w-4 h-4 mr-2" />
                {isaLoading === "mail" ? "Queuing..." : "Send Direct Mail"}
              </Button>
            )}

            <Separator className="my-2" />

            {/* AI-ISA state controls */}
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={handleHandOffToAgent}
              disabled={isaLoading === "handoff"}
            >
              <UserCheck className="w-4 h-4 mr-2" />
              {isaLoading === "handoff" ? "Handing off..." : "Hand Off to Human Agent"}
            </Button>

            {isAiPaused ? (
              <Button
                variant="ghost"
                className="w-full justify-start"
                onClick={handleResumeAI}
                disabled={isaLoading === "resume"}
              >
                <Play className="w-4 h-4 mr-2" />
                Resume AI-ISA
              </Button>
            ) : (
              <Button
                variant="ghost"
                className="w-full justify-start"
                onClick={handlePauseAI}
                disabled={isaLoading === "pause"}
              >
                <Pause className="w-4 h-4 mr-2" />
                Pause AI-ISA
              </Button>
            )}

            <Button
              variant="ghost"
              className="w-full justify-start"
              onClick={handleForceReassess}
              disabled={isaLoading === "reassess"}
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Force Reassess
            </Button>

            <a href={`/contacts/${contact.id}?tab=calls`} className="block">
              <Button variant="ghost" className="w-full justify-start text-muted-foreground">
                <Phone className="w-4 h-4 mr-2" />
                View Call History
              </Button>
            </a>

            <Button
              variant="ghost"
              className="w-full justify-start text-orange-600 hover:text-orange-700"
              onClick={handleEscalate}
              disabled={isaLoading === "escalate"}
            >
              <AlertTriangle className="w-4 h-4 mr-2" />
              Escalate
            </Button>

            {isComplianceHold ? (
              <Button
                variant="ghost"
                className="w-full justify-start text-green-700"
                onClick={() => handleComplianceHold(false)}
                disabled={isaLoading === "hold"}
              >
                <CheckCircle className="w-4 h-4 mr-2" />
                Remove Compliance Hold
              </Button>
            ) : (
              <Button
                variant="ghost"
                className="w-full justify-start text-muted-foreground"
                onClick={() => handleComplianceHold(true)}
                disabled={isaLoading === "hold"}
              >
                <ShieldOff className="w-4 h-4 mr-2" />
                Compliance Hold
              </Button>
            )}

            <Separator className="my-2" />
            <Button variant="destructive" className="w-full justify-start" onClick={onDelete}>
              <Trash2 className="w-4 h-4 mr-2" /> Delete Contact
            </Button>
          </CardContent>
        </Card>

        {/* Client Portal */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <ExternalLink className="w-5 h-5" /> Client Portal
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-slate-600">
              This contact sees the{" "}
              <strong>{PERSONA_LABELS[contact.contact_persona] ?? "Contact"}</strong>{" "}
              view. Portal view is determined automatically from their persona.
            </p>
            <a
              href={portalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block p-3 bg-slate-50 rounded-lg text-sm font-mono text-slate-700 hover:bg-slate-100 transition-colors"
            >
              {portalUrl}
            </a>
            {contact.has_login && (
              <a href={portalUrl} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm" className="w-full bg-transparent">
                  <ExternalLink className="w-4 h-4 mr-2" /> Open Portal
                </Button>
              </a>
            )}
          </CardContent>
        </Card>

        {/* Agent Info */}
        {agentInfo && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <User className="w-5 h-5" /> Assigned Agent
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="font-medium">{agentInfo.name}</p>
              <p className="text-slate-600">{agentInfo.email}</p>
              <p className="text-slate-600">{agentInfo.phone}</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
