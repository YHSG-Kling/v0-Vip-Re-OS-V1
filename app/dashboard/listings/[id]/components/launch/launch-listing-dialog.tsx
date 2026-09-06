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
 * becomes real: listings.mls_number is written by exactly one function —
 * launchListing — and this dialog is the only thing that calls it.
 *
 * THE NUMBER IS TYPED, NOT FETCHED. Owner ruling: the admin enters the listing
 * into the MLS (or state MLS) by hand, so they already hold the number. RentCast
 * and IDX are not a source for it.
 *
 * What they ARE for is the opposite direction — VERIFYING the listing actually
 * went live. That check belongs after launch, not before it (before launch there
 * is nothing on the MLS to find), so it lives on the lifecycle page's MLS row
 * rather than here. See lib/listings/mls-verification.ts.
 *
 * The one pre-launch use of the feeds is a MISMATCH warning: if a feed already
 * shows this address under a different MLS number, the agent should see that
 * before publishing ours, because the number we publish is the one buyers and
 * portals use to find the property.
 */

import { useEffect, useState } from "react"
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
import {
  launchListingAction,
  verifyMlsSyndicationAction,
  validateLaunchReadinessAction,
} from "@/app/actions/listings-kernel"
import type { MlsVerification } from "@/lib/listings/mls-verification"

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
  const [checking, setChecking] = useState(false)
  const [verification, setVerification] = useState<MlsVerification | null>(null)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  /**
   * THE GATE'S OWN VERDICT, BEFORE THE CLICK.
   *
   * `outstanding` is the LIFECYCLE PAGE's hand-rolled checklist (photo count from
   * getListingMedia, required fields, the compliance audit). launchListing does not
   * consult any of that — it calls validateListingLaunchReadiness, which asks four
   * different questions against different tables (seller contact linked, list price
   * set, MLS number present, >= 5 rows in listing_media of type photo). The two
   * lists can and do disagree, and when they do the agent gets a green checklist
   * and a refused launch with no explanation of which rule stopped them.
   *
   * validateLaunchReadinessAction IS that gate, exported and called from nowhere.
   * Running it here shows the refusal before it happens instead of after.
   */
  const [gateBlockers, setGateBlockers] = useState<string[] | null>(null)
  const [gateError, setGateError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setGateBlockers(null)
    setGateError(null)
    validateLaunchReadinessAction(listingId).then((res) => {
      if (cancelled) return
      if (!res.success) {
        // "Could not evaluate" is not "ready" — say which one it is.
        setGateError((res as { error?: string }).error ?? "The launch gate could not be evaluated")
        return
      }
      setGateBlockers((res as { blockers?: string[] }).blockers ?? [])
    })
    return () => { cancelled = true }
  }, [open, listingId])

  // The gate accepts the number being launched WITH, so a stored-number blocker
  // that the typed number satisfies is not a real blocker at launch time.
  const liveGateBlockers = (gateBlockers ?? []).filter(
    (b) => !(mlsNumber.trim() && b.toLowerCase().includes("mls number")),
  )

  const handleCheckFeeds = async () => {
    setChecking(true)
    setResult(null)
    const res = await verifyMlsSyndicationAction(listingId)
    setChecking(false)
    if (!res.success || !res.verification) {
      setVerification(null)
      setResult({ ok: false, message: res.error ?? "Feed check failed" })
      return
    }
    setVerification(res.verification)
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

          {/* The kernel gate's own answer — the one launchListing will enforce. */}
          {gateError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
              <p className="text-xs text-destructive">
                Launch readiness could not be checked — {gateError}. Launch may still be refused.
              </p>
            </div>
          ) : liveGateBlockers.length > 0 ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
              <div className="flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                <p className="text-xs font-medium text-destructive">
                  The launch gate will refuse this listing
                </p>
              </div>
              <ul className="mt-1 text-xs text-destructive list-disc pl-4 space-y-0.5">
                {liveGateBlockers.map((b) => <li key={b}>{b}</li>)}
              </ul>
            </div>
          ) : gateBlockers !== null ? (
            <p className="text-[11px] text-emerald-600 flex items-center gap-1.5">
              <CheckCircle2 className="h-3 w-3" />
              Launch gate checked — no blockers.
            </p>
          ) : null}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="mls-number">MLS Number</Label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-xs"
                onClick={handleCheckFeeds}
                disabled={checking}
              >
                {checking
                  ? <><Loader2 className="h-3 w-3 animate-spin" /> Checking feeds…</>
                  : <><Search className="h-3 w-3" /> Check RentCast / IDX</>}
              </Button>
            </div>
            <Input
              id="mls-number"
              value={mlsNumber}
              onChange={(e) => setMlsNumber(e.target.value)}
              placeholder="e.g. 24-118372"
              autoComplete="off"
            />
            <p className="text-[11px] text-muted-foreground">
              Enter the number from your MLS. The feed check looks for this address to
              confirm it went live — run it again after launch.
            </p>
          </div>

          {verification && (
            <div
              className={`rounded-md border px-3 py-2 space-y-1 ${
                verification.verdict === "confirmed"
                  ? "border-emerald-200 bg-emerald-50/60"
                  : verification.verdict === "contradicted"
                  ? "border-destructive/40 bg-destructive/5"
                  : "border-muted bg-muted/30"
              }`}
            >
              <div className="flex items-center gap-1.5">
                {verification.verdict === "confirmed" ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                ) : verification.verdict === "contradicted" ? (
                  <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                ) : (
                  <Search className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                <p className="text-xs font-medium capitalize">
                  {verification.verdict === "pending" ? "Not seen yet" : verification.verdict}
                </p>
                {verification.consulted.map((c) => (
                  <Badge key={c} variant="outline" className="text-[10px]">
                    {c === "rentcast" ? "RentCast" : "IDX"}
                  </Badge>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{verification.explanation}</p>
              {/* A feed showing this address under a DIFFERENT number is the one
                  case worth acting on before publishing — offer the swap, never
                  apply it silently. */}
              {verification.verdict === "contradicted" && verification.evidence?.mlsNumber && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => setMlsNumber(verification.evidence!.mlsNumber!)}
                >
                  Use MLS# {verification.evidence.mlsNumber} instead
                </Button>
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
