"use client"

/**
 * PERSONALIZATION PREVIEW — the engine that had never personalized anything.
 *
 * `app/actions/ai-newsletter.ts:aiPersonalizeNewsletter` takes a campaign and one
 * contact and returns the greeting, the custom opening, the listings most worth
 * showing that person, and a tailored call to action — grounded in that contact's
 * real activity log and their saved property alerts.
 *
 * It had no caller anywhere. Worse, before an earlier repair its contact read
 * embedded two tables that DO NOT EXIST (`interactions`, `saved_searches`);
 * PostgREST rejects the whole query on an unknown relation, so the read failed
 * every single time and the action bailed out with "Contact or newsletter not
 * found". Between the broken read and the missing caller, this had never
 * personalized a newsletter for anyone.
 *
 * WHY A PREVIEW AND NOT AN AUTO-SEND: the action RETURNS a personalization and
 * persists nothing, and `sendNewsletter` mails one campaign body to the whole
 * list. Wiring this into the send path would mean either inventing a storage
 * shape for per-recipient copy or quietly changing what "send" does. Neither is
 * this pass's call. What the agent gets here is the real answer for a real
 * contact, which is what they can act on today.
 */

import { useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Sparkles, Loader2, Copy, Check } from "lucide-react"
import { aiPersonalizeNewsletter } from "@/app/actions/ai-newsletter"

interface CampaignOption {
  id: string
  label: string
}

interface ContactOption {
  id: string
  name: string
}

interface Personalization {
  greeting: string
  customIntro: string
  recommendedListings: string[]
  customCta: { text: string; url: string }
  dynamicContent: Record<string, string>
}

export function PersonalizePreviewPanel({
  campaigns,
  contacts,
}: {
  campaigns: CampaignOption[]
  contacts: ContactOption[]
}) {
  const [campaignId, setCampaignId] = useState("")
  const [contactId, setContactId] = useState("")
  const [result, setResult] = useState<Personalization | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [isPending, startTransition] = useTransition()

  const run = () => {
    setError(null)
    setResult(null)
    startTransition(async () => {
      const res = await aiPersonalizeNewsletter({ newsletterId: campaignId, contactId })
      if (!res.success) {
        // "Forbidden" for a campaign in another brokerage, a named read failure,
        // or a genuinely missing record — all different, all reported.
        setError((res as { error?: string }).error ?? "Could not personalize this newsletter.")
        return
      }
      setResult((res as any).personalization as Personalization)
    })
  }

  const copyAll = async () => {
    if (!result) return
    await navigator.clipboard.writeText(
      `${result.greeting}\n\n${result.customIntro}\n\n${result.customCta?.text ?? ""}`,
    )
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4" />
          Personalize for one contact
        </CardTitle>
        <CardDescription>
          How a campaign reads for a specific person, using their activity and saved searches.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {campaigns.length === 0 || contacts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {campaigns.length === 0
              ? "Create a newsletter campaign first."
              : "No contacts with an email address are available."}
          </p>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <Label className="text-[11px]">Campaign</Label>
                <Select value={campaignId} onValueChange={setCampaignId}>
                  <SelectTrigger className="mt-1 h-8 text-xs">
                    <SelectValue placeholder="Pick a campaign" />
                  </SelectTrigger>
                  <SelectContent>
                    {campaigns.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-[11px]">Contact</Label>
                <Select value={contactId} onValueChange={setContactId}>
                  <SelectTrigger className="mt-1 h-8 text-xs">
                    <SelectValue placeholder="Pick a contact" />
                  </SelectTrigger>
                  <SelectContent>
                    {contacts.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Button size="sm" onClick={run} disabled={isPending || !campaignId || !contactId}>
              {isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Preview
            </Button>

            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {error}
              </div>
            )}

            {result && (
              <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium">{result.greeting}</p>
                  <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2" onClick={copyAll}>
                    {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  </Button>
                </div>
                <p className="whitespace-pre-wrap text-muted-foreground">{result.customIntro}</p>
                {result.customCta?.text && (
                  <p>
                    <span className="font-medium">Call to action: </span>
                    {result.customCta.text}
                  </p>
                )}
                {result.recommendedListings?.length > 0 && (
                  <p className="text-muted-foreground">
                    Suggested listings: {result.recommendedListings.join(", ")} — these are the
                    model's suggestions from this contact's saved searches, not verified matches
                    against your inventory.
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  A draft for you to use, not a scheduled send. Nothing here has been saved to the campaign.
                </p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
