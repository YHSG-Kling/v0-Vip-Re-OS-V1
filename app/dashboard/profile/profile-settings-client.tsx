"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Video, Share2, Loader2, Check, X, ExternalLink } from "lucide-react"
import { updateAgentSettings } from "@/app/actions/agent-settings"
import { connectSocialAccount, disconnectSocialAccount } from "@/app/actions/social-publishing"
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
    docsUrl: "https://developers.facebook.com/docs/facebook-login/access-tokens/",
    docsLabel: "Get your Meta token",
    placeholder: "EAABwzLi...",
  },
  {
    key: "linkedin",
    label: "LinkedIn",
    description: "Professional network publishing",
    docsUrl: "https://www.linkedin.com/developers/apps",
    docsLabel: "Get your LinkedIn token",
    placeholder: "AQX...",
  },
  {
    key: "twitter",
    label: "Twitter / X",
    description: "Tweet scheduling and publishing",
    docsUrl: "https://developer.twitter.com/en/portal/dashboard",
    docsLabel: "Get your X token",
    placeholder: "AAAAAAAAAA...",
  },
  {
    key: "tiktok",
    label: "TikTok",
    description: "Short-form video publishing",
    docsUrl: "https://developers.tiktok.com/",
    docsLabel: "Get your TikTok token",
    placeholder: "act.xxxxx...",
  },
  {
    key: "youtube",
    label: "YouTube",
    description: "Long-form video and channel management",
    docsUrl: "https://console.cloud.google.com/apis/credentials",
    docsLabel: "Get your YouTube token",
    placeholder: "ya29.xxx...",
  },
] as const

interface SocialAccountsProps {
  userId: string
  initialAccounts: any[]
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
          Your personal HeyGen avatar and voice IDs. These are used when you create AI videos.
          Find your IDs in the{" "}
          <a
            href="https://app.heygen.com/avatars"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            HeyGen dashboard
          </a>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="avatarId">HeyGen Avatar ID</Label>
          <Input
            id="avatarId"
            value={avatarId}
            onChange={(e) => setAvatarId(e.target.value)}
            placeholder="e.g. Angela-inblackskirt-20220820"
          />
          <p className="text-xs text-muted-foreground">
            Copy from HeyGen &rarr; Avatars &rarr; select your avatar &rarr; copy the ID.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="voiceId">HeyGen Voice ID</Label>
          <Input
            id="voiceId"
            value={voiceId}
            onChange={(e) => setVoiceId(e.target.value)}
            placeholder="e.g. 1bd001e7e50f421d891986aad5158bc8"
          />
          <p className="text-xs text-muted-foreground">
            Copy from HeyGen &rarr; Voice &rarr; select your voice clone &rarr; copy the ID.
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
  const [tokenInputs, setTokenInputs] = useState<Record<string, string>>({})
  const [connecting, setConnecting] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
  const { toast } = useToast()

  function isConnected(platformKey: string) {
    return accounts.some((a) => a.platform === platformKey && a.is_active)
  }

  function getAccount(platformKey: string) {
    return accounts.find((a) => a.platform === platformKey && a.is_active)
  }

  async function handleConnect(platformKey: string) {
    const token = tokenInputs[platformKey]?.trim()
    if (!token) {
      toast({ title: "Token required", description: "Enter your access token to connect.", variant: "destructive" })
      return
    }
    setConnecting(platformKey)
    try {
      const result = await connectSocialAccount({
        platform: platformKey,
        accountId: userId,
        accountName: platformKey,
        accessToken: token,
        userId,
      })
      if (result) {
        setAccounts((prev) => [...prev.filter((a) => a.platform !== platformKey), result])
        setTokenInputs((prev) => ({ ...prev, [platformKey]: "" }))
        toast({ title: `${platformKey} connected`, description: "Account connected successfully." })
      }
    } catch (err: any) {
      toast({ title: "Connection failed", description: err.message, variant: "destructive" })
    } finally {
      setConnecting(null)
    }
  }

  async function handleDisconnect(platformKey: string) {
    const account = getAccount(platformKey)
    if (!account) return
    setDisconnecting(platformKey)
    try {
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
          Connect your personal social accounts to publish videos and content directly from the platform.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {SOCIAL_PLATFORMS.map((platform) => {
          const connected = isConnected(platform.key)
          const isConnecting = connecting === platform.key
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
                  <Input
                    className="text-xs h-8"
                    value={tokenInputs[platform.key] ?? ""}
                    onChange={(e) => setTokenInputs((prev) => ({ ...prev, [platform.key]: e.target.value }))}
                    placeholder={platform.placeholder}
                  />
                  <Button
                    size="sm"
                    className="shrink-0"
                    onClick={() => handleConnect(platform.key)}
                    disabled={isConnecting}
                  >
                    {isConnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Connect"}
                  </Button>
                  <Button variant="ghost" size="sm" asChild className="shrink-0">
                    <a href={platform.docsUrl} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
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
