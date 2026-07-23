"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Check, X, Loader2, AlertCircle, ExternalLink, Phone, Mail } from "lucide-react"
import Link from "next/link"
import {
  getAgentCredentials,
  saveServiceCredential,
  verifyServiceCredential,
  type ServiceName,
} from "@/app/actions/agent-credentials"
import {
  getSocialAccounts,
  connectSocialAccount,
  disconnectSocialAccount,
} from "@/app/actions/social-publishing"
import { useToast } from "@/hooks/use-toast"

const SOCIAL_PLATFORMS = [
  {
    key: "meta",
    label: "Meta Business Suite",
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
    docsLabel: "Get your X bearer token",
    placeholder: "AAAAAAAAAA...",
  },
  {
    key: "tiktok",
    label: "TikTok",
    description: "Short-form video publishing and scheduling",
    docsUrl: "https://developers.tiktok.com/",
    docsLabel: "Get your TikTok token",
    placeholder: "act.xxxxx...",
  },
  {
    key: "youtube",
    label: "YouTube",
    description: "Long-form video publishing and channel management",
    docsUrl: "https://console.cloud.google.com/apis/credentials",
    docsLabel: "Get your YouTube token",
    placeholder: "ya29.xxx...",
  },
  {
    key: "pinterest",
    label: "Pinterest",
    description: "Pin boards, listing visuals, and idea publishing",
    docsUrl: "https://developers.pinterest.com/apps/",
    docsLabel: "Get your Pinterest token",
    placeholder: "pina_xxx...",
  },
] as const

