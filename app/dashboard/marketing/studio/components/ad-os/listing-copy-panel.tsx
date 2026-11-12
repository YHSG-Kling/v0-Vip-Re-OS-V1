"use client"

// ============================================================
// PANEL — Listing Copy (the agent's AI listing-description tool in Marketing Studio)
//
// Lane 87B (owner wave 87: "listing description can be an ai tool for agents and can
// assist with a new listing marketing"). This panel was the "Listing Copy Enhancer" on
// enhanceListingDescription — a third description writer with a "family" buyer style
// (familial status, Fair Housing). It now reaches the ONE tool
// (app/actions/listings-kernel.ts generateListingDescriptionAction →
// lib/listings/listing-description-tool.ts → the server-only core): the agent picks a
// style from the ONE vocabulary, the copy is written compliance-first from the listing's
// facts AND its current remarks, compliance notes come back with it, a hard Fair-Housing
// flag withholds it, and the launch social caption arrives in the same call.
//
// READ-ONLY BY DESIGN. Nothing here writes listings.public_remarks — the listing rail
// owns that column; the agent copies the text or saves it from the listing page.
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
import { Loader2, PenLine, Copy, AlertCircle, TriangleAlert, Megaphone } from "lucide-react"
import { generateListingDescriptionAction } from "@/app/actions/listings-kernel"
import {
  LISTING_DESCRIPTION_STYLES,
  LISTING_DESCRIPTION_STYLE_LABELS,
  DEFAULT_LISTING_DESCRIPTION_STYLE,
  type ListingDescriptionStyle,
} from "@/lib/listings/listing-description-styles"

type Style = ListingDescriptionStyle

const STYLES: { value: Style; label: string }[] = LISTING_DESCRIPTION_STYLES.map((value) => ({
  value,
  label: LISTING_DESCRIPTION_STYLE_LABELS[value],
}))

interface Props {
  /** agents.id — informational only: the action resolves identity from the session,
   *  and a broker without an agent profile writes in the listing agent's voice. */
  agentId: string
  listings: Array<{ id: string; address: string; city: string }>
}

export function ListingCopyPanel({ agentId, listings }: Props) {
  const [listingId, setListingId] = useState("")
  const [style, setStyle] = useState<Style>(DEFAULT_LISTING_DESCRIPTION_STYLE)
  const [isRunning, setIsRunning] = useState(false)
  const [enhanced, setEnhanced] = useState<string | null>(null)
  const [socialCaption, setSocialCaption] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function handleRun() {
    if (!listingId) return
    setIsRunning(true)
    setError(null)
    setEnhanced(null)
    setSocialCaption(null)
    setWarnings([])
    setCopied(false)
    try {
      const res = (await generateListingDescriptionAction({ listingId, style })) as {
        success: boolean
        error?: string
        description?: string
        socialCaption?: string | null
        warnings?: string[]
      }
      setWarnings(res.warnings ?? [])
      // Report the SERVER's verdict — a refusal (or a held draft) is not an empty result.
      if (!res.success) setError(res.error ?? "Could not draft the description")
      else {
        setEnhanced(res.description ?? "")
        setSocialCaption(res.socialCaption ?? null)
      }
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
          Listing Copy
        </CardTitle>
        <CardDescription>
          Draft a listing&apos;s MLS description and launch social caption with AI. You pick the
          style; Fair Housing rules are written into the draft. Review and copy — nothing is
          published or saved to the listing from here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!agentId && (
          <p className="text-xs text-muted-foreground bg-muted/40 rounded p-2">
            No agent profile on your account — drafts are written in the listing agent&apos;s voice.
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
            <Label className="text-xs font-medium">Style</Label>
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
          disabled={isRunning || !listingId}
          className="w-full bg-violet-600 hover:bg-violet-700"
        >
          {isRunning ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Drafting...
            </>
          ) : (
            <>
              <PenLine className="mr-2 h-4 w-4" />
              Draft with AI
            </>
          )}
        </Button>

        {error && (
          <p className="text-sm text-red-700 bg-red-50 rounded-md p-2 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            {error}
          </p>
        )}

        {warnings.length > 0 && (
          <div className="text-xs text-amber-700 space-y-0.5">
            <p className="font-medium flex items-center gap-1"><TriangleAlert className="h-3.5 w-3.5" />Compliance notes</p>
            {warnings.slice(0, 6).map((w, i) => <p key={i}>{w}</p>)}
          </div>
        )}

        {enhanced !== null && (
          <div className="space-y-2 border-t pt-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Suggested MLS description</span>
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
            {socialCaption && (
              <div className="space-y-1">
                <span className="text-sm font-medium flex items-center gap-1.5"><Megaphone className="h-3.5 w-3.5" />Launch social caption</span>
                <p className="text-sm whitespace-pre-wrap rounded-md bg-muted/40 p-3 leading-relaxed">{socialCaption}</p>
              </div>
            )}
            <a
              className="text-xs text-violet-700 underline"
              href={`/dashboard/listings/${listingId}/lifecycle`}
            >
              Open the listing to edit and save the description
            </a>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
