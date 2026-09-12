"use client"

/**
 * CONTACT ENRICHMENT PANEL — the contact-card surface app/actions/contact-enrichment.ts
 * was written for and never had.
 *
 * Everything the enrichment lane learns about a person — household income, home
 * ownership, occupation, social profiles, public/court/property records, and the
 * life events that are the whole point of the feature (divorce, relocation, new
 * baby, retirement, foreclosure) — was written to `contacts` and then displayed
 * NOWHERE. `getContactInsights` and `markLifeChangeNotified` had no caller at
 * all, so a detected life change re-surfaced forever with no way to acknowledge
 * it, and an agent had no way to say "enrich this person now".
 *
 * Wires the session-door actions:
 *   getContactInsights      → the panel body
 *   enrichContact           → "Enrich now"
 *   checkContactLifeChanges → "Check for changes"
 *   markLifeChangeNotified  → "Mark reviewed" on a detected event
 *
 * THE OWNER'S RULE IS VISIBLE HERE, NOT HIDDEN. Enrichment is suppressed while
 * the contact has an active listing or an active transaction, so the buttons
 * would otherwise look broken during a deal. Both actions report a skip in their
 * result and this panel says so in words ("Paused — this contact has a live deal
 * right now"), because a control that silently does nothing is worse than one
 * that explains why.
 */

import { useCallback, useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, Sparkles, RefreshCw, ShieldCheck, Check } from "lucide-react"
import {
  getContactInsights,
  enrichContact,
  checkContactLifeChanges,
  markLifeChangeNotified,
} from "@/app/actions/contact-enrichment"

interface LifeEvent {
  type?: string
  details?: string
  detected_at?: string
  confidence?: number
  notified_at?: string
}

interface Props {
  contactId: string
}

const FIELD_LABELS: Array<[string, string]> = [
  ["age_range", "Age range"],
  ["gender", "Gender"],
  ["marital_status", "Marital status"],
  ["household_income", "Household income"],
  ["home_owner_status", "Home ownership"],
  ["home_value_estimate", "Home value estimate"],
  ["length_of_residence", "Length of residence"],
  ["occupation", "Occupation"],
  ["education_level", "Education"],
]

const SOCIAL_FIELDS: Array<[string, string]> = [
  ["linkedin_url", "LinkedIn"],
  ["facebook_url", "Facebook"],
  ["twitter_url", "X / Twitter"],
  ["instagram_url", "Instagram"],
]

