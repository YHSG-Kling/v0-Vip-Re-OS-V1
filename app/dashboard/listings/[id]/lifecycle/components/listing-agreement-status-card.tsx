"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CheckCircle2, XCircle, FileSignature, ExternalLink } from "lucide-react"
import { formatDistanceToNow } from "date-fns"

interface ListingAgreement {
  id: string
  agreement_type: string | null
  esign_status: string | null
  provider_name: string | null
  provider_ref: string | null
  seller_signed_at: string | null
  agent_signed_at: string | null
  fully_executed_at: string | null
  document_url: string | null
  document_name: string | null
  effective_date: string | null
}

interface ListingAgreementStatusCardProps {
  listingId: string
  agreement: ListingAgreement | null
}

const ESIGN_STATUS_MAP: Record<string, { label: string; badge: string }> = {
  pending:          { label: "Pending",          badge: "secondary" },
  sent:             { label: "Sent",             badge: "secondary" },
  partially_signed: { label: "Partially Signed", badge: "secondary" },
  fully_signed:     { label: "Fully Signed",     badge: "default"   },
  declined:         { label: "Declined",         badge: "destructive" },
  voided:           { label: "Voided",           badge: "destructive" },
}

export function ListingAgreementStatusCard({
  listingId,
  agreement,
}: ListingAgreementStatusCardProps) {
  if (!agreement) {
    return (
      <Card className="border-amber-200 bg-amber-50/30">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between">
            <span className="flex items-center gap-2">
              <FileSignature className="h-4 w-4 text-indigo-600" />
              Listing Agreement
            </span>
            <Badge variant="secondary" className="text-xs bg-amber-100 text-amber-700 border-amber-200">
              Not Started
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            No listing agreement has been created for this listing yet.
          </p>
          <Link href={`/dashboard/listings/${listingId}/agreement`}>
            <Button size="sm" variant="outline" className="w-full text-xs">
              <FileSignature className="h-3.5 w-3.5 mr-1.5" />
              Create Agreement
            </Button>
          </Link>
        </CardContent>
      </Card>
    )
  }

  const esignStatus = agreement.esign_status ?? "pending"
  const statusInfo = ESIGN_STATUS_MAP[esignStatus] ?? { label: esignStatus, badge: "secondary" }
  const isFullyExecuted = !!agreement.fully_executed_at
  const isReady = isFullyExecuted

  const agentSigned = !!agreement.agent_signed_at
  const sellerSigned = !!agreement.seller_signed_at

  return (
    <Card className={isReady ? "border-green-200 bg-green-50/30" : "border-amber-200 bg-amber-50/30"}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <FileSignature className="h-4 w-4 text-indigo-600" />
            Listing Agreement
          </span>
          <Badge
            variant={isReady ? "default" : "secondary"}
            className={`text-xs ${isReady ? "" : "bg-amber-100 text-amber-700 border-amber-200"}`}
          >
            {isReady ? "Executed" : statusInfo.label}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          {/* Agreement type */}
          {agreement.agreement_type && (
            <p className="text-xs text-muted-foreground capitalize">
              {agreement.agreement_type.replace(/_/g, " ")}
              {agreement.effective_date && (
                <> &middot; effective {new Date(agreement.effective_date).toLocaleDateString()}</>
              )}
            </p>
          )}

          {/* Signature checklist */}
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              {agentSigned ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-amber-500" />
              )}
              Agent signature
            </span>
            <span className={agentSigned ? "text-green-700 font-medium" : "text-amber-700"}>
              {agentSigned
                ? formatDistanceToNow(new Date(agreement.agent_signed_at!), { addSuffix: true })
                : "Pending"}
            </span>
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              {sellerSigned ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-amber-500" />
              )}
              Seller signature
            </span>
            <span className={sellerSigned ? "text-green-700 font-medium" : "text-amber-700"}>
              {sellerSigned
                ? formatDistanceToNow(new Date(agreement.seller_signed_at!), { addSuffix: true })
                : "Pending"}
            </span>
          </div>

          {/* Provider */}
          {agreement.provider_name && (
            <div className="flex items-center gap-1.5 pt-1 border-t">
              <Badge variant="outline" className="text-xs capitalize">
                {agreement.provider_name}
              </Badge>
            </div>
          )}
        </div>

        {/* CTAs */}
        <div className="flex gap-2">
          {agreement.document_url && (
            <a href={agreement.document_url} target="_blank" rel="noreferrer" className="flex-1">
              <Button size="sm" variant="outline" className="w-full text-xs">
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                View Document
              </Button>
            </a>
          )}
          <Link href={`/dashboard/listings/${listingId}/agreement`} className="flex-1">
            <Button size="sm" variant="outline" className="w-full text-xs">
              <FileSignature className="h-3.5 w-3.5 mr-1.5" />
              Manage
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
