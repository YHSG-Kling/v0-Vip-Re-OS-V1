"use client"

// ============================================================
// PANEL — Listing Copy Enhancer
// Rewrites a listing's public remarks for a target buyer style.
//
// READ-ONLY BY DESIGN. enhanceListingDescription returns copy; it does not
// write listings.public_remarks. The listing rail owns that column
// (app/actions/listings-kernel.ts), so this surface hands the agent the text
// to review and paste rather than becoming a second writer for `listings`.
// ============================================================

import { useState } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2, PenLine, Copy, AlertCircle } from "lucide-react"
import { enhanceListingDescription } from "@/app/actions/ai-marketing-automation"

type Style = "luxury" | "family" | "investment" | "first_time_buyer"

const STYLES: { value: Style; label: string }[] = [
  { value: "luxury", label: "Luxury buyer" },
  { value: "family", label: "Family buyer" },
  { value: "investment", label: "Investor" },
  { value: "first_time_buyer", label: "First-time buyer" },
]

interface Props {
  agentId: string
  listings: Array<{ id: string; address: string; city: string }>
}

export function ListingCopyPanel({ agentId, listings }: Props) {
  const [listingId, setListingId] = useState("")
  const [style, setStyle] = useState<Style>("family")
  const [isRunning, setIsRunning] = useState(false)
  const [enhanced, setEnhanced] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function handleRun() {
    if (!listingId || !agentId) return
    setIsRunning(true)
    setError(null)
    setEnhanced(null)
    setCopied(false)
    try {
      const res = await enhanceListingDescription(listingId, agentId, style)
      // Report the SERVER's verdict — a refusal is not an empty result.
      if (!res.success) setError(res.error ?? "Could not enhance the description")
      else setEnhanced(res.enhanced ?? "")
    } catch {
      setError("Unexpected error — please try again")
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <Card className="border-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PenLine className="h-5 w-5 text-violet-600" />
          Listing Copy Enhancer
        </CardTitle>
        <CardDescription>
          Rewrite a listing&apos;s public remarks for a specific buyer type. Review and
          paste into the listing — nothing is published from here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!agentId && (
          <p className="text-xs text-yellow-800 bg-yellow-50 rounded p-2">
            No agent profile resolved for your account — finish Settings → Profile first.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Listing</Label>
            <Select value={listingId} onValueChange={setListingId}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder={listings.length ? "Choose a listing" : "No listings"} />
              </SelectTrigger>
              <SelectContent>
                {listings.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.address}
                    {l.city ? `, ${l.city}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Buyer Style</Label>
            <Select value={style} onValueChange={(v) => setStyle(v as Style)}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STYLES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <Button
          onClick={handleRun}
          disabled={isRunning || !listingId || !agentId}
          className="w-full bg-violet-600 hover:bg-violet-700"
        >
          {isRunning ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Rewriting...
            </>
          ) : (
            <>
              <PenLine className="mr-2 h-4 w-4" />
              Rewrite for this buyer
            </>
          )}
        </Button>

        {error && (
          <p className="text-sm text-red-700 bg-red-50 rounded-md p-2 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            {error}
          </p>
        )}

        {enhanced !== null && (
          <div className="space-y-2 border-t pt-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Suggested copy</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  navigator.clipboard?.writeText(enhanced)
                  setCopied(true)
                }}
              >
                <Copy className="h-3.5 w-3.5 mr-1.5" />
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-sm whitespace-pre-wrap rounded-md bg-muted/40 p-3 leading-relaxed">
              {enhanced}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
