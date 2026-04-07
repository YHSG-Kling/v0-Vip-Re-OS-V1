"use client"

/**
 * app/components/features/offers/offer-document-panel.tsx
 *
 * Shows the offer document (PDF link), AI extraction status, and e-sign status.
 * No mutations here — document attachment and esign sending happen in offers-client.tsx.
 * This panel is read-only view for the offer detail workspace.
 */

import { cn } from "@/lib/utils"
import { FileText, CheckCircle, Clock, AlertCircle, ExternalLink } from "lucide-react"

// ─── Types ────────────────────────────────────────────────────────────────────

interface OfferDocumentPanelProps {
  offerId:             string
  documentUrl:         string | null
  documentName:        string | null
  aiExtractionStatus:  string | null
  esignStatus?:        string | null
  esignSentAt?:        string | null
  esignCompletedAt?:   string | null
  esignProvider?:      string | null
}

// ─── Status icon ─────────────────────────────────────────────────────────────

function ExtractionStatus({ status }: { status: string | null }) {
  if (!status || status === "pending") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="h-3.5 w-3.5" />
        AI extraction pending
      </span>
    )
  }
  if (status === "completed" || status === "extracted") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-green-700">
        <CheckCircle className="h-3.5 w-3.5" />
        AI extraction complete
      </span>
    )
  }
  if (status === "failed" || status === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-red-600">
        <AlertCircle className="h-3.5 w-3.5" />
        AI extraction failed
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground capitalize">
      <Clock className="h-3.5 w-3.5" />
      {status}
    </span>
  )
}

// ─── Esign section ────────────────────────────────────────────────────────────

function EsignSection({
  status,
  sentAt,
  completedAt,
  provider,
}: {
  status:      string | null
  sentAt:      string | null
  completedAt: string | null
  provider:    string | null
}) {
  if (!status || status === "not_sent") {
    return (
      <div className="rounded-lg border border-border bg-muted/20 px-4 py-3">
        <p className="text-xs text-muted-foreground">
          E-signature not yet sent. Use the &quot;Send for E-Sign&quot; action on the offers list to initiate signing.
        </p>
      </div>
    )
  }

  const statusConfig: Record<string, { label: string; color: string; icon: typeof CheckCircle }> = {
    sent:      { label: "Sent for signing",  color: "text-blue-700",  icon: Clock },
    pending:   { label: "Awaiting signature", color: "text-amber-700", icon: Clock },
    signed:    { label: "Signed by buyer",    color: "text-green-700", icon: CheckCircle },
    completed: { label: "Fully executed",     color: "text-green-700", icon: CheckCircle },
    voided:    { label: "Voided",             color: "text-muted-foreground", icon: AlertCircle },
    declined:  { label: "Declined",           color: "text-red-600",   icon: AlertCircle },
  }

  const cfg = statusConfig[status] ?? { label: status, color: "text-muted-foreground", icon: Clock }
  const Icon = cfg.icon

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon className={cn("h-4 w-4", cfg.color)} />
        <span className={cn("text-sm font-medium", cfg.color)}>{cfg.label}</span>
        {provider && (
          <span className="text-xs text-muted-foreground">via {provider}</span>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
        {sentAt && (
          <>
            <dt className="text-xs text-muted-foreground">Sent</dt>
            <dd className="text-xs font-medium">
              {new Date(sentAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </dd>
          </>
        )}
        {completedAt && (
          <>
            <dt className="text-xs text-muted-foreground">Completed</dt>
            <dd className="text-xs font-medium text-green-700">
              {new Date(completedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </dd>
          </>
        )}
      </dl>
    </div>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function OfferDocumentPanel({
  offerId,
  documentUrl,
  documentName,
  aiExtractionStatus,
  esignStatus     = null,
  esignSentAt     = null,
  esignCompletedAt = null,
  esignProvider   = null,
}: OfferDocumentPanelProps) {
  return (
    <div className="space-y-6">
      {/* Document card */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Offer Document
        </h3>

        {documentUrl ? (
          <div className="flex items-start gap-4 rounded-lg border border-border bg-muted/20 p-4">
            <div className="rounded-md border border-border bg-background p-2.5">
              <FileText className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0 space-y-1.5">
              <p className="text-sm font-medium text-foreground truncate">
                {documentName ?? "Offer Document"}
              </p>
              <ExtractionStatus status={aiExtractionStatus} />
              <a
                href={documentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline mt-1"
              >
                View document
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/10 py-10 gap-2">
            <FileText className="h-7 w-7 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No document attached to this offer.</p>
            <p className="text-xs text-muted-foreground">
              Offer #{offerId.slice(0, 8)} — documents can be uploaded from the buyer offer wizard.
            </p>
          </div>
        )}
      </section>

      {/* E-Sign section */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          E-Signature Status
        </h3>
        <EsignSection
          status={esignStatus}
          sentAt={esignSentAt}
          completedAt={esignCompletedAt}
          provider={esignProvider}
        />
      </section>
    </div>
  )
}
