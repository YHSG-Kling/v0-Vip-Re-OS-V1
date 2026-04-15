"use client"

/**
 * AgentSignaturePanel
 * ─────────────────────────────────────────────────────────────────────────────
 * Allows an agent to set their personal email signature with Edit/Preview tabs.
 * Stored in users.email_signature and used by assemble-email.ts
 * as a per-user override over the brokerage-level signature.
 */

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Mail, Save, Eye, Pencil, AlertCircle } from "lucide-react"
import { toast } from "sonner"
import { saveAgentEmailSignature } from "@/app/actions/user-profile"

interface AgentSignaturePanelProps {
  currentSignature: string | null
  brokerageSignature?: string | null
}

export function AgentSignaturePanel({ currentSignature, brokerageSignature }: AgentSignaturePanelProps) {
  const [signature, setSignature] = useState(currentSignature ?? "")
  const [tab, setTab] = useState<"edit" | "preview">("edit")
  const [isPending, startTransition] = useTransition()

  const isInheriting = !signature && !!brokerageSignature
  const previewHtml = signature || brokerageSignature || ""

  function handleSave() {
    startTransition(async () => {
      const result = await saveAgentEmailSignature(signature)
      if (result.success) {
        toast.success("Email signature saved")
      } else {
        toast.error(result.error ?? "Failed to save signature")
      }
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-0.5">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Mail className="h-4 w-4 text-muted-foreground" />
              Personal Email Signature
            </CardTitle>
            <CardDescription className="text-xs">
              Appended to every email you send. Overrides the brokerage default when set.
              HTML or plain text accepted.
            </CardDescription>
          </div>
          {isInheriting && (
            <Badge variant="secondary" className="text-[10px] shrink-0">
              Using brokerage default
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Tab switcher */}
        <div className="flex gap-1 rounded-lg bg-muted p-1 w-fit">
          <button
            onClick={() => setTab("edit")}
            className={`flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-colors ${
              tab === "edit" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
          <button
            onClick={() => setTab("preview")}
            className={`flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-colors ${
              tab === "preview" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Eye className="h-3 w-3" />
            Preview
          </button>
        </div>

        {tab === "edit" ? (
          <div className="space-y-1.5">
            <Label htmlFor="agent-signature" className="text-xs font-medium">
              Signature (HTML or plain text)
            </Label>
            <Textarea
              id="agent-signature"
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              placeholder={`Jane Smith | REALTOR®\nDRE #01234567\nPremier Realty Group\njane@example.com | (555) 123-4567`}
              rows={7}
              className="font-mono text-xs resize-y"
            />
            {isInheriting && (
              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                <AlertCircle className="h-3 w-3 shrink-0" />
                No personal signature set — brokerage default will be used. Type above to override.
              </p>
            )}
          </div>
        ) : (
          <div className="rounded-lg border bg-muted/30 p-4 min-h-[120px]">
            <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-3">
              {isInheriting ? "Brokerage Default (preview)" : "Your Signature (preview)"}
            </p>
            {previewHtml ? (
              <div
                className="text-sm"
                dangerouslySetInnerHTML={{ __html: previewHtml.replace(/\n/g, "<br/>") }}
              />
            ) : (
              <p className="text-xs text-muted-foreground italic">No signature configured</p>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <Button size="sm" onClick={handleSave} disabled={isPending} className="flex-1 gap-1.5">
            <Save className="h-3.5 w-3.5" />
            {isPending ? "Saving..." : "Save Signature"}
          </Button>
          {signature && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setSignature(""); toast.info("Signature cleared — brokerage default will be used") }}
              disabled={isPending}
            >
              Use Brokerage Default
            </Button>
          )}
        </div>

        <p className="text-[10px] text-muted-foreground">
          NAR compliance: Include your license number and brokerage name in all email signatures.
        </p>
      </CardContent>
    </Card>
  )
}
