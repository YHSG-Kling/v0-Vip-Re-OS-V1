"use client"

import { useState, useTransition } from "react"
import { cn } from "@/lib/utils"
import { submitForSignature } from "@/app/actions/buyer-offer/submit-for-signature"
import { SignatureStatusBadge } from "./SignatureStatusBadge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { AlertCircle, Check, ExternalLink, Loader2, PenLine, Plus, Trash2, UserPlus } from "lucide-react"

// Uses offers table columns: esign_provider, esign_status, esign_sent_at,
// esign_completed_at, buyer_signed_at
export interface SendForSignaturesPanelProps {
  offerId:          string
  userId:           string
  // Resolved from platform_credentials — null means no provider connected
  connectedProvider: { platform: string; accountName: string | null } | null
  // Pre-populated signers from existing offer data
  buyerName?:       string
  buyerEmail?:      string
  agentName?:       string
  agentEmail?:      string
  // Current signature state from offers table
  esignStatus?:     string | null
  esignProvider?:   string | null
  esignSentAt?:     string | null
  esignCompletedAt?: string | null
  buyerSignedAt?:   string | null
  // Optional signing link from provider (if provider returns one)
  providerSigningUrl?: string | null
  // Called after successful send
  onSent?: () => void
  className?: string
}

interface Signer {
  name:  string
  email: string
  role:  "buyer" | "co_buyer" | "agent"
}

const PROVIDER_LABELS: Record<string, string> = {
  dotloop:      "Dotloop",
  docusign:     "DocuSign",
  skyslope:     "SkySlope",
  authentisign: "Authentisign",
}

function providerLabel(platform: string) {
  return PROVIDER_LABELS[platform.toLowerCase()] ?? platform
}

