"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Mail, MessageSquare, Users, CheckCircle, Clock, Send } from "lucide-react"
import { inviteFarmContacts } from "@/app/actions/seller-open-house"
import { useToast } from "@/hooks/use-toast"

interface Props {
  listingId: string
  data: any
  onRefresh: (d: any) => void
}

const POST_TYPE_LABELS: Record<string, string> = {
  open_house_announcement: "Open House Announcement",
  open_house_reminder: "Open House Reminder",
  coming_soon: "Coming Soon",
}

const STATUS_COLORS: Record<string, string> = {
  published: "bg-green-100 text-green-800 border-green-200",
  scheduled: "bg-blue-100 text-blue-800 border-blue-200",
  draft: "bg-muted text-muted-foreground border-border",
}

export function MarketingTab({ listingId, data, onRefresh }: Props) {
  const [channel, setChannel] = useState<"email" | "sms" | "both">("email")
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const { listing, socialPosts, events, invitations } = data

  // Pick the upcoming event for invitations
  const upcomingEvent = events.find((e: any) => e.status === "scheduled") ?? events[0]

  // RSVP tallies
  const rsvpYes = invitations.filter((i: any) => i.rsvp_response === "yes").length
  const rsvpMaybe = invitations.filter((i: any) => i.rsvp_response === "maybe").length
  const noResponse = invitations.filter((i: any) => !i.rsvp_response).length

  const comingSoonPosts = socialPosts.filter((p: any) => p.post_type === "coming_soon")
  const openHousePosts = socialPosts.filter((p: any) => p.post_type !== "coming_soon")

  function handleInvite() {
    if (!upcomingEvent) {
      toast({ title: "No upcoming event", description: "Schedule an open house event first.", variant: "destructive" })
      return
    }
    startTransition(async () => {
      const res = await inviteFarmContacts({
        eventId: upcomingEvent.id,
        listingId,
        brokerageId: listing.brokerage_id,
        agentId: listing.agent_id,
        zip: listing.zip,
        channel,
      })
      if (res.success) {
        toast({ title: `Invitations sent`, description: `${res.invited} invitation${res.invited === 1 ? "" : "s"} queued via ${channel}.` })
      } else {
        toast({ title: "Failed to send invitations", description: res.error, variant: "destructive" })
      }
    })
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Coming Soon Posts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Coming Soon Posts</CardTitle>
          <p className="text-sm text-muted-foreground">
            Coming soon posts use neighborhood only — no full address shown
          </p>
        </CardHeader>
        <CardContent>
          {comingSoonPosts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No coming soon posts yet.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {comingSoonPosts.map((post: any) => (
                <PostRow key={post.id} post={post} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Open House Social Posts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Open House Social Posts</CardTitle>
        </CardHeader>
        <CardContent>
          {openHousePosts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open house posts scheduled.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {openHousePosts.map((post: any) => (
                <PostRow key={post.id} post={post} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Invite Farm Contacts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invite Farm Contacts</CardTitle>
          <p className="text-sm text-muted-foreground">
            Send invitations to contacts in zip <strong>{listing.zip}</strong>
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Select value={channel} onValueChange={(v) => setChannel(v as any)}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">
                  <span className="flex items-center gap-1.5"><Mail className="h-3.5 w-3.5" />Email</span>
                </SelectItem>
                <SelectItem value="sms">
                  <span className="flex items-center gap-1.5"><MessageSquare className="h-3.5 w-3.5" />SMS</span>
                </SelectItem>
                <SelectItem value="both">
                  <span className="flex items-center gap-1.5"><Send className="h-3.5 w-3.5" />Both</span>
                </SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={handleInvite} disabled={isPending || !upcomingEvent}>
              <Users className="mr-1.5 h-4 w-4" />
              {isPending ? "Sending..." : "Send Invitations"}
            </Button>
          </div>

          {/* RSVP Tracker */}
          {invitations.length > 0 && (
            <div className="flex items-center gap-4 rounded-md border border-border bg-muted/30 px-4 py-3">
              <div className="flex items-center gap-1.5 text-sm">
                <CheckCircle className="h-4 w-4 text-green-600" />
                <span className="font-medium">{rsvpYes}</span>
                <span className="text-muted-foreground">Yes</span>
              </div>
              <div className="flex items-center gap-1.5 text-sm">
                <Clock className="h-4 w-4 text-yellow-600" />
                <span className="font-medium">{rsvpMaybe}</span>
                <span className="text-muted-foreground">Maybe</span>
              </div>
              <div className="flex items-center gap-1.5 text-sm">
                <span className="font-medium">{noResponse}</span>
                <span className="text-muted-foreground">No response</span>
              </div>
              <span className="text-xs text-muted-foreground ml-auto">
                {invitations.length} total invited
              </span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function PostRow({ post }: { post: any }) {
  const isAuto = post.scheduled_for && !post.published_at
  return (
    <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium capitalize">{post.platform}</span>
          <span className="text-xs text-muted-foreground">{POST_TYPE_LABELS[post.post_type] ?? post.post_type}</span>
          {isAuto && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Auto</Badge>
          )}
        </div>
        {post.scheduled_for && (
          <span className="text-xs text-muted-foreground">
            {new Date(post.scheduled_for).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </span>
        )}
      </div>
      <Badge className={`text-xs border ${STATUS_COLORS[post.status] ?? STATUS_COLORS.draft}`}>
        {post.status}
      </Badge>
    </div>
  )
}
