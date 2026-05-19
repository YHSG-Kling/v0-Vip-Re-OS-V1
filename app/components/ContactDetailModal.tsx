"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { X } from "lucide-react"
import { ContactDetail } from "@/components/ContactDetail"
import type { Contact } from "@/types/contact"
import { updateContact } from "@/app/actions/contacts"
import { createClient } from "@/lib/supabase/client"
import { toast } from "sonner"

interface ContactDetailModalProps {
  contact: Contact
  onClose: () => void
  agentId?: string
}

export default function ContactDetailModal({ contact, onClose, agentId }: ContactDetailModalProps) {
  const router = useRouter()
  const [localContact, setLocalContact] = useState<Contact>(contact)

  const handleEdit = () => {
    router.push(`/crm?contact=${contact.id}`)
    onClose()
  }

  const handleQualify = async () => {
    try {
      const result = await updateContact(contact.id, {
        status: "qualified",
      })
      if (result?.success !== false) {
        setLocalContact((prev) => ({ ...prev, status: "qualified" }))
        toast.success("Contact qualified")
      } else {
        toast.error(result?.error ?? "Failed to qualify contact")
      }
    } catch {
      toast.error("Failed to qualify contact")
    }
  }

  const handleDelete = async () => {
    if (!confirm("Archive this contact? They won't appear in your active lists.")) return
    try {
      const supabase = createClient()
      const { error } = await supabase
        .from("contacts")
        .update({ status: "archived", updated_at: new Date().toISOString() })
        .eq("id", contact.id)
      if (error) throw error
      toast.success("Contact archived")
      onClose()
      router.refresh()
    } catch {
      toast.error("Failed to archive contact")
    }
  }

  const handleSendEmail = () => {
    router.push(`/dashboard/communications/inbox?contactId=${contact.id}`)
    onClose()
  }

  const handleAddNote = async (note: string) => {
    if (!note?.trim()) return
    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      // activities has `agent_user_id` (not `user_id`); no `entity_id`
      // column either — contact_id is the canonical entity ref. Both
      // brokerage_id and agent_id are NOT NULL on activities; the agent's
      // session populates them from the surrounding contact row.
      const { error } = await supabase.from("activities").insert({
        contact_id: contact.id,
        brokerage_id: contact.brokerage_id,
        agent_id: contact.agent_id ?? agentId,
        agent_user_id: user?.id ?? null,
        entity_type: "contact",
        activity_type: "note",
        title: "Note added",
        notes: note.trim(),
        status: "completed",
        metadata: { source: "contact_detail_modal" },
      })
      if (error) throw error
      toast.success("Note saved")
    } catch {
      toast.error("Failed to save note")
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-6xl w-full max-h-[90vh] overflow-y-auto relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 hover:bg-slate-100 rounded-lg transition-colors z-10"
          aria-label="Close"
        >
          <X className="w-5 h-5 text-slate-600" />
        </button>
        <div className="p-6">
          <ContactDetail
            contact={localContact}
            onEdit={handleEdit}
            onQualify={handleQualify}
            onDelete={handleDelete}
            onSendEmail={handleSendEmail}
            onAddNote={handleAddNote}
          />
        </div>
      </div>
    </div>
  )
}
