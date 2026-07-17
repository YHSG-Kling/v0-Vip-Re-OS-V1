"use client"

import { useEffect, useState, useTransition } from "react"
import { useParams } from "next/navigation"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import {
  Share2, QrCode, Copy, Check, ExternalLink, Send,
  Instagram, Linkedin, Facebook, Twitter, MessageSquare,
  Loader2, Home, Sparkles,
} from "lucide-react"
import { pushListingToSellerPortal } from "@/app/actions/push-listing-to-seller-portal"
import { toast } from "sonner"
import Image from "next/image"

// Use the qrcode npm package to generate a QR code data URL on the client
// (avoids server-side canvas dependency issues with qrcode).
import QRCode from "qrcode"

interface QrRecord {
  id: string
  slug: string
  target_url: string
  scan_count: number
  lead_count: number
}

interface Listing {
  id: string
  address: string | null
  city: string | null
  state: string | null
  list_price: number | null
  status: string | null
  slug: string | null
  brokerage_id: string
  contact_id: string | null
}

interface MarketingContentRow {
  id: string
  content_type: string
  content: unknown
  created_at: string | null
}

// Flatten a listing_marketing_content jsonb blob into copyable text pieces.
// Writers persist objects of strings (ai_marketing, ai_descriptions), arrays,
// or plain strings depending on content_type.
function contentPieces(content: unknown): Array<{ label: string; text: string }> {
  const toText = (v: unknown): string => {
    if (typeof v === "string") return v
    if (Array.isArray(v)) return v.map(toText).join("\n")
    if (v != null && typeof v === "object") return JSON.stringify(v, null, 2)
    return String(v ?? "")
  }
  if (content == null) return []
  if (typeof content === "string") return [{ label: "", text: content }]
  if (Array.isArray(content)) {
    return content.map((item, i) => ({ label: `#${i + 1}`, text: toText(item) }))
  }
  if (typeof content === "object") {
    return Object.entries(content as Record<string, unknown>).map(([key, value]) => ({
      label: key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " "),
      text: toText(value),
    }))
  }
  return [{ label: "", text: toText(content) }]
}

