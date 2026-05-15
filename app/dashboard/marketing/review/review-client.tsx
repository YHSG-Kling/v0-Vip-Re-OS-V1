"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Mail,
  MessageSquare,
  Share2,
  Camera,
  Video as VideoIcon,
  QrCode,
  ArrowRight,
  X,
  Check,
  Sparkles,
} from "lucide-react"
import {
  dismissDraft,
  cancelSocialPost,
  type MarketingReviewSnapshot,
} from "./actions"
import {
  approveListingMedia,
  rejectListingMedia,
} from "@/app/actions/listing-media"

interface Props {
  snapshot: MarketingReviewSnapshot
  role:     string
}

const TRIGGER_LABEL: Record<string, string> = {
  "video.generated": "from a video render",
  "image.generated": "from an image render",
}

export function MarketingReviewClient({ snapshot, role }: Props) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [data, setData] = useState(snapshot)

  function refresh() {
    router.refresh()
  }

  async function handleDismissDraft(draftId: string) {
    setBusyId(draftId)
    startTransition(async () => {
      const r = await dismissDraft(draftId)
      if (r.success) {
        toast.success("Draft dismissed")
        setData(d => ({ ...d, drafts: d.drafts.filter(x => x.id !== draftId) }))
      } else {
        toast.error(r.error ?? "Failed to dismiss")
      }
      setBusyId(null)
      refresh()
    })
  }

  async function handleCancelPost(postId: string) {
    setBusyId(postId)
    startTransition(async () => {
      const r = await cancelSocialPost(postId)
      if (r.success) {
        toast.success("Social post cancelled")
        setData(d => ({ ...d, socialPosts: d.socialPosts.filter(x => x.id !== postId) }))
      } else {
        toast.error(r.error ?? "Failed to cancel")
      }
      setBusyId(null)
      refresh()
    })
  }

  async function handleApproveMedia(id: string) {
    setBusyId(id)
    startTransition(async () => {
      const r = await approveListingMedia(id)
      if (r.success) {
        toast.success("Listing media approved and now visible on the landing page")
        setData(d => ({ ...d, pendingMedia: d.pendingMedia.filter(x => x.id !== id) }))
      } else {
        toast.error(r.error ?? "Failed to approve")
      }
      setBusyId(null)
      refresh()
    })
  }

  async function handleRejectMedia(id: string) {
    const notes = window.prompt("Why are you rejecting this? (optional)") ?? ""
    setBusyId(id)
    startTransition(async () => {
      const r = await rejectListingMedia(id, notes)
      if (r.success) {
        toast.success("Listing media rejected")
        setData(d => ({ ...d, pendingMedia: d.pendingMedia.filter(x => x.id !== id) }))
      } else {
        toast.error(r.error ?? "Failed to reject")
      }
      setBusyId(null)
      refresh()
    })
  }

  const totalCount =
    data.drafts.length +
    data.socialPosts.length +
    data.pendingMedia.length +
    data.recentQrCodes.length

  return (
    <div className="container max-w-6xl mx-auto py-8 px-4">
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="h-5 w-5 text-indigo-600" />
          <h1 className="text-2xl font-semibold tracking-tight">Marketing Review</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Everything the AI auto-drafted from your recent videos, images, and listings — in one place.
          {role !== "agent" && <span> · Showing the full brokerage scope.</span>}
        </p>
        <div className="mt-3 inline-flex items-center gap-2 text-xs">
          <Badge variant="secondary">{totalCount} item{totalCount === 1 ? "" : "s"} waiting</Badge>
        </div>
      </div>

      {totalCount === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Nothing to review right now. When the AI finishes a video, image, or listing render,
            the drafts and posts it prepares will land here.
          </CardContent>
        </Card>
      )}

      {/* AI Message Drafts (email + SMS) */}
      {data.drafts.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Mail className="h-4 w-4 text-blue-600" />
            Personal message drafts ({data.drafts.length})
          </h2>
          <div className="grid gap-3">
            {data.drafts.map(d => (
              <Card key={d.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      {d.channel === "sms" ? (
                        <MessageSquare className="h-4 w-4 text-emerald-600" />
                      ) : (
                        <Mail className="h-4 w-4 text-blue-600" />
                      )}
                      {d.contact_name ?? "(no contact name)"}
                      <Badge variant="outline" className="text-[10px] uppercase">{d.channel}</Badge>
                    </CardTitle>
                    <span className="text-xs text-muted-foreground">
                      {d.trigger_event ? TRIGGER_LABEL[d.trigger_event] ?? d.trigger_event : ""}
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {d.draft_subject && (
                    <p className="text-xs"><span className="font-medium">Subject:</span> {d.draft_subject}</p>
                  )}
                  <p className="text-sm text-foreground/90 whitespace-pre-wrap line-clamp-4">{d.draft_body}</p>
                  <div className="flex gap-2 items-center">
                    {d.contact_id && (
                      <Button asChild size="sm" variant="default">
                        <Link href={`/crm/contacts/${d.contact_id}`}>
                          Open contact <ArrowRight className="h-3 w-3 ml-1" />
                        </Link>
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleDismissDraft(d.id)}
                      disabled={busyId === d.id || pending}
                    >
                      <X className="h-3 w-3 mr-1" /> Dismiss
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Auto-drafted social posts */}
      {data.socialPosts.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Share2 className="h-4 w-4 text-pink-600" />
            Auto-drafted social posts ({data.socialPosts.length})
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {data.socialPosts.map(p => (
              <Card key={p.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-medium capitalize">{p.platform}</CardTitle>
                    <Badge variant="outline" className="text-[10px]">{p.status}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {p.media_urls?.[0] && (
                    <div className="aspect-video bg-muted rounded overflow-hidden">
                      {/\.(mp4|webm|mov)$/i.test(p.media_urls[0]) ? (
                        <video src={p.media_urls[0]} controls className="w-full h-full object-cover" />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.media_urls[0]} alt="" className="w-full h-full object-cover" />
                      )}
                    </div>
                  )}
                  <p className="text-sm text-foreground/90 line-clamp-3">{p.content ?? ""}</p>
                  <div className="flex gap-2">
                    <Button asChild size="sm" variant="default">
                      <Link href="/social-planner">
                        Open in Social Planner <ArrowRight className="h-3 w-3 ml-1" />
                      </Link>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleCancelPost(p.id)}
                      disabled={busyId === p.id || pending}
                    >
                      <X className="h-3 w-3 mr-1" /> Cancel
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Listing media awaiting approval */}
      {data.pendingMedia.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <VideoIcon className="h-4 w-4 text-purple-600" />
            Listing media awaiting approval ({data.pendingMedia.length})
          </h2>
          <p className="text-xs text-muted-foreground mb-3">
            These will appear on the public listing landing page once approved.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.pendingMedia.map(m => (
              <Card key={m.id}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-medium flex items-center gap-2 truncate">
                    {m.media_type === "video" ? <VideoIcon className="h-3 w-3" /> : <Camera className="h-3 w-3" />}
                    <span className="truncate">{m.listing_label ?? "Listing"}</span>
                    <Badge variant="outline" className="text-[10px]">{m.media_type}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="aspect-video bg-muted rounded overflow-hidden">
                    {m.media_type === "video" ? (
                      <video src={m.file_url} poster={m.thumbnail_url ?? undefined} controls className="w-full h-full object-cover" />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={m.file_url} alt="" className="w-full h-full object-cover" />
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() => handleApproveMedia(m.id)}
                      disabled={busyId === m.id || pending}
                    >
                      <Check className="h-3 w-3 mr-1" /> Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleRejectMedia(m.id)}
                      disabled={busyId === m.id || pending}
                    >
                      <X className="h-3 w-3 mr-1" /> Reject
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* QR codes minted in the last 7 days */}
      {data.recentQrCodes.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <QrCode className="h-4 w-4 text-amber-600" />
            QR codes minted recently ({data.recentQrCodes.length})
          </h2>
          <p className="text-xs text-muted-foreground mb-3">
            Print these for yard signs, flyers, postcards, and brochures.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.recentQrCodes.map(q => (
              <Card key={q.id}>
                <CardContent className="py-4">
                  <div className="flex items-start gap-3">
                    <div className="bg-muted rounded p-2 flex-shrink-0">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(q.target_url)}`}
                        alt={`QR for ${q.label}`}
                        className="w-20 h-20"
                      />
                    </div>
                    <div className="flex-1 min-w-0 space-y-1">
                      <p className="text-sm font-medium truncate">{q.label}</p>
                      <p className="text-xs text-muted-foreground capitalize">{q.purpose}</p>
                      <p className="text-xs text-muted-foreground">{q.scan_count} scan{q.scan_count === 1 ? "" : "s"}</p>
                      <Button asChild size="sm" variant="outline" className="mt-2">
                        <Link href="/dashboard/agent/qr-codes">
                          Manage <ArrowRight className="h-3 w-3 ml-1" />
                        </Link>
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
