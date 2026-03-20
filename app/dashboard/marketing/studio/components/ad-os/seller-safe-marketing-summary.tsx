"use client"

// ============================================================
// SELLER-SAFE MARKETING SUMMARY
// Produces a plain-language summary of campaign performance
// that can be copied into a seller update message.
// Data source: campaigns table (live query via server action).
// AI generation via generateMarketingInsight in ad-os-actions.
// ============================================================

import { useState, useTransition } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Loader2, FileText, Copy, CheckCheck, Users, Send } from "lucide-react"
import { generateMarketingInsight } from "./ad-os-actions"
import { useToast } from "@/hooks/use-toast"
import Link from "next/link"

// ─── Types ────────────────────────────────────────────────────────────────────

interface Campaign {
  id: string
  campaign_name: string
  campaign_type: string
  status: string
  budget_total: number
  budget_spent: number
  listing?: { address?: string; city?: string }
}

interface Props {
  campaigns: Campaign[]
  agentName?: string
}

// ─── Component ───────────────────────────────────────────────────────────────

export function SellerSafeMarketingSummary({ campaigns, agentName = "Your Agent" }: Props) {
  const [selectedId, setSelectedId] = useState<string>("")
  const [summary, setSummary] = useState<string>("")
  const [copied, setCopied] = useState(false)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()

  const activeCampaigns = campaigns.filter((c) => ["active", "launched"].includes(c.status))
  const selectedCampaign = activeCampaigns.find((c) => c.id === selectedId)

  function handleGenerate() {
    if (!selectedCampaign) return
    startTransition(async () => {
      const spent = selectedCampaign.budget_spent ?? 0
      const total = selectedCampaign.budget_total ?? 0
      const pctUsed = total > 0 ? Math.round((spent / total) * 100) : 0
      const address = selectedCampaign.listing?.address ?? "the property"
      const city = selectedCampaign.listing?.city ?? ""

      const prompt = `Write a seller-friendly marketing update for a home seller. Keep it professional but warm. No jargon.

CAMPAIGN DETAILS:
- Property: ${address}${city ? `, ${city}` : ""}
- Campaign type: ${selectedCampaign.campaign_type}
- Campaign name: "${selectedCampaign.campaign_name}"
- Budget used: $${spent.toLocaleString()} of $${total.toLocaleString()} (${pctUsed}% utilized)
- Agent: ${agentName}

Write 3-4 sentences that:
1. Confirm the marketing is actively running
2. Mention the ${selectedCampaign.campaign_type} campaign without using the word "budget" negatively
3. Tell the seller what to expect next (showings, inquiries)
4. End with a reassuring, action-oriented close

Tone: confident, client-facing, no technical marketing terms.`

      const res = await generateMarketingInsight(prompt)
      if (res.success && res.text) {
        setSummary(res.text.trim())
      } else {
        toast({
          title: "Could not generate summary",
          description: res.error,
          variant: "destructive",
        })
      }
    })
  }

  async function handleCopy() {
    if (!summary) return
    await navigator.clipboard.writeText(summary)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    toast({ title: "Copied to clipboard" })
  }

  const sellerContactId = selectedCampaign
    ? (selectedCampaign as any).contact_id ?? null
    : null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4 text-violet-600" />
          Seller-Safe Marketing Summary
        </CardTitle>
        <CardDescription>
          Generate a plain-language campaign update to send directly to your seller.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Campaign selector */}
        <div className="space-y-1.5">
          <Label htmlFor="campaign-select">Active Campaign</Label>
          {activeCampaigns.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground border border-dashed border-border rounded-md p-3">
              <Users className="h-4 w-4 shrink-0" />
              No active campaigns found. Launch a campaign first.
            </div>
          ) : (
            <Select value={selectedId} onValueChange={setSelectedId}>
              <SelectTrigger id="campaign-select">
                <SelectValue placeholder="Choose a campaign..." />
              </SelectTrigger>
              <SelectContent>
                {activeCampaigns.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <div className="flex items-center gap-2">
                      <span>{c.campaign_name}</span>
                      <Badge variant="outline" className="text-xs capitalize">
                        {c.campaign_type}
                      </Badge>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* Generate button */}
        <Button
          onClick={handleGenerate}
          disabled={!selectedId || isPending}
          className="w-full"
        >
          {isPending ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Generating summary...
            </>
          ) : (
            <>
              <FileText className="h-4 w-4 mr-2" />
              Generate Seller Summary
            </>
          )}
        </Button>

        {/* Generated summary */}
        {summary && (
          <div className="space-y-2">
            <Label>Generated Update</Label>
            <Textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={6}
              className="resize-none text-sm leading-relaxed"
            />
            <p className="text-xs text-muted-foreground">
              Review and edit before sending. This is a draft.
            </p>

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={handleCopy} className="gap-1.5">
                {copied ? (
                  <>
                    <CheckCheck className="h-3.5 w-3.5 text-emerald-600" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    Copy
                  </>
                )}
              </Button>

              {/* Link to messages composer if we have a contact_id */}
              {sellerContactId ? (
                <Link href={`/portal/${sellerContactId}/messages`}>
                  <Button size="sm" variant="default" className="gap-1.5">
                    <Send className="h-3.5 w-3.5" />
                    Open in Seller Messages
                  </Button>
                </Link>
              ) : (
                <Link href="/dashboard/communications/inbox">
                  <Button size="sm" variant="default" className="gap-1.5">
                    <Send className="h-3.5 w-3.5" />
                    Open Messages
                  </Button>
                </Link>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