export function SendForSignaturesPanel({
  offerId,
  userId,
  connectedProvider,
  buyerName  = "",
  buyerEmail = "",
  agentName  = "",
  agentEmail = "",
  esignStatus,
  esignProvider,
  esignSentAt,
  esignCompletedAt,
  buyerSignedAt,
  providerSigningUrl,
  onSent,
  className,
}: SendForSignaturesPanelProps) {
  const alreadySent = !!esignSentAt

  const [signers, setSigners] = useState<Signer[]>(() => {
    const initial: Signer[] = []
    if (buyerEmail) initial.push({ name: buyerName, email: buyerEmail, role: "buyer" })
    if (agentEmail) initial.push({ name: agentName, email: agentEmail, role: "agent" })
    return initial
  })
  const [result, setResult]       = useState<{ success: boolean; error?: string; blockerType?: string } | null>(null)
  const [isPending, startTrans]   = useTransition()
  const [open, setOpen]           = useState(false)
  const [newName, setNewName]     = useState("")
  const [newEmail, setNewEmail]   = useState("")

  function addCoBuyer() {
    if (!newEmail.trim()) return
    setSigners(prev => [...prev, { name: newName.trim(), email: newEmail.trim(), role: "co_buyer" }])
    setNewName("")
    setNewEmail("")
  }

  function removeSigner(index: number) {
    setSigners(prev => prev.filter((_, i) => i !== index))
  }

  function handleSend() {
    if (signers.length === 0) return
    setResult(null)
    startTrans(async () => {
      const res = await submitForSignature({ offerId, userId, signers })
      setResult(res)
      if (res.success) {
        onSent?.()
        setTimeout(() => setOpen(false), 1200)
      }
    })
  }

  // Already fully signed — show status only
  if (esignStatus === "fully_signed" || !!esignCompletedAt) {
    return (
      <SignatureStatusBadge
        esignStatus={esignStatus}
        esignProvider={esignProvider}
        esignSentAt={esignSentAt}
        esignCompletedAt={esignCompletedAt}
        buyerSignedAt={buyerSignedAt}
        className={className}
      />
    )
  }

  return (
    <div className={cn("space-y-2", className)}>
      {/* Status badge always visible */}
      <SignatureStatusBadge
        esignStatus={esignStatus}
        esignProvider={esignProvider}
        esignSentAt={esignSentAt}
        esignCompletedAt={esignCompletedAt}
        buyerSignedAt={buyerSignedAt}
      />

      {/* Provider signing link if available */}
      {providerSigningUrl && (
        <a
          href={providerSigningUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open Provider Packet
        </a>
      )}

      {/* Sheet trigger */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            size="sm"
            variant={alreadySent ? "outline" : "default"}
            className="w-full"
            disabled={!connectedProvider}
          >
            <PenLine className="h-4 w-4 mr-2" />
            {alreadySent ? "Resend for Signatures" : "Send for Signatures"}
          </Button>
        </SheetTrigger>

        {/* No provider connected — show blocked state in trigger area */}
        {!connectedProvider && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>
              No e-sign provider connected.{" "}
              <a
                href="/dashboard/settings/integrations"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium underline"
              >
                Connect one in Settings
              </a>
              .
            </span>
          </div>
        )}

        <SheetContent side="right" className="w-full sm:max-w-md flex flex-col">
          <SheetHeader>
            <SheetTitle>Send for Signatures</SheetTitle>
            <SheetDescription>
              {connectedProvider
                ? `Sending with ${providerLabel(connectedProvider.platform)}${connectedProvider.accountName ? ` — ${connectedProvider.accountName}` : ""}`
                : "No e-sign provider connected"}
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto py-4 space-y-5">
            {/* Compliance gate error */}
            {result && !result.success && result.blockerType === "compliance_gate" && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 flex items-start gap-2.5">
                <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-destructive">Compliance check not passed</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    This offer must pass compliance review before it can be sent for signatures. Check the compliance tab.
                  </p>
                </div>
              </div>
            )}

            {/* Generic error */}
            {result && !result.success && result.blockerType !== "compliance_gate" && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {result.error}
              </div>
            )}

            {/* Success */}
            {result?.success && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 flex items-center gap-2 text-sm text-emerald-700">
                <Check className="h-4 w-4 shrink-0" />
                Offer submitted for signature
              </div>
            )}

            {/* Signer list */}
            <div className="space-y-2">
              <p className="text-sm font-medium">Signers</p>
              {signers.length === 0 && (
                <p className="text-xs text-muted-foreground">No signers added yet.</p>
              )}
              {signers.map((signer, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{signer.name || signer.email}</p>
                    <p className="text-xs text-muted-foreground truncate">{signer.email}</p>
                  </div>
                  <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground capitalize">
                    {signer.role.replace("_", " ")}
                  </span>
                  {/* Don't allow removing the primary buyer */}
                  {signer.role !== "buyer" && (
                    <button
                      onClick={() => removeSigner(i)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                      aria-label="Remove signer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Add co-buyer */}
            <div className="space-y-2">
              <p className="text-sm font-medium flex items-center gap-1.5">
                <UserPlus className="h-3.5 w-3.5" />
                Add Co-Buyer
              </p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">Name</Label>
                  <Input
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    placeholder="Full name"
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs">Email</Label>
                  <Input
                    type="email"
                    value={newEmail}
                    onChange={e => setNewEmail(e.target.value)}
                    placeholder="email@example.com"
                    className="h-8 text-sm"
                  />
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={addCoBuyer}
                disabled={!newEmail.trim()}
                className="w-full"
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Add Co-Buyer
              </Button>
            </div>
          </div>

          {/* Footer */}
          <div className="border-t border-border pt-4 space-y-2">
            <Button
              className="w-full"
              onClick={handleSend}
              disabled={isPending || signers.length === 0 || !connectedProvider || !!result?.success}
            >
              {isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Sending...</>
              ) : result?.success ? (
                <><Check className="h-4 w-4 mr-2" />Sent</>
              ) : (
                <><PenLine className="h-4 w-4 mr-2" />Send for Signatures</>
              )}
            </Button>
            <p className="text-xs text-center text-muted-foreground">
              Signers will receive an email with a link to review and sign the offer.
            </p>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
