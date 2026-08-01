"use client"

import React, { useState, useEffect } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Video, Share2, Loader2, Check, X, ExternalLink, Link2, Globe } from "lucide-react"
import { updateAgentSettings } from "@/app/actions/agent-settings"
import { updateMyProfile } from "@/app/actions/user-profile"
import { disconnectSocialAccount } from "@/app/actions/social-publishing"
import { useToast } from "@/hooks/use-toast"

interface VideoSettingsProps {
  userId: string
  initialAvatarId: string | null
  initialVoiceId: string | null
}

const SOCIAL_PLATFORMS = [
  {
    key: "meta",
    label: "Meta (Facebook & Instagram)",
    description: "Facebook & Instagram publishing",
  },
  {
    key: "linkedin",
    label: "LinkedIn",
    description: "Professional network publishing",
  },
  {
    key: "twitter",
    label: "Twitter / X",
    description: "Tweet scheduling and publishing",
  },
  {
    key: "tiktok",
    label: "TikTok",
    description: "Short-form video publishing",
  },
  {
    key: "youtube",
    label: "YouTube",
    description: "Long-form video and channel management",
  },
  {
    key: "pinterest",
    label: "Pinterest",
    description: "Pin property images and listings to boards",
  },
  {
    key: "google_business",
    label: "Google Business Profile",
    description: "Post updates to your Google Business listing",
  },
] as const

interface SocialAccountsProps {
  userId: string
  initialAccounts: any[]
}

