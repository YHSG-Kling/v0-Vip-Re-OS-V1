"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { SendHorizontal, RefreshCw, AlertTriangle, Loader2, ExternalLink } from "lucide-react"
import { SignatureStatusBadge } from "./SignatureStatusBadge"
import {
  sendDocumentForSignature,
  resendDocumentForSignature,
} from "@/app/actions/transaction-document-signatures"

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface Signer {
  name: string
  email: string
  role: string
}

interface DocumentSignaturePanelProps {
  transactionId: string
  documentId: string
  docType: string
  docLabel: string | null
  userId: string
  brokerageId: string
  // Pre-resolved provider from server (brokerage-owned, not contact-owned)
  connectedProvider: { platform: string; accountName: string | null } | null
  // Existing signature state (from contract_signatures)
  existingSignatureId?: string | null
  esignStatus?: string | null
  providerName?: string | null
  sentAt?: string | null
  agentSignedAt?: string | null
  fullySignedAt?: string | null
  // Signers to pre-populate (contact + agent)
  defaultSigners?: Signer[]
  onSent?: () => void
  className?: string
}

// ─── COMPONENT ────────────────────────────────────────────────────────────────

export function DocumentSignaturePanel({
  transactionId,
  documentId,
  docType,
  docLabel,
  userId,
  brokerageId,
  connectedProvider,
  existingSignatureId,
  esignStatus,
  providerName,
  sentAt,
  agentSignedAt,
  fullySignedAt,
  defaultSigners = [],
  onSent,
  className,
}: DocumentSignaturePanelProps) {
  const [isPending, startTransition] = useTransition()
  const [localStatus, setLocalStatus] = useState<string | null>(esignStatus ?? null)
  const [localSentAt, setLocalSentAt] = useState<string | null>(sentAt ?? null)
  const [error, setError] = useState<string | null>(null)

  const isFullySigned = localStatus === "fully_signed"
  const isSent       = localStatus === "sent" || localStatus === "partially_signed"
  const hasProvider  = connectedProvider !== null

  function handleSend() {
    setError(null)
    startTransition(async () => {
      const signers = defaultSigners.length
        ? defaultSigners
        : [{ name: "Primary Signer", email: "", role: "signer" }]

      const result = await sendDocumentForSignature({
        transactionId,
        documentId,
        docType,
        docLabel,
        signers,
        userId,
        brokerageId,
      })

      if (!result.success) {
        setError(result.error ?? "Failed to send")
        return
      }

      setLocalStatus("sent")
      setLocalSentAt(new Date().toISOString())
      onSent?.()
    })
  }

  function handleResend() {
    if (!existingSignatureId) return handleSend()
    setError(null)
    startTransition(async () => {
      const result = await resendDocumentForSignature({
        signatureId: existingSignatureId,
        userId,
        brokerageId,
        transactionId,
      })
      if (!result.success) {
        setError(result.error ?? "Failed to resend")
        return
      }
      setLocalSentAt(new Date().toISOString())
      onSent?.()
    })
  }

  // ── No provider connected — show blocker ──────────────────────────────────
  if (!hasProvider) {
    return (
      <div className={cn("flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-1.5", className)}>
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span>No e-sign provider connected. Configure one in</span>
        <a href="/dashboard/settings/integrations" className="underline font-medium hover:text-amber-900">
          Settings
        </a>
      </div>
    )
  }

  return (
    <div className={cn("space-y-1.5", className)}>
      {/* Status badge */}
      <SignatureStatusBadge
        esignStatus={localStatus}
        esignProvider={providerName ?? connectedProvider?.platform ?? null}
        esignSentAt={localSentAt}
        esignCompletedAt={fullySignedAt ?? null}
        buyerSignedAt={agentSignedAt ?? null}
        compact
      />

      {/* Error */}
      {error && (
        <p className="text-xs text-red-600 flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" /> {error}
        </p>
      )}

      {/* Actions */}
      {!isFullySigned && (
        <div className="flex items-center gap-2 flex-wrap">
          {isSent ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5"
              onClick={handleResend}
              disabled={isPending}
            >
              {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              Resend
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5"
              onClick={handleSend}
              disabled={isPending}
            >
              {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <SendHorizontal className="h-3 w-3" />}
              Send for Signatures
            </Button>
          )}

          {/* Open provider packet if provider_ref available */}
          {providerName && (
            <Badge variant="outline" className="text-xs h-6 px-2 font-normal capitalize">
              {providerName}
            </Badge>
          )}
        </div>
      )}
    </div>
  )
}
