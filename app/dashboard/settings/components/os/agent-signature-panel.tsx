"use client"

/**
 * AgentSignaturePanel
 * ─────────────────────────────────────────────────────────────────────────────
 * Allows an agent to set their personal email signature.
 * Stored in users.email_signature and used by assemble-email.ts
 * as a per-user override over the brokerage-level signature.
 */

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Mail, Save } from "lucide-react"
import { toast } from "sonner"
import { saveAgentEmailSignature } from "@/app/actions/user-profile"

interface AgentSignaturePanelProps {
  currentSignature: string | null
}

export function AgentSignaturePanel({ currentSignature }: AgentSignaturePanelProps) {
  const [signature, setSignature] = useState(currentSignature ?? "")
  const [isPending, startTransition] = useTransition()

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
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Mail className="h-4 w-4" />
          Personal Email Signature
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Appended below every email you send. Overrides the brokerage default when set.
          Plain text or simple HTML accepted.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="agent-signature" className="text-xs">
            Signature (HTML or plain text)
          </Label>
          <Textarea
            id="agent-signature"
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
            placeholder={`John Smith | REALTOR®\nDRE #01234567\nBest Realty Group\njohn@example.com | (555) 123-4567`}
            rows={6}
            className="font-mono text-xs resize-y"
          />
        </div>

        {signature && (
          <div className="rounded border bg-muted/40 p-3">
            <p className="text-xs text-muted-foreground mb-1.5 font-medium">Preview</p>
            <div
              className="text-xs"
              dangerouslySetInnerHTML={{ __html: signature.replace(/\n/g, "<br/>") }}
            />
          </div>
        )}

        <Button
          size="sm"
          onClick={handleSave}
          disabled={isPending}
          className="w-full"
        >
          <Save className="h-3.5 w-3.5 mr-1.5" />
          {isPending ? "Saving..." : "Save Signature"}
        </Button>
      </CardContent>
    </Card>
  )
}
