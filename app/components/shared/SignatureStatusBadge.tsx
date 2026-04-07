"use client"

import { cn } from "@/lib/utils"
import { CheckCircle2, Clock, PenLine, Send } from "lucide-react"

// Reflects actual offers table columns: esign_status, esign_provider, esign_sent_at,
// esign_completed_at, buyer_signed_at
export interface SignatureStatusBadgeProps {
  esignStatus:      string | null | undefined
  esignProvider?:   string | null
  esignSentAt?:     string | null
  esignCompletedAt?: string | null
  buyerSignedAt?:   string | null
  compact?:         boolean
  className?:       string
}

type SignatureState =
  | "fully_signed"
  | "partially_signed"
  | "awaiting_signatures"
  | "not_sent"

function deriveState(
  esignStatus: string | null | undefined,
  esignCompletedAt: string | null | undefined,
  buyerSignedAt: string | null | undefined,
  esignSentAt: string | null | undefined,
): SignatureState {
  if (esignStatus === "fully_signed" || !!esignCompletedAt) return "fully_signed"
  if (esignStatus === "partially_signed" || !!buyerSignedAt) return "partially_signed"
  if (esignStatus === "sent" || !!esignSentAt) return "awaiting_signatures"
  return "not_sent"
}

const STATE_CONFIG: Record<SignatureState, {
  label:     string
  icon:      React.ElementType
  bg:        string
  text:      string
  border:    string
}> = {
  fully_signed: {
    label:  "Fully Signed",
    icon:   CheckCircle2,
    bg:     "bg-emerald-50",
    text:   "text-emerald-700",
    border: "border-emerald-200",
  },
  partially_signed: {
    label:  "Partially Signed",
    icon:   PenLine,
    bg:     "bg-amber-50",
    text:   "text-amber-700",
    border: "border-amber-200",
  },
  awaiting_signatures: {
    label:  "Awaiting Signatures",
    icon:   Clock,
    bg:     "bg-blue-50",
    text:   "text-blue-700",
    border: "border-blue-200",
  },
  not_sent: {
    label:  "Not Sent",
    icon:   Send,
    bg:     "bg-muted",
    text:   "text-muted-foreground",
    border: "border-border",
  },
}

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day:   "numeric",
    year:  "numeric",
  })
}

function providerLabel(provider: string) {
  const map: Record<string, string> = {
    dotloop:     "Dotloop",
    docusign:    "DocuSign",
    skyslope:    "SkySlope",
    authentisign:"Authentisign",
  }
  return map[provider.toLowerCase()] ?? provider
}

export function SignatureStatusBadge({
  esignStatus,
  esignProvider,
  esignSentAt,
  esignCompletedAt,
  buyerSignedAt,
  compact = false,
  className,
}: SignatureStatusBadgeProps) {
  const state  = deriveState(esignStatus, esignCompletedAt, buyerSignedAt, esignSentAt)
  const config = STATE_CONFIG[state]
  const Icon   = config.icon

  if (compact) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
          config.bg, config.text, config.border,
          className,
        )}
      >
        <Icon className="h-3 w-3 shrink-0" />
        {config.label}
      </span>
    )
  }

  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2.5 flex items-start gap-2.5",
        config.bg, config.border,
        className,
      )}
    >
      <Icon className={cn("h-4 w-4 shrink-0 mt-0.5", config.text)} />
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn("text-sm font-medium", config.text)}>{config.label}</span>
          {esignProvider && (
            <span className="text-xs text-muted-foreground">
              via {providerLabel(esignProvider)}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {esignSentAt && (
            <span>Sent {fmt(esignSentAt)}</span>
          )}
          {buyerSignedAt && (
            <span>Buyer signed {fmt(buyerSignedAt)}</span>
          )}
          {esignCompletedAt && (
            <span>Completed {fmt(esignCompletedAt)}</span>
          )}
        </div>
      </div>
    </div>
  )
}
