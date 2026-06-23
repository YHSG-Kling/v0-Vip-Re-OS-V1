"use client"

import { useState, useTransition } from "react"
import { publishGuideToGbpAction } from "@/app/actions/marketing/publish-guide-to-gbp"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { Building2, ShieldCheck } from "lucide-react"

// Mirror of the magnet types the action understands (lib/marketing/lead-magnet-copy MagnetType).
// open_house / generic_form ship no guide, so they're excluded from the picker.
const GUIDE_MAGNETS: Array<{ value: string; label: string }> = [
  { value: "home_valuation", label: "Home Valuation" },
  { value: "buyer_guide", label: "Buyer Guide" },
  { value: "seller_guide", label: "Seller Guide" },
  { value: "market_report", label: "Market Report" },
  { value: "listing_alert", label: "Listing Alert" },
]

interface Props {
  /** the selected magnet's type, used to pre-select the picker. */
  defaultMagnetType?: string
  /** the magnet's public landing URL slug, used to pre-fill the CTA link. */
  magnetSlug?: string
}

export function PublishGuideToGbp({ defaultMagnetType, magnetSlug }: Props) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()

  const initialType = GUIDE_MAGNETS.some((m) => m.value === defaultMagnetType)
    ? (defaultMagnetType as string)
    : "buyer_guide"

  const [magnetType, setMagnetType] = useState(initialType)
  const [area, setArea] = useState("")
  const [brand, setBrand] = useState("")
  const [landingUrl, setLandingUrl] = useState(
    magnetSlug && typeof window !== "undefined" ? `${window.location.origin}/lm/${magnetSlug}` : ""
  )

  function handlePublish() {
    startTransition(async () => {
      const result = await publishGuideToGbpAction({
        magnetType,
        area: area.trim() || null,
        brand: brand.trim() || null,
        landingUrl: landingUrl.trim() || null,
      })
      if (result.success) {
        toast({
          title: "Queued for approval",
          description:
            "Your guide was sent to the Command Center Social approval queue. It will publish to Google Business Profile only after a human approves it.",
        })
      } else {
        toast({
          title: "Could not queue",
          description: result.error ?? "Failed to queue the guide for Google Business Profile.",
          variant: "destructive",
        })
      }
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="h-5 w-5 text-primary" />
          Publish to Google Business Profile
        </CardTitle>
        <CardDescription>
          Turn this guide into a Google Business Profile post so your profile answers what local buyers
          and sellers are asking. The post is built from real demand topics and is approval-gated.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="gbp-magnet-type">Guide</Label>
          <Select value={magnetType} onValueChange={setMagnetType}>
            <SelectTrigger id="gbp-magnet-type">
              <SelectValue placeholder="Choose a guide" />
            </SelectTrigger>
            <SelectContent>
              {GUIDE_MAGNETS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="gbp-area">Area (optional)</Label>
            <Input
              id="gbp-area"
              placeholder="e.g. Austin, TX"
              value={area}
              onChange={(e) => setArea(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="gbp-brand">Brand (optional)</Label>
            <Input
              id="gbp-brand"
              placeholder="Your team or brokerage name"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="gbp-landing">Guide link (optional)</Label>
          <Input
            id="gbp-landing"
            placeholder="https://…/lm/your-guide"
            value={landingUrl}
            onChange={(e) => setLandingUrl(e.target.value)}
          />
        </div>

        <div className="flex items-start gap-2 rounded-md border border-muted bg-muted/30 p-3 text-xs text-muted-foreground">
          <ShieldCheck className="h-4 w-4 shrink-0 text-primary mt-0.5" />
          <span>
            Approval-gated: this never auto-publishes. The post lands in the Command Center Social
            approval queue and goes live only after a human approves it.
          </span>
        </div>

        <Button onClick={handlePublish} disabled={isPending} className="w-full sm:w-auto">
          {isPending ? "Queuing…" : "Queue for approval"}
        </Button>
      </CardContent>
    </Card>
  )
}
