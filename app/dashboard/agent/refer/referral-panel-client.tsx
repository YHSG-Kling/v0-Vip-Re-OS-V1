"use client"

import { useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { toast } from "sonner"
import {
  Copy, Check, Share2, Mail, MessageSquare, Sparkles, Users, ArrowRight,
} from "lucide-react"

interface Referral {
  id:          string
  firstName:   string
  lastName:    string
  email:       string | null
  status:      string
  createdAt:   string
  provisioned: boolean
}

interface Props {
  firstName:      string | null
  brokerageName:  string
  brokeragePitch: string | null
  referralUrl:    string
  referrals:      Referral[]
}

const STATUS_LABELS: Record<string, { label: string; tone: "default" | "secondary" | "outline" }> = {
  prospect:        { label: "New inquiry",      tone: "secondary" },
  contacted:       { label: "Contacted",        tone: "secondary" },
  interviewing:    { label: "Interviewing",     tone: "default"   },
  offer_extended:  { label: "Offer extended",   tone: "default"   },
  joined:          { label: "Joined ✓",         tone: "default"   },
  declined:        { label: "Declined",         tone: "outline"   },
}

const relative = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

export function ReferralPanelClient({
  firstName, brokerageName, brokeragePitch, referralUrl, referrals,
}: Props) {
  const [copied, setCopied] = useState(false)

  const joinedCount = referrals.filter(r => r.status === "joined" || r.provisioned).length
  const activeCount = referrals.filter(r => !["joined","declined"].includes(r.status)).length

  function copy() {
    navigator.clipboard.writeText(referralUrl)
    setCopied(true)
    toast.success("Link copied — share it anywhere.")
    setTimeout(() => setCopied(false), 2_500)
  }

  const sharePitch = brokeragePitch ?? `I switched to ${brokerageName} and it's been a game-changer. Check it out:`
  const smsBody    = encodeURIComponent(`${sharePitch} ${referralUrl}`)
  const emailSubject = encodeURIComponent(`Thought you'd want to see ${brokerageName}`)
  const emailBody    = encodeURIComponent(`${sharePitch}\n\n${referralUrl}\n\nLet me know if you have questions — happy to walk you through it.`)

  return (
    <div className="container max-w-4xl mx-auto py-8 px-4">
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="h-5 w-5 text-indigo-600" />
          <h1 className="text-2xl font-semibold tracking-tight">
            {firstName ? `${firstName}, refer an agent — earn credit when they join.` : "Refer an agent — earn credit when they join."}
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Every agent who joins {brokerageName} through your link is tracked back to you. Your broker decides the
          referral bonus — talk to them for the current program.
        </p>
      </div>

      {/* ── Headline counters ───────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-3 mb-6">
        <Card>
          <CardContent className="py-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Total referrals</p>
            <p className="text-3xl font-bold mt-1">{referrals.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Active in pipeline</p>
            <p className="text-3xl font-bold mt-1 text-indigo-700">{activeCount}</p>
          </CardContent>
        </Card>
        <Card className="border-emerald-200 bg-emerald-50/40">
          <CardContent className="py-4">
            <p className="text-xs uppercase tracking-wide text-emerald-700">Joined</p>
            <p className="text-3xl font-bold mt-1 text-emerald-900">{joinedCount}</p>
          </CardContent>
        </Card>
      </div>

      {/* ── Your link ───────────────────────────────────────────────────── */}
      <Card className="mb-6">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Share2 className="h-4 w-4 text-indigo-600" /> Your personal referral link
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input value={referralUrl} readOnly className="font-mono text-xs" />
            <Button onClick={copy} variant={copied ? "default" : "outline"}>
              {copied ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Anyone who fills out our recruiting page from this URL is credited to you — automatically.
          </p>

          <Tabs defaultValue="quick">
            <TabsList className="grid grid-cols-3 w-full max-w-md">
              <TabsTrigger value="quick">Share</TabsTrigger>
              <TabsTrigger value="email">Email</TabsTrigger>
              <TabsTrigger value="text">Text</TabsTrigger>
            </TabsList>
            <TabsContent value="quick" className="pt-3">
              <p className="text-sm text-muted-foreground">
                Drop the link in a DM, post it to LinkedIn, or paste it into your email signature. Whatever channel
                you trust — the link does the credit tracking for you.
              </p>
            </TabsContent>
            <TabsContent value="email" className="pt-3 space-y-2">
              <p className="text-xs text-muted-foreground">Opens your default email client with a prefilled message.</p>
              <Button asChild variant="outline" size="sm">
                <a href={`mailto:?subject=${emailSubject}&body=${emailBody}`}>
                  <Mail className="h-3 w-3 mr-1" /> Open in email
                </a>
              </Button>
            </TabsContent>
            <TabsContent value="text" className="pt-3 space-y-2">
              <p className="text-xs text-muted-foreground">Opens your phone's SMS app with a prefilled message.</p>
              <Button asChild variant="outline" size="sm">
                <a href={`sms:?body=${smsBody}`}>
                  <MessageSquare className="h-3 w-3 mr-1" /> Open in text
                </a>
              </Button>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* ── Your referrals pipeline ─────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Users className="h-4 w-4 text-indigo-600" /> Your referral pipeline
          </CardTitle>
        </CardHeader>
        <CardContent>
          {referrals.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground border border-dashed rounded-lg">
              No referrals yet. Share your link above and they'll appear here as they come in.
            </div>
          ) : (
            <div className="space-y-2">
              {referrals.map(r => {
                const meta = STATUS_LABELS[r.status] ?? { label: r.status, tone: "outline" as const }
                return (
                  <div key={r.id} className="flex items-center justify-between gap-3 p-3 rounded-md border">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{r.firstName} {r.lastName}</p>
                      <p className="text-xs text-muted-foreground truncate">{r.email ?? "—"} · {relative(r.createdAt)}</p>
                    </div>
                    <Badge variant={meta.tone}>{meta.label}</Badge>
                  </div>
                )
              })}
            </div>
          )}
          <div className="mt-4 text-center">
            <Button asChild variant="outline" size="sm">
              <Link href={`${referralUrl}`} target="_blank">
                Preview the recruiting page <ArrowRight className="h-3 w-3 ml-1" />
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