export default function ListingSharePage() {
  const { id: listingId } = useParams<{ id: string }>()
  const [listing, setListing] = useState<Listing | null>(null)
  const [qrRecord, setQrRecord] = useState<QrRecord | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [agentMessage, setAgentMessage] = useState("")
  const [isPushing, startPushing] = useTransition()
  const [userId, setUserId] = useState<string | null>(null)
  const [marketingContent, setMarketingContent] = useState<MarketingContentRow[]>([])

  useEffect(() => {
    const supabase = createClient()

    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      setUserId(user?.id ?? null)

      const { data: l } = await supabase
        .from("listings")
        .select("id, address, city, state, list_price, status, slug, brokerage_id, contact_id")
        .eq("id", listingId)
        .maybeSingle()

      if (!l) return
      setListing(l as Listing)

      // Fetch the auto-generated QR code for this listing
      const { data: qr } = await supabase
        .from("qr_codes")
        .select("id, slug, target_url, scan_count, lead_count")
        .eq("listing_id", listingId)
        .eq("purpose", "listing_inquiry")
        .maybeSingle()

      if (qr) {
        setQrRecord(qr as QrRecord)
        // Generate QR image client-side using the stored target_url
        const dataUrl = await QRCode.toDataURL(qr.target_url, {
          width: 300,
          margin: 2,
          color: { dark: "#1e293b", light: "#ffffff" },
        })
        setQrDataUrl(dataUrl)
      }

      // AI-generated marketing pieces for this listing (listing_marketing_content)
      const { data: marketing } = await supabase
        .from("listing_marketing_content")
        .select("id, content_type, content, created_at")
        .eq("listing_id", listingId)
        .order("created_at", { ascending: false })

      setMarketingContent((marketing as MarketingContentRow[] | null) ?? [])
    }

    load()
  }, [listingId])

  if (!listing) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""
  const publicUrl = listing.slug
    ? `${appUrl}/listing/${listing.slug}`
    : qrRecord?.target_url ?? `${appUrl}/listings/${listingId}`

  const fullAddress = [listing.address, listing.city, listing.state].filter(Boolean).join(", ")
  const priceLabel = listing.list_price
    ? `$${listing.list_price.toLocaleString()}`
    : "Price not set"

  function copyLink() {
    navigator.clipboard.writeText(publicUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function downloadQR() {
    if (!qrDataUrl) return
    const a = document.createElement("a")
    a.href = qrDataUrl
    a.download = `listing-qr-${listing!.slug ?? listingId}.png`
    a.click()
  }

  const socialCopy = {
    facebook: `🏡 Just listed: ${fullAddress} — ${priceLabel}. Check it out: ${publicUrl}`,
    instagram: `🏡 ${fullAddress} is now on the market for ${priceLabel}!\n\nSwipe to see all the details. DM me to schedule a showing. 🔑\n\n#JustListed #RealEstate #HomesForSale`,
    linkedin: `New listing: ${fullAddress} — Listed at ${priceLabel}. View details and request a showing: ${publicUrl}`,
    twitter: `🏡 New listing! ${fullAddress} — ${priceLabel}. Details here: ${publicUrl}`,
    nextdoor: `New listing in our neighborhood: ${fullAddress} at ${priceLabel}. Great opportunity! ${publicUrl}`,
    imessage: `Hi! I thought you might be interested in this home: ${fullAddress} — ${priceLabel}. Take a look: ${publicUrl}`,
  }

  const platformIcons = {
    facebook: { icon: Facebook, label: "Facebook", color: "text-blue-600" },
    instagram: { icon: Instagram, label: "Instagram", color: "text-pink-600" },
    linkedin: { icon: Linkedin, label: "LinkedIn", color: "text-blue-700" },
    twitter: { icon: Twitter, label: "X / Twitter", color: "text-slate-800" },
    nextdoor: { icon: Home, label: "Nextdoor", color: "text-green-600" },
    imessage: { icon: MessageSquare, label: "iMessage", color: "text-blue-500" },
  }

  function handlePushToSeller() {
    if (!userId || !listing) return
    startPushing(async () => {
      const res = await pushListingToSellerPortal({
        listingId: listing.id,
        brokerageId: listing.brokerage_id,
        userId,
        message: agentMessage || undefined,
      })
      if (res.success) {
        toast.success("Pushed to seller's portal — they can now share it on social media.")
      } else {
        toast.error(res.error ?? "Push failed")
      }
    })
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Public Page & Sharing</h1>
          <p className="text-sm text-muted-foreground">{fullAddress} · {priceLabel}</p>
        </div>
        <Badge variant={listing.status === "active" ? "default" : "secondary"}>
          {listing.status ?? "unknown"}
        </Badge>
      </div>

      {/* Public URL */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <ExternalLink className="h-4 w-4" />
            Public Listing Page
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input value={publicUrl} readOnly className="text-xs font-mono" />
            <Button variant="outline" size="icon" onClick={copyLink}>
              {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
            </Button>
            <Button variant="outline" size="icon" asChild>
              <a href={publicUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          </div>
          {qrRecord && (
            <p className="text-xs text-muted-foreground">
              {qrRecord.scan_count} QR scans · {qrRecord.lead_count} leads captured
            </p>
          )}
        </CardContent>
      </Card>

      {/* QR Code */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <QrCode className="h-4 w-4" />
            QR Code
          </CardTitle>
        </CardHeader>
        <CardContent>
          {qrDataUrl ? (
            <div className="flex flex-col items-center gap-4">
              <div className="border rounded-lg p-3 bg-white">
                <Image src={qrDataUrl} alt="Listing QR Code" width={200} height={200} unoptimized />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={downloadQR}>
                  Download PNG
                </Button>
                <Button variant="outline" size="sm" onClick={copyLink}>
                  {copied ? "Copied!" : "Copy Link"}
                </Button>
              </div>
              <p className="text-xs text-center text-muted-foreground max-w-xs">
                Print on flyers, postcards, and open house signs. Scans are tracked per campaign source.
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">
              QR code generates automatically when the listing is published.
              {!listing.slug && " Publish the listing to generate its QR code."}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Push to Seller Portal */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Send className="h-4 w-4" />
            Push to Seller Portal
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Send ready-to-share social media posts directly to the seller's portal.
            They'll see platform-specific captions and can share with one tap on each channel.
          </p>
          <Textarea
            placeholder="Optional message to seller (e.g. 'Share this with your network, it really helps!')"
            value={agentMessage}
            onChange={(e) => setAgentMessage(e.target.value)}
            rows={2}
            className="text-sm"
          />
          <Button
            onClick={handlePushToSeller}
            disabled={isPushing || !listing.contact_id}
            className="w-full"
          >
            {isPushing ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Pushing…</>
            ) : (
              <><Send className="h-4 w-4 mr-2" />Push Social Posts to Seller</>
            )}
          </Button>
          {!listing.contact_id && (
            <p className="text-xs text-destructive">
              No seller contact linked to this listing.
            </p>
          )}
        </CardContent>
      </Card>

      <Separator />

      {/* Social Sharing Copy */}
      <div>
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Share2 className="h-4 w-4" />
          Agent Sharing Copy
        </h2>
        <div className="space-y-3">
          {(Object.entries(socialCopy) as [keyof typeof socialCopy, string][]).map(([platform, copy]) => {
            const { icon: Icon, label, color } = platformIcons[platform]
            return (
              <Card key={platform} className="border-dashed">
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className={`flex items-center gap-1.5 text-xs font-medium ${color}`}>
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs"
                      onClick={() => {
                        navigator.clipboard.writeText(copy)
                        toast.success(`${label} copy copied!`)
                      }}
                    >
                      <Copy className="h-3 w-3 mr-1" />
                      Copy
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap">{copy}</p>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>

      {/* Generated Marketing — AI content persisted to listing_marketing_content */}
      {marketingContent.length > 0 && (
        <>
          <Separator />
          <div>
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              Generated Marketing
            </h2>
            <div className="space-y-3">
              {marketingContent.map((row) => {
                const pieces = contentPieces(row.content)
                if (pieces.length === 0) return null
                return (
                  <Card key={row.id} className="border-dashed">
                    <CardContent className="p-3 space-y-3">
                      <div className="flex items-center justify-between">
                        <Badge variant="outline" className="text-xs capitalize">
                          {row.content_type.replace(/_/g, " ")}
                        </Badge>
                        {row.created_at && (
                          <span className="text-xs text-muted-foreground">
                            {new Date(row.created_at).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                      {pieces.map((piece, i) => (
                        <div key={i} className="space-y-1">
                          <div className="flex items-center justify-between">
                            {piece.label && (
                              <span className="text-xs font-medium capitalize">{piece.label}</span>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 text-xs ml-auto"
                              onClick={() => {
                                navigator.clipboard.writeText(piece.text)
                                toast.success(`${piece.label || row.content_type.replace(/_/g, " ")} copied!`)
                              }}
                            >
                              <Copy className="h-3 w-3 mr-1" />
                              Copy
                            </Button>
                          </div>
                          <p className="text-xs text-muted-foreground whitespace-pre-wrap">{piece.text}</p>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