export function EnrichmentPanel({ contactId }: Props) {
  const [enrichment, setEnrichment] = useState<Record<string, any> | null>(null)
  const [lifeChanges, setLifeChanges] = useState<LifeEvent[]>([])
  const [lastEnriched, setLastEnriched] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const load = useCallback(async () => {
    setLoading(true)
    // The action returns `error` on a refusal — show it rather than rendering an
    // empty panel that looks like "we know nothing about this person".
    const res = await getContactInsights(contactId)
    if (res.error) {
      setNotice(res.error)
    } else {
      setEnrichment(res.enrichment)
      setLifeChanges(Array.isArray(res.lifeChanges) ? res.lifeChanges : [])
      setLastEnriched(res.lastEnriched)
    }
    setLoading(false)
  }, [contactId])

  useEffect(() => { void load() }, [load])

  const runEnrich = () => {
    setNotice(null)
    startTransition(async () => {
      const res = await enrichContact(contactId, { forceRefresh: Boolean(lastEnriched) })
      if (!res.success) {
        setNotice(res.error ?? "Enrichment failed")
      } else if (!res.enriched) {
        // The suppression rule, the vendor budget, or a missing identifier. The
        // action collapses those to enriched:false — say the most likely thing
        // plainly rather than claiming success.
        setNotice(
          "Nothing was enriched. Enrichment is paused while a contact has an active listing or " +
          "an active transaction, and is skipped when there is no email, phone or full name to look up.",
        )
      } else {
        setNotice("Enriched.")
      }
      await load()
    })
  }

  const runLifeCheck = () => {
    setNotice(null)
    startTransition(async () => {
      const res = await checkContactLifeChanges(contactId)
      if (!res.success) {
        setNotice(res.error ?? "Life-change check failed")
      } else {
        setNotice(
          res.changesFound > 0
            ? `${res.changesFound} new change detected.`
            : "No new changes found. (Checks are paused during a live deal.)",
        )
      }
      await load()
    })
  }

  const markReviewed = (eventType: string) => {
    setNotice(null)
    startTransition(async () => {
      const res = await markLifeChangeNotified(contactId, eventType)
      if (!res.success) setNotice(res.error ?? "Could not mark that change reviewed")
      await load()
    })
  }

  const populated = enrichment
    ? FIELD_LABELS.filter(([k]) => enrichment[k] !== null && enrichment[k] !== undefined && enrichment[k] !== "")
    : []
  const socials = enrichment ? SOCIAL_FIELDS.filter(([k]) => Boolean(enrichment[k])) : []

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Enrichment & life changes
            </CardTitle>
            <CardDescription className="text-xs">
              {lastEnriched
                ? `Last enriched ${new Date(lastEnriched).toLocaleString()}`
                : "Never enriched"}
              {enrichment?.confidence_score != null && ` · confidence ${enrichment.confidence_score}`}
              {enrichment?.data_source && ` · ${enrichment.data_source}`}
            </CardDescription>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button size="sm" variant="outline" onClick={runLifeCheck} disabled={isPending}>
              {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              <span className="ml-1">Check for changes</span>
            </Button>
            <Button size="sm" onClick={runEnrich} disabled={isPending}>
              {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              <span className="ml-1">{lastEnriched ? "Re-enrich" : "Enrich now"}</span>
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {notice && (
          <p className="text-xs rounded border bg-muted/40 px-2 py-1.5 text-muted-foreground">{notice}</p>
        )}

        {loading ? (
          <p className="text-xs text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading enrichment…
          </p>
        ) : (
          <>
            {populated.length === 0 && socials.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No enrichment data on this contact yet.
              </p>
            )}

            {populated.length > 0 && (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                {populated.map(([key, label]) => (
                  <div key={key} className="contents">
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="text-xs font-medium">{String(enrichment?.[key])}</dd>
                  </div>
                ))}
              </dl>
            )}

            {socials.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {socials.map(([key, label]) => (
                  <a
                    key={key}
                    href={String(enrichment?.[key])}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs underline underline-offset-2"
                  >
                    {label}
                  </a>
                ))}
              </div>
            )}

            <div>
              <p className="text-xs font-medium mb-1.5 flex items-center gap-1.5">
                <ShieldCheck className="h-3 w-3" />
                Detected life changes
              </p>
              {lifeChanges.length === 0 ? (
                <p className="text-xs text-muted-foreground">None detected.</p>
              ) : (
                <ul className="space-y-1.5">
                  {lifeChanges.map((e, i) => (
                    <li
                      key={`${e.type ?? "event"}-${i}`}
                      className="flex items-center justify-between gap-2 rounded border px-2 py-1.5"
                    >
                      <span className="text-xs">
                        <span className="font-medium">{e.type ?? "unknown"}</span>
                        {e.detected_at && (
                          <span className="text-muted-foreground">
                            {" "}· {new Date(e.detected_at).toLocaleDateString()}
                          </span>
                        )}
                        {e.details && <span className="text-muted-foreground"> · {e.details}</span>}
                      </span>
                      {e.notified_at ? (
                        <Badge variant="secondary" className="text-[10px] shrink-0">
                          <Check className="h-3 w-3 mr-0.5" /> reviewed
                        </Badge>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-[11px] shrink-0"
                          disabled={isPending || !e.type}
                          onClick={() => e.type && markReviewed(e.type)}
                        >
                          Mark reviewed
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