export default function IntegrationsContent() {
  const [credentials, setCredentials] = useState<any[]>([])
  const [socialAccounts, setSocialAccounts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [tokenInputs, setTokenInputs] = useState<Record<string, string>>({})
  const [connecting, setConnecting] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
  const { toast } = useToast()

  useEffect(() => {
    loadAll()
  }, [])

  const loadAll = async () => {
    try {
      const [creds, socials] = await Promise.all([
        getAgentCredentials(),
        getSocialAccounts(),
      ])
      setCredentials(creds)
      setSocialAccounts(socials)
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  const handleTestConnection = async (serviceName: ServiceName) => {
    try {
      const result = await verifyServiceCredential(serviceName)
      toast({
        title: result.isValid ? "Connection Successful" : "Connection Failed",
        description: result.isValid ? "Your credentials are working correctly." : result.errorMessage,
        variant: result.isValid ? "default" : "destructive",
      })
      loadAll()
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" })
    }
  }

  const handleConnect = async (platform: string, platformLabel: string) => {
    const token = tokenInputs[platform]
    if (!token) return
    setConnecting(platform)
    try {
      await connectSocialAccount({
        platform,
        accountId: platform,
        accountName: `${platformLabel} Account`,
        accessToken: token,
      })
      toast({ title: `${platformLabel} connected` })
      setTokenInputs((prev) => ({ ...prev, [platform]: "" }))
      loadAll()
    } catch (err: any) {
      toast({ title: "Connection failed", description: err.message, variant: "destructive" })
    } finally {
      setConnecting(null)
    }
  }

  const handleDisconnect = async (accountId: string, platformLabel: string) => {
    setDisconnecting(accountId)
    try {
      await disconnectSocialAccount(accountId)
      toast({ title: `${platformLabel} disconnected` })
      loadAll()
    } catch (err: any) {
      toast({ title: "Disconnect failed", description: err.message, variant: "destructive" })
    } finally {
      setDisconnecting(null)
    }
  }

  const getCredential = (serviceName: string) =>
    credentials.find((c) => c.service_name === serviceName)

  const getSocialAccount = (platform: string) =>
    socialAccounts.find((a) => a.platform === platform && a.is_active)

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    )
  }

  return (
    <Tabs defaultValue="listing" className="space-y-6">
      <TabsList>
        <TabsTrigger value="listing">Listing Provider</TabsTrigger>
        <TabsTrigger value="crm">CRM Sync</TabsTrigger>
        <TabsTrigger value="voice">Voice & AI Calling</TabsTrigger>
        <TabsTrigger value="social">Social Media</TabsTrigger>
      </TabsList>

      {/* IDX Broker Tab */}
      <TabsContent value="listing" className="space-y-4">
        <IDXBrokerCard
          credential={getCredential("idx_broker")}
          onTest={() => handleTestConnection("idx_broker")}
          onSave={loadAll}
        />
      </TabsContent>

      {/* GHL Tab */}
      <TabsContent value="crm" className="space-y-4">
        <GHLCard
          credential={getCredential("ghl")}
          onTest={() => handleTestConnection("ghl")}
          onSave={loadAll}
        />
      </TabsContent>

      {/* Voice & AI Calling Tab — bridges to the canonical voice/direct-mail
          setup surfaces so app-wide "set up AI calling / Vapi / Lob" prompts
          that route here no longer dead-end on a page without voice. */}
      <TabsContent value="voice" className="space-y-4">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Phone className="h-5 w-5 text-muted-foreground" />
              <CardTitle>AI Voice Calling</CardTitle>
            </div>
            <CardDescription>
              Phone numbers, BYOC carriers, IVR menus, the Vapi voice engine, and the
              duty agent for inbound and outbound AI ISA calls are configured in ISA Calling.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/dashboard/settings/isa-calling">
                Open ISA Calling setup
                <ExternalLink className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-muted-foreground" />
              <CardTitle>Direct Mail (Lob)</CardTitle>
            </div>
            <CardDescription>
              Connect Lob for automated postcards and letters. Presets, size preferences,
              and print variants are managed in Direct Mail settings.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/settings/direct-mail">
                Open Direct Mail setup
                <ExternalLink className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </TabsContent>

      {/* Social Media Tab */}
      <TabsContent value="social" className="space-y-4">
        {SOCIAL_PLATFORMS.map((p) => {
          const account = getSocialAccount(p.key)
          const isConnecting = connecting === p.key
          const isDisconnecting = disconnecting === account?.id
          const token = tokenInputs[p.key] ?? ""

          return (
            <Card key={p.key}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <CardTitle>{p.label}</CardTitle>
                    <CardDescription>{p.description}</CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-xs font-normal">Agent scope</Badge>
                    {account ? (
                      <Badge variant="default" className="bg-green-500">
                        <Check className="h-3 w-3 mr-1" />
                        Connected
                      </Badge>
                    ) : (
                      <Badge variant="outline">Not Connected</Badge>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {account ? (
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-muted-foreground">
                      Connected as <span className="font-medium text-foreground">{account.account_name}</span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isDisconnecting}
                      onClick={() => handleDisconnect(account.id, p.label)}
                    >
                      {isDisconnecting && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                      Disconnect
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <Badge variant="outline" className="text-amber-600 border-amber-300">
                      Manual Connection Available
                    </Badge>
                    <p className="text-sm text-muted-foreground">
                      Connect {p.label} by pasting your access token below. Get your token from{" "}
                      {p.label} Business or Developer settings.
                    </p>
                    <div className="space-y-2">
                      <Label htmlFor={`token-${p.key}`} className="sr-only">
                        {p.label} access token
                      </Label>
                      <Input
                        id={`token-${p.key}`}
                        type="password"
                        placeholder={p.placeholder}
                        value={token}
                        onChange={(e) =>
                          setTokenInputs((prev) => ({ ...prev, [p.key]: e.target.value }))
                        }
                      />
                      <Button
                        size="sm"
                        disabled={!token || isConnecting}
                        onClick={() => handleConnect(p.key, p.label)}
                      >
                        {isConnecting ? (
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : null}
                        Connect
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        <a
                          href={p.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline underline-offset-2"
                        >
                          {p.docsLabel} &rarr;
                        </a>
                      </p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}
      </TabsContent>
    </Tabs>
  )
}

function IDXBrokerCard({ credential, onTest, onSave }: any) {
  const [apiKey, setApiKey] = useState(credential?.api_key || "")
  const [mlsId, setMlsId] = useState(credential?.config?.mls_id || "")
  const [agentCode, setAgentCode] = useState(credential?.config?.agent_code || "")
  const [saving, setSaving] = useState(false)
  const { toast } = useToast()

  const handleSave = async () => {
    setSaving(true)
    try {
      await saveServiceCredential({
        serviceName: "idx_broker",
        serviceType: "listing_provider",
        apiKey,
        config: { mls_id: mlsId, agent_code: agentCode },
      })
      toast({ title: "Success", description: "IDX Broker credentials saved" })
      onSave()
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>IDX Broker</CardTitle>
            <CardDescription>Connect your MLS listing data</CardDescription>
          </div>
          {credential?.is_verified ? (
            <Badge variant="default" className="bg-green-500">
              <Check className="h-3 w-3 mr-1" />
              Connected
            </Badge>
          ) : credential ? (
            <Badge variant="secondary">
              <X className="h-3 w-3 mr-1" />
              Not Verified
            </Badge>
          ) : (
            <Badge variant="outline">Not Connected</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="idx-api-key">API Access Key</Label>
          <Input
            id="idx-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Enter your IDX Broker API key"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="mls-id">MLS ID</Label>
            <Input id="mls-id" value={mlsId} onChange={(e) => setMlsId(e.target.value)} placeholder="e.g., c123" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-code">Agent Code</Label>
            <Input
              id="agent-code"
              value={agentCode}
              onChange={(e) => setAgentCode(e.target.value)}
              placeholder="e.g., ABC123"
            />
          </div>
        </div>
        {credential?.error_message && (
          <div className="flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5" />
            <span>{credential.error_message}</span>
          </div>
        )}
        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={saving || !apiKey}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save Credentials
          </Button>
          {credential && (
            <Button variant="outline" onClick={onTest}>
              Test Connection
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function GHLCard({ credential, onTest, onSave }: any) {
  const [apiKey, setApiKey] = useState(credential?.api_key || "")
  const [locationId, setLocationId] = useState(credential?.config?.location_id || "")
  const [saving, setSaving] = useState(false)
  const { toast } = useToast()

  const handleSave = async () => {
    setSaving(true)
    try {
      await saveServiceCredential({
        serviceName: "ghl",
        serviceType: "crm_sync",
        apiKey,
        config: { location_id: locationId },
      })
      toast({ title: "Success", description: "GHL credentials saved" })
      onSave()
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>GoHighLevel</CardTitle>
            <CardDescription>Sync contacts, SMS/phone, and website tracking</CardDescription>
          </div>
          {credential?.is_verified ? (
            <Badge variant="default" className="bg-green-500">
              <Check className="h-3 w-3 mr-1" />
              Connected
            </Badge>
          ) : credential ? (
            <Badge variant="secondary">
              <X className="h-3 w-3 mr-1" />
              Not Verified
            </Badge>
          ) : (
            <Badge variant="outline">Not Connected</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="ghl-api-key">API Key</Label>
          <Input
            id="ghl-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Enter your GHL API key"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="location-id">Location ID</Label>
          <Input
            id="location-id"
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            placeholder="Your GHL sub-account location ID"
          />
        </div>
        <div className="text-sm text-muted-foreground">
          <strong>Note:</strong> This enables bi-directional sync for contacts, call/SMS history, and notes. GHL runs in
          the background—you never need to login there.
        </div>
        {credential?.error_message && (
          <div className="flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5" />
            <span>{credential.error_message}</span>
          </div>
        )}
        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={saving || !apiKey}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save Credentials
          </Button>
          {credential && (
            <Button variant="outline" onClick={onTest}>
              Test Connection
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}


