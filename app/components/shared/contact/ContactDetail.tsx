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
  Phone,
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
} from "lucide-react"
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
}: ContactDetailProps) {
  const [newNote, setNewNote] = useState("")
  const urgencyColors = getUrgencyColor(contact.timeline || "unknown")
  const daysUntil = calculateDaysUntilTimeline(contact.timeline || "unknown")
  const dashboardRoute = getPersonaDashboardRoute(contact.contact_persona || "other")

  const handleAddNote = () => {
    if (newNote.trim()) {
      onAddNote(newNote)
      setNewNote("")
    }
  }

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
          <CardHeader>
            <CardTitle className="text-lg">Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {!contact.has_login && (
              <Button className="w-full justify-start" onClick={onQualify}>
                <UserCheck className="w-4 h-4 mr-2" /> Qualify & Create Login
              </Button>
            )}
            <Button variant="outline" className="w-full justify-start bg-transparent" onClick={onSendEmail}>
              <Send className="w-4 h-4 mr-2" /> Send Email
            </Button>
            <Button variant="outline" className="w-full justify-start bg-transparent" onClick={onEdit}>
              <Edit className="w-4 h-4 mr-2" /> Edit Contact
            </Button>
            <Separator className="my-2" />
            <Button variant="destructive" className="w-full justify-start" onClick={onDelete}>
              <Trash2 className="w-4 h-4 mr-2" /> Delete Contact
            </Button>
          </CardContent>
        </Card>

        {/* Dashboard Preview */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <ExternalLink className="w-5 h-5" /> Dashboard Preview
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-slate-600">
              This contact will see the <strong>{PERSONA_LABELS[contact.contact_persona]}</strong> dashboard when they
              log in.
            </p>
            <div className="p-3 bg-slate-50 rounded-lg text-sm">
              <p className="font-medium">Route: {dashboardRoute}</p>
            </div>
            {contact.has_login && (
              <Button variant="outline" size="sm" className="w-full bg-transparent">
                <ExternalLink className="w-4 h-4 mr-2" /> Preview Dashboard
              </Button>
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
