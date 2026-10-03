"use client"

import { useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Users, Loader2, ArrowRight, AlertTriangle, UserSearch, History } from "lucide-react"
import {
  matchBuyersForListing, scoreSingleBuyerForListing, getListingMatchHistory,
} from "@/app/actions/property-buyer-matching"

/** One previously-logged match signal for this listing (activities row). */
interface MatchSignal {
  signal_id: string
  contact_id?: string
  match_confidence?: string
  match_score?: number
  top_factors?: string[]
  caution_notes?: string[]
  generated_at?: string
}

interface BuyerMatch {
  contact_id: string
  buyer_name: string
  score: number
  match_confidence: string
  match_factors?: string[]
  caution_notes?: string[]
}

const CONFIDENCE_STYLE: Record<string, string> = {
  high: "bg-emerald-100 text-emerald-700 border-emerald-200",
  medium: "bg-amber-100 text-amber-700 border-amber-200",
  low: "bg-gray-100 text-gray-600 border-gray-200",
}

/**
 * Listing → Buyer smart match (System 5.1A). On-demand: runs only when the agent
 * clicks, so no match runs (or activity signals) fire on every listing page load.
 */
export function MatchingBuyersPanel({ listingId, buyerOptions = [] }: {
  listingId: string
  /** Eligible buyer/lead contacts (server-resolved, caller's brokerage) for the
   *  on-demand single-buyer check — the bulk run only surfaces pairs at or above
   *  its threshold, so a below-threshold "how well does THIS buyer fit?" question
   *  was unanswerable until scoreSingleBuyerForListing got this control. */
  buyerOptions?: Array<{ id: string; name: string }>
}) {
  const [loading, setLoading] = useState(false)
  const [matches, setMatches] = useState<BuyerMatch[] | null>(null)
  const [meta, setMeta] = useState<{ evaluated: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checkContactId, setCheckContactId] = useState("")
  const [checking, setChecking] = useState(false)
  const [single, setSingle] = useState<BuyerMatch | null>(null)
  const [singleError, setSingleError] = useState<string | null>(null)
  // PAST MATCHES — the reader half of the signals `matchBuyersForListing` has been
  // writing all along. Every run with `logSignals: true` files a
  // `buyer_match_signal` activity, and `getListingMatchHistory` (tenant-scoped on
  // activities.brokerage_id, session-gated through getAgentContext) was the only
  // way to read them back and had no caller — so the log accumulated for nobody.
  // On demand, never on mount: a panel that fetches history on every listing page
  // load spends a query per render for a tab most agents will not open.
  const [history, setHistory] = useState<MatchSignal[] | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)

  async function loadHistory() {
    if (history) { setHistory(null); return }   // toggle closed
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const res = await getListingMatchHistory({ listingId, limit: 25 })
      if ((res as { success: boolean }).success) {
        setHistory(((res as { signals?: MatchSignal[] }).signals) ?? [])
      } else {
        setHistoryError((res as { error?: string }).error ?? "Could not load match history.")
      }
    } catch {
      setHistoryError("Could not load match history.")
    } finally {
      setHistoryLoading(false)
    }
  }

  async function checkOne() {
    if (!checkContactId) return
    setChecking(true)
    setSingle(null)
    setSingleError(null)
    try {
      const res = await scoreSingleBuyerForListing({ listingId, contactId: checkContactId })
      if ((res as { success: boolean }).success) {
        setSingle((res as { match: BuyerMatch }).match)
      } else {
        setSingleError((res as { error?: string }).error ?? "Could not score this buyer.")
      }
    } catch {
      setSingleError("Could not score this buyer.")
    } finally {
      setChecking(false)
    }
  }

  async function run() {
    setLoading(true)
    setError(null)
    try {
      const res = await matchBuyersForListing({ listingId, logSignals: true })
      if ((res as { success: boolean }).success) {
        const r = res as { matches: BuyerMatch[]; metadata?: { total_buyers_evaluated?: number } }
        setMatches(r.matches ?? [])
        setMeta({ evaluated: r.metadata?.total_buyers_evaluated ?? 0 })
      } else {
        setError((res as { error?: string }).error ?? "Could not run buyer matching.")
      }
    } catch {
      setError("Could not run buyer matching.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4 text-blue-600" />
              Matching Buyers
            </CardTitle>
            <CardDescription>Best-fit buyers from your database for this listing.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={loadHistory} disabled={historyLoading}>
              {historyLoading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <History className="h-4 w-4 mr-1" />}
              {history ? "Hide history" : "Past matches"}
            </Button>
            <Button size="sm" onClick={run} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Users className="h-4 w-4 mr-1" />}
              {matches ? "Re-run" : "Find Buyers"}
            </Button>
          </div>
        </div>
      </CardHeader>
      {(matches || error || history || historyError || buyerOptions.length > 0) && (
        <CardContent className="space-y-2">
          {error && <p className="text-sm text-red-600">{error}</p>}
          {historyError && <p className="text-sm text-red-600">{historyError}</p>}
          {history && (
            <div className="pb-2 border-b space-y-1.5">
              <p className="text-xs font-medium flex items-center gap-1.5">
                <History className="h-3.5 w-3.5" /> Past match signals
              </p>
              {history.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No match signals logged for this listing yet — they are written when you run matching.
                </p>
              ) : (
                history.map((h) => (
                  <div key={h.signal_id} className="flex items-center justify-between gap-3 text-xs">
                    <span className="flex items-center gap-2 min-w-0">
                      {typeof h.match_score === "number" && (
                        <Badge className={CONFIDENCE_STYLE[h.match_confidence ?? "low"] ?? CONFIDENCE_STYLE.low}>
                          {h.match_score}% · {h.match_confidence ?? "—"}
                        </Badge>
                      )}
                      <span className="truncate text-muted-foreground">
                        {(h.top_factors ?? []).slice(0, 2).join(" · ") || "—"}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 shrink-0 text-muted-foreground">
                      {h.generated_at ? new Date(h.generated_at).toLocaleDateString() : ""}
                      {h.contact_id && (
                        <Button size="sm" variant="ghost" asChild className="h-6 px-2">
                          <Link href={`/crm?contact=${h.contact_id}`}>Open <ArrowRight className="h-3 w-3 ml-1" /></Link>
                        </Button>
                      )}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
          {matches && matches.length === 0 && !error && (
            <p className="text-sm text-muted-foreground py-2">
              No strong buyer matches yet{meta ? ` (evaluated ${meta.evaluated})` : ""}. As you add and qualify buyers, matches appear here.
            </p>
          )}
          {matches && matches.length > 0 && (
            <>
              <p className="text-xs text-muted-foreground">{matches.length} match{matches.length === 1 ? "" : "es"} of {meta?.evaluated ?? 0} buyers evaluated</p>
              {matches.map((m) => (
                <div key={m.contact_id} className="p-3 rounded-lg border flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{m.buyer_name}</span>
                      <Badge className={CONFIDENCE_STYLE[m.match_confidence] ?? CONFIDENCE_STYLE.low}>{m.score}% · {m.match_confidence}</Badge>
                    </div>
                    {m.match_factors && m.match_factors.length > 0 && (
                      <p className="text-xs text-muted-foreground mt-1">{m.match_factors.slice(0, 3).join(" · ")}</p>
                    )}
                    {m.caution_notes && m.caution_notes.length > 0 && (
                      <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" />{m.caution_notes[0]}
                      </p>
                    )}
                  </div>
                  <Button size="sm" variant="ghost" asChild>
                    <Link href={`/crm?contact=${m.contact_id}`}>Open <ArrowRight className="h-3 w-3 ml-1" /></Link>
                  </Button>
                </div>
              ))}
            </>
          )}

          {/* On-demand single-buyer fit check (scoreSingleBuyerForListing) */}
          {buyerOptions.length > 0 && (
            <div className="pt-2 border-t space-y-2">
              <p className="text-xs font-medium flex items-center gap-1.5">
                <UserSearch className="h-3.5 w-3.5" /> Check a specific buyer's fit
              </p>
              <div className="flex gap-2">
                <select
                  className="flex-1 rounded border bg-background px-2 py-1 text-sm"
                  value={checkContactId}
                  onChange={(e) => { setCheckContactId(e.target.value); setSingle(null); setSingleError(null) }}
                >
                  <option value="">Choose a buyer or lead…</option>
                  {buyerOptions.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                <Button size="sm" variant="outline" onClick={checkOne} disabled={checking || !checkContactId}>
                  {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : "Check fit"}
                </Button>
              </div>
              {singleError && <p className="text-sm text-red-600">{singleError}</p>}
              {single && (
                <div className="p-3 rounded-lg border">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{single.buyer_name}</span>
                    <Badge className={CONFIDENCE_STYLE[single.match_confidence] ?? CONFIDENCE_STYLE.low}>
                      {single.score}% · {single.match_confidence}
                    </Badge>
                  </div>
                  {single.match_factors && single.match_factors.length > 0 && (
                    <p className="text-xs text-muted-foreground mt-1">{single.match_factors.join(" · ")}</p>
                  )}
                  {single.caution_notes && single.caution_notes.length > 0 && (
                    <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" />{single.caution_notes.join(" · ")}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}