export function PersonalWebsiteCard({ initialUrl }: { initialUrl: string | null }) {
  const [website, setWebsite] = useState(initialUrl ?? "")
  const [saving, setSaving] = useState(false)
  const { toast } = useToast()

  async function handleSave() {
    setSaving(true)
    try {
      const r = await updateMyProfile({ personalWebsiteUrl: website })
      if (r.success) {
        toast({ title: "Website saved", description: "Your personal website URL has been updated." })
      } else {
        toast({ title: "Save failed", description: r.error, variant: "destructive" })
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Globe className="h-4 w-4" />
          Personal Website
        </CardTitle>
        <CardDescription className="text-xs">
          Your personal real-estate website (Realtor.com profile, Wix, Squarespace, custom domain).
          When set, the platform uses it as the canonical embed origin for /embed/blog and as the
          byline link on your blog landing pages.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="personalWebsite">Website URL</Label>
          <Input
            id="personalWebsite"
            type="url"
            inputMode="url"
            placeholder="https://your-domain.com"
            value={website}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWebsite(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Must start with <code>http://</code> or <code>https://</code>. Leave blank to clear.
          </p>
        </div>
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Saving...</> : "Save Website"}
        </Button>
      </CardContent>
    </Card>
  )
}

export function VideoSettingsCard({ userId, initialAvatarId, initialVoiceId }: VideoSettingsProps) {
  const [avatarId, setAvatarId] = useState(initialAvatarId ?? "")
  const [voiceId, setVoiceId] = useState(initialVoiceId ?? "")
  const [saving, setSaving] = useState(false)
  const { toast } = useToast()

  async function handleSave() {
    setSaving(true)
    try {
      const result = await updateAgentSettings(userId, {
        avatarId: avatarId.trim() || undefined,
        voiceId: voiceId.trim() || undefined,
      })
      if (result.success) {
        toast({ title: "Video settings saved", description: "Your avatar and voice ID have been updated." })
      } else {
        toast({ title: "Save failed", description: result.error, variant: "destructive" })
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Video className="h-4 w-4" />
          Video Generation Settings
        </CardTitle>
        <CardDescription className="text-xs">
          Your personal D-ID avatar and ElevenLabs voice IDs. These are used when you create AI videos.
          The easiest way to set these up is in{" "}
          <a
            href="/dashboard/videos/voice"
            className="underline hover:text-foreground"
          >
            Voice &amp; Avatar setup
          </a>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="avatarId">D-ID Avatar ID</Label>
          <Input
            id="avatarId"
            value={avatarId}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAvatarId(e.target.value)}
            placeholder="e.g. your D-ID avatar ID"
          />
          <p className="text-xs text-muted-foreground">
            Set this up in Voice &amp; Avatar, or paste a D-ID avatar ID.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="voiceId">ElevenLabs Voice ID</Label>
          <Input
            id="voiceId"
            value={voiceId}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setVoiceId(e.target.value)}
            placeholder="e.g. 1bd001e7e50f421d891986aad5158bc8"
          />
          <p className="text-xs text-muted-foreground">
            Set this up in Voice &amp; Avatar, or paste your ElevenLabs voice clone ID.
          </p>
        </div>
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Saving...</> : "Save Video Settings"}
        </Button>
      </CardContent>
    </Card>
  )
}

export function SocialAccountsCard({ userId, initialAccounts }: SocialAccountsProps) {
  const [accounts, setAccounts] = useState<any[]>(initialAccounts)
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
  const { toast } = useToast()
  const searchParams = useSearchParams()
  const router = useRouter()

  // Handle OAuth callback results
  useEffect(() => {
    const oauthSuccess = searchParams.get("oauth_success")
    const oauthError = searchParams.get("oauth_error")
    const tab = searchParams.get("tab")

    if (tab === "social" && oauthSuccess) {
      const platformLabel = SOCIAL_PLATFORMS.find((p) => p.key === oauthSuccess)?.label ?? oauthSuccess
      toast({ title: `${platformLabel} connected`, description: "Your account has been linked successfully." })
      // Clear query params without page reload
      const url = new URL(window.location.href)
      url.searchParams.delete("oauth_success")
      url.searchParams.delete("tab")
      router.replace(url.pathname + url.search)
    } else if (oauthError) {
      toast({ title: "Connection failed", description: oauthError, variant: "destructive" })
      const url = new URL(window.location.href)
      url.searchParams.delete("oauth_error")
      url.searchParams.delete("provider")
      router.replace(url.pathname + url.search)
    }
  }, [searchParams, router, toast])

  function isConnected(platformKey: string) {
    return accounts.some((a) => a.platform === platformKey && a.is_active)
  }

  function getAccount(platformKey: string) {
    return accounts.find((a) => a.platform === platformKey && a.is_active)
  }

  function handleOAuthConnect(platformKey: string) {
    window.location.href = `/api/social/oauth/${platformKey}`
  }

  async function handleDisconnect(platformKey: string) {
    const account = getAccount(platformKey)
    if (!account) return
    setDisconnecting(platformKey)
    try {
      // NOTE: this imports disconnectSocialAccount from social-publishing, which
      // THROWS on failure — not the same-named action in social-media-automation,
      // which returns { success:false }. The catch below is the correct handler.
      await disconnectSocialAccount(account.id, userId)
      setAccounts((prev) => prev.filter((a) => a.id !== account.id))
      toast({ title: `${platformKey} disconnected` })
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" })
    } finally {
      setDisconnecting(null)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Share2 className="h-4 w-4" />
          Social Media Accounts
        </CardTitle>
        <CardDescription className="text-xs">
          Connect your social accounts via OAuth to publish content directly from the platform.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {SOCIAL_PLATFORMS.map((platform) => {
          const connected = isConnected(platform.key)
          const isDisconnecting = disconnecting === platform.key

          return (
            <div key={platform.key} className="flex flex-col gap-2 pb-4 border-b last:border-0 last:pb-0">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">{platform.label}</p>
                  <p className="text-xs text-muted-foreground">{platform.description}</p>
                </div>
                {connected ? (
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="flex items-center gap-1 text-xs">
                      <Check className="h-3 w-3 text-green-600" />
                      Connected
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDisconnect(platform.key)}
                      disabled={isDisconnecting}
                    >
                      {isDisconnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                ) : (
                  <Badge variant="outline" className="text-xs text-muted-foreground">Not connected</Badge>
                )}
              </div>

              {!connected && (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 gap-1.5"
                    onClick={() => handleOAuthConnect(platform.key)}
                  >
                    <Link2 className="h-3.5 w-3.5" />
                    Connect with {platform.label.split(" ")[0]}
                  </Button>
                </div>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
