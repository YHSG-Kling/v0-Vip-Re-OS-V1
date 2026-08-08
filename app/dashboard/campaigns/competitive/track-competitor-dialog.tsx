"use client"

// Track a competitor ad / post you spotted — the MANUAL ingest door.
//
// WHY THIS EXISTS (w4s1): `ingestCompetitorAd` and `ingestCompetitorPost` in
// lib/ads/ad-monitor.ts had no caller. For ADS that was survivable — the Exa cron
// (/api/cron/competitor-ads-exa) writes competitor_ads automatically. For POSTS it
// was not: `competitor_posts` had NO writer anywhere in the tree, so the Posts tab
// was structurally empty forever and its empty state ("posts will appear here once
// they are ingested from your monitoring sources") described sources that do not
// exist. The agent who actually sees a rival's listing post on Instagram had nowhere
// to put it.
//
// Both actions resolve the tenant from the session and enforce the
// `competitor_monitor` entitlement, so this form sends no identity. The platform
// options come from the exported vocabularies, which are pinned to the LIVE CHECK
// constraints — the two tables do NOT accept the same set.

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Loader2 } from "lucide-react"
import {
  ingestCompetitorAd,
  ingestCompetitorPost,
  COMPETITOR_AD_PLATFORMS,
  COMPETITOR_POST_PLATFORMS,
  type CompetitorAdPlatform,
  type CompetitorPostPlatform,
} from "@/lib/ads/ad-monitor"

export function TrackCompetitorDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [competitorName, setCompetitorName] = useState("")

  // Ad fields
  const [adPlatform, setAdPlatform] = useState<CompetitorAdPlatform>("facebook")
  const [adHeadline, setAdHeadline] = useState("")
  const [adCopy, setAdCopy] = useState("")
  const [adLanding, setAdLanding] = useState("")

  // Post fields
  const [postPlatform, setPostPlatform] = useState<CompetitorPostPlatform>("instagram")
  const [postCaption, setPostCaption] = useState("")
  const [postUrl, setPostUrl] = useState("")

  function reset() {
    setCompetitorName("")
    setAdHeadline(""); setAdCopy(""); setAdLanding("")
    setPostCaption(""); setPostUrl("")
    setError(null)
  }

  function submitAd() {
    setError(null); setNotice(null)
    if (!competitorName.trim()) { setError("Name the competitor."); return }
    if (!adHeadline.trim()) { setError("The ad headline is what de-duplicates this ad — it is required."); return }
    if (!adCopy.trim()) { setError("Paste the ad copy."); return }
    startTransition(async () => {
      const res = await ingestCompetitorAd({
        sourcePlatform: adPlatform,
        competitorName: competitorName.trim(),
        adHeadline: adHeadline.trim(),
        adCopy: adCopy.trim(),
        landingPageUrl: adLanding.trim() || undefined,
      })
      if (!res.success) { setError(res.error ?? "The ad could not be saved"); return }
      // The action upserts on (brokerage, platform, headline) — re-adding a seen ad
      // refreshes last_seen_at rather than duplicating it.
      setNotice("Competitor ad tracked.")
      reset()
      router.refresh()
    })
  }

  function submitPost() {
    setError(null); setNotice(null)
    if (!competitorName.trim()) { setError("Name the competitor."); return }
    if (!postCaption.trim()) { setError("Paste the post caption — it is what the AI insights read."); return }
    startTransition(async () => {
      const res = await ingestCompetitorPost({
        sourcePlatform: postPlatform,
        competitorName: competitorName.trim(),
        postCaption: postCaption.trim(),
        postUrl: postUrl.trim() || undefined,
      })
      if (!res.success) { setError(res.error ?? "The post could not be saved"); return }
      setNotice("Competitor post tracked.")
      reset()
      router.refresh()
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Track a competitor</DialogTitle>
          <DialogDescription>
            Saw a rival&apos;s ad or post? Add it here and it joins the monitor — and
            the AI insight run that reads across everything you are tracking.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
        )}
        {notice && (
          <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">{notice}</p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="competitor-name">Competitor</Label>
          <Input
            id="competitor-name"
            value={competitorName}
            onChange={(e) => setCompetitorName(e.target.value)}
            placeholder="e.g. Harbor & Oak Realty"
          />
        </div>

        <Tabs defaultValue="ad" className="mt-2">
          <TabsList className="w-full">
            <TabsTrigger value="ad" className="flex-1">Paid ad</TabsTrigger>
            <TabsTrigger value="post" className="flex-1">Organic post</TabsTrigger>
          </TabsList>

          <TabsContent value="ad" className="space-y-3 pt-3">
            <div className="space-y-1.5">
              <Label>Platform</Label>
              <Select value={adPlatform} onValueChange={(v) => setAdPlatform(v as CompetitorAdPlatform)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COMPETITOR_AD_PLATFORMS.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ad-headline">Headline</Label>
              <Input id="ad-headline" value={adHeadline} onChange={(e) => setAdHeadline(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ad-copy">Ad copy</Label>
              <Textarea id="ad-copy" rows={4} value={adCopy} onChange={(e) => setAdCopy(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ad-landing">Landing page URL (optional)</Label>
              <Input id="ad-landing" value={adLanding} onChange={(e) => setAdLanding(e.target.value)} placeholder="https://" />
            </div>
            <DialogFooter>
              <Button onClick={submitAd} disabled={pending}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Track ad
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="post" className="space-y-3 pt-3">
            <div className="space-y-1.5">
              <Label>Platform</Label>
              <Select value={postPlatform} onValueChange={(v) => setPostPlatform(v as CompetitorPostPlatform)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COMPETITOR_POST_PLATFORMS.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="post-caption">Caption</Label>
              <Textarea id="post-caption" rows={4} value={postCaption} onChange={(e) => setPostCaption(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="post-url">Post URL (optional)</Label>
              <Input id="post-url" value={postUrl} onChange={(e) => setPostUrl(e.target.value)} placeholder="https://" />
            </div>
            <DialogFooter>
              <Button onClick={submitPost} disabled={pending}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Track post
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
