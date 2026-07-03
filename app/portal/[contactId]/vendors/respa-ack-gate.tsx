"use client"

import { useState } from "react"
import { Phone, Building2, ShieldAlert } from "lucide-react"
import { Button } from "@/app/components/ui/button"
import { acknowledgeVendorDisclosureAction } from "@/app/actions/vendor-respa"

/**
 * RESPA AfBA gate — for a vendor the brokerage has an Affiliated Business Arrangement with, the full
 * AfBA disclosure must be acknowledged by the client BEFORE contact info is revealed (RESPA / CFPB
 * AfBA rule). On acknowledgment the server records an immutable compliance-ledger entry, then the
 * contact details render. Non-AfBA preferred disclosures render inline elsewhere (no gate).
 */
export function RespaAckGate({
  contactId,
  vendorId,
  disclosureText,
  disclosureType,
  phone,
  website,
}: {
  contactId: string
  vendorId: string
  disclosureText: string
  disclosureType: "afba" | "preferred_settlement" | "preferred_general"
  phone: string | null
  website: string | null
}) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [pending, setPending] = useState(false)

  async function acknowledge() {
    setPending(true)
    try {
      const res = await acknowledgeVendorDisclosureAction({ contactId, vendorId, disclosureType })
      if (res.ok) setAcknowledged(true)
    } finally {
      setPending(false)
    }
  }

  if (acknowledged) {
    return (
      <div className="space-y-1 text-sm mb-3">
        {phone && (
          <a href={`tel:${phone}`} className="flex items-center gap-2 text-blue-600 hover:underline">
            <Phone className="h-4 w-4" />{phone}
          </a>
        )}
        {website && (
          <a href={website} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-blue-600 hover:underline">
            <Building2 className="h-4 w-4" /> Visit Website
          </a>
        )}
      </div>
    )
  }

  return (
    <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3">
      <div className="flex items-start gap-2">
        <ShieldAlert className="h-4 w-4 text-amber-700 mt-0.5 shrink-0" />
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-800 mb-1">
            Affiliated Business Arrangement Disclosure
          </p>
          <p className="text-[11px] leading-relaxed text-amber-900">{disclosureText}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2 h-7 text-xs border-amber-400"
            disabled={pending}
            onClick={acknowledge}
          >
            {pending ? "Recording…" : "I acknowledge this disclosure"}
          </Button>
        </div>
      </div>
    </div>
  )
}
