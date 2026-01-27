"use client"

import { X } from "lucide-react"
import { ContactDetail } from "@/components/ContactDetail"
import type { Contact } from "@/types/contact"

interface ContactDetailModalProps {
  contact: Contact
  onClose: () => void
}

export default function ContactDetailModal({ contact, onClose }: ContactDetailModalProps) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-6xl w-full max-h-[90vh] overflow-y-auto relative">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-2 hover:bg-slate-100 rounded-lg transition-colors z-10"
        >
          <X className="w-5 h-5 text-slate-600" />
        </button>

        {/* Contact Detail Content */}
        <div className="p-6">
          <ContactDetail
            contact={contact}
            onEdit={() => console.log("Edit contact", contact.id)}
            onQualify={() => console.log("Qualify contact", contact.id)}
            onDelete={() => {
              console.log("Delete contact", contact.id)
              onClose()
            }}
            onSendEmail={() => console.log("Send email to", contact.email)}
            onAddNote={(note) => console.log("Add note:", note)}
          />
        </div>
      </div>
    </div>
  )
}
