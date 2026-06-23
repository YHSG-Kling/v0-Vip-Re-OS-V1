"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Radar, Loader2 } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { scrapeSocialMedia } from "@/app/actions/scrape-social-media"

/**
 * Data-Steward control to run a social-media scrape (Facebook groups + Reddit) for a target
 * city/state. The action is admin-gated server-side and feeds raw_scraped_leads through the
 * same pipeline the review panel below promotes — so anything found lands on the bench here.
 */
export function SocialScrapeTrigger() {
  const { toast } = useToast()
  const router = useRouter()
  const [city, setCity] = useState("")
  const [state, setState] = useState("")
  const [busy, setBusy] = useState(false)

  async function run() {
    const targetCity = city.trim()
    const targetState = state.trim()
    if (!targetCity || !targetState) {
      toast({ title: "Enter a target city and state", variant: "destructive" })
      return
    }
    setBusy(true)
    try {
      const r = await scrapeSocialMedia({ targetCity, targetState })
      if (r.success && "facebookPosts" in r) {
        toast({
          title: "Scrape complete",
          description: `${r.facebookPosts} FB + ${r.redditPosts} Reddit posts · ${r.leadsCreated} raw lead(s) landed · ~$${r.totalCost.toFixed(2)}`,
        })
        router.refresh()
      } else {
        toast({ title: "Scrape blocked", description: "error" in r ? r.error : "Scrape failed", variant: "destructive" })
      }
    } catch (err) {
      toast({ title: "Scrape failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2"><Radar className="h-4 w-4" />Run a Social-Media Scrape</CardTitle>
        <CardDescription>
          Sweep local Facebook groups + Reddit for seller/buyer intent in a target market. Found posts are
          enriched and land below as raw leads for review. Admin-only — burns AI + scraper credits.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="scrape-city">City</Label>
            <Input id="scrape-city" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Austin" className="w-44" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="scrape-state">State</Label>
            <Input id="scrape-state" value={state} onChange={(e) => setState(e.target.value)} placeholder="TX" className="w-28" />
          </div>
          <Button onClick={run} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Radar className="h-4 w-4 mr-1" />}
            {busy ? "Scraping…" : "Scrape now"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
