"use client"

/**
 * LaunchListingDialog — the surface that actually launches a listing.
 *
 * Before this existed, "Launch Listing" on the readiness checklist was a Button
 * with no onClick. launchListingAction was written, exported and reachable from
 * nowhere; the kernel could take a listing to MLS_ACTIVE and no human could ask
 * it to. This is that missing half.
 *
 * It also carries the MLS number, because launching IS the moment the number
 * becomes real:
 *
 *   · listings.mls_number is written by exactly one function — launchListing.
 *   · The agent can type it (they have it from their MLS), or pull a candidate
 *     from RentCast / their connected IDX feed.
 *   · A pulled candidate is NEVER auto-applied. The match is on street address,
 *     which is fuzzy, and a wrong MLS number syndicates the wrong home. The
 *     agent sees the address each candidate came from and clicks the one that
 *     is theirs.
 */

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Rocket, Search, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react"
import { launchListingAction, suggestMlsNumberAction, type MlsSuggestion } from "@/app/actions/listings-kernel"

interface LaunchListingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  listingId: string
  listingAddress: string
  initialMlsNumber: string | null
  initialMlsLink: string | null
  /** Checklist rows still outstanding — shown so the agent knows why launch will refuse. */
  outstanding: string[]
}

export function LaunchListingDialog({
  open,
  onOpenChange,
  listingId,
  listingAddress,
  initialMlsNumber,
  initialMlsLink,
  outstanding,
}: LaunchListingDialogProps) {
  const [mlsNumber, setMlsNumber] = useState(initialMlsNumber ?? "")
  const [mlsLink, setMlsLink] = useState(initialMlsLink ?? "")
  const [launching, setLaunching] = useState(false)
  const [looking, setLooking] = useState(false)
  const [suggestions, setSuggestions] = useState<MlsSuggestion[] | null>(null)
  const [lookupNotes, setLookupNotes] = useState<string[]>([])
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const handleLookup = async () => {
    setLooking(true)
    setResult(null)
    const res = await suggestMlsNumberAction(listingId)
    setLooking(false)
    if (!res.success) {
      setSuggestions([])
      setLookupNotes([])
      setResult({ ok: false, message: res.error ?? "Lookup failed" })
      return
    }
    setSuggestions(res.suggestions)
    setLookupNotes(res.notes)
  }

  const handleLaunch = async () => {
    if (!mlsNumber.trim()) return
    setLaunching(true)
    setResult(null)
    // launchListingAction returns { success, error } and does not throw. A
    // refusal from the readiness gate MUST render as a refusal — this used to
    // be the class of bug where a blocked action still read as done.
    const res = await launchListingAction({
      listingId,
      mlsNumber: mlsNumber.trim(),
      mlsLink: mlsLink.trim() || undefined,
    })
    setLaunching(false)
    if (res.success) {
      setResult({ ok: true, message: "Listing is live on the MLS" })
      onOpenChange(false)
    } else {
      setResult({ ok: false, message: (res as any).error ?? "Launch was refused" })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-4 w-4 text-green-600" />
            Launch Listing
          </DialogTitle>
          <DialogDescription>{listingAddress}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {outstanding.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2">
              <div className="flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                <p className="text-xs font-medium text-amber-800">
                  Still outstanding — launch will be refused until these clear
                </p>
              </div>
              <ul className="mt-1 text-xs text-amber-800 list-disc pl-4 space-y-0.5">
                {outstanding.map((o) => <li key={o}>{o}</li>)}
              </ul>
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="mls-number">MLS Number</Label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-xs"
                onClick={handleLookup}
                disabled={looking}
              >
                {looking
                  ? <><Loader2 className="h-3 w-3 animate-spin" /> Looking up…</>
                  : <><Search className="h-3 w-3" /> Pull from RentCast / IDX</>}
              </Button>
            </div>
            <Input
              id="mls-number"
              value={mlsNumber}
              onChange={(e) => setMlsNumber(e.target.value)}
              placeholder="e.g. 24-118372"
              autoComplete="off"
            />
          </div>

          {suggestions !== null && (
            <div className="space-y-1.5">
              {suggestions.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No MLS number found for this address in the sources we could reach. Enter it manually.
                </p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Confirm the one that matches this property — the match is on street address, so check it.
                  </p>
                  <div className="divide-y rounded-md border">
                    {suggestions.map((s) => (
                      <button
                        key={`${s.source}:${s.mlsNumber}`}
                        type="button"
                        onClick={() => setMlsNumber(s.mlsNumber)}
                        className="w-full text-left flex items-center gap-2 px-3 py-2 hover:bg-muted/40"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium">MLS# {s.mlsNumber}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {s.address}{s.mlsName ? ` · ${s.mlsName}` : ""}
                          </p>
                        </div>
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          {s.source === "rentcast" ? "RentCast" : "IDX"}
                        </Badge>
                        {mlsNumber === s.mlsNumber && (
                          <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0" />
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {lookupNotes.length > 0 && (
                <ul className="text-[11px] text-muted-foreground list-disc pl-4 space-y-0.5">
                  {lookupNotes.map((n) => <li key={n}>{n}</li>)}
                </ul>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="mls-link">MLS Link (optional)</Label>
            <Input
              id="mls-link"
              value={mlsLink}
              onChange={(e) => setMlsLink(e.target.value)}
              placeholder="https://…"
              autoComplete="off"
            />
          </div>

          {result && (
            <p className={`text-xs ${result.ok ? "text-emerald-600" : "text-destructive"}`}>
              {result.message}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={launching}>
            Cancel
          </Button>
          <Button
            className="bg-green-600 hover:bg-green-700 gap-1.5"
            onClick={handleLaunch}
            disabled={launching || !mlsNumber.trim()}
          >
            {launching
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Launching…</>
              : <><Rocket className="h-3.5 w-3.5" /> Go Live</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
