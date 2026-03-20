"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Check, X, Loader2, AlertCircle, ExternalLink } from "lucide-react"
import {
  getAgentCredentials,
  saveServiceCredential,
  verifyServiceCredential,
  type ServiceName,
} from "@/app/actions/agent-credentials"
import { useToast } from "@/hooks/use-toast"

export default function IntegrationsContent() {
  const [credentials, setCredentials] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const { toast } = useToast()

  useEffect(() => {
    loadCredentials()
  }, [])

  const loadCredentials = async () => {
    try {
      const data = await getAgentCredentials()
      setCredentials(data)
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      })
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
      loadCredentials()
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      })
    }
  }

  const getCredential = (serviceName: string) => {
    return credentials.find((c) => c.service_name === serviceName)
  }

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
        <TabsTrigger value="social">Social Media</TabsTrigger>
      </TabsList>

      {/* IDX Broker Tab */}
      <TabsContent value="listing" className="space-y-4">
        <IDXBrokerCard
          credential={getCredential("idx_broker")}
          onTest={() => handleTestConnection("idx_broker")}
          onSave={loadCredentials}
        />
      </TabsContent>

      {/* GHL Tab */}
      <TabsContent value="crm" className="space-y-4">
        <GHLCard
          credential={getCredential("ghl")}
          onTest={() => handleTestConnection("ghl")}
          onSave={loadCredentials}
        />
      </TabsContent>

      {/* Social Media Tab */}
      <TabsContent value="social" className="space-y-4">
        <MetaCard credential={getCredential("meta")} onSave={loadCredentials} />
        <LinkedInCard credential={getCredential("linkedin")} onSave={loadCredentials} />
        <TwitterCard credential={getCredential("twitter")} onSave={loadCredentials} />
        <TikTokCard credential={getCredential("tiktok")} onSave={loadCredentials} />
        <YouTubeCard credential={getCredential("youtube")} onSave={loadCredentials} />
        <PinterestCard credential={getCredential("pinterest")} onSave={loadCredentials} />
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

function MetaCard({ credential, onSave }: any) {
  const { toast } = useToast()

  const handleConnect = () => {
    toast({
      title: "OAuth Coming Soon",
      description: "Meta Business Suite OAuth will be available during onboarding.",
    })
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <CardTitle>Meta Business Suite</CardTitle>
            <CardDescription>Facebook & Instagram publishing</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs font-normal">Agent scope</Badge>
            {credential?.is_active ? (
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
        <Button onClick={handleConnect}>
          <ExternalLink className="h-4 w-4 mr-2" />
          Connect Meta Account
        </Button>
      </CardContent>
    </Card>
  )
}

function LinkedInCard({ credential, onSave }: any) {
  const { toast } = useToast()

  const handleConnect = () => {
    toast({
      title: "OAuth Coming Soon",
      description: "LinkedIn OAuth will be available during onboarding.",
    })
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <CardTitle>LinkedIn</CardTitle>
            <CardDescription>Professional network publishing</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs font-normal">Agent scope</Badge>
            {credential?.is_active ? (
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
        <Button onClick={handleConnect}>
          <ExternalLink className="h-4 w-4 mr-2" />
          Connect LinkedIn
        </Button>
      </CardContent>
    </Card>
  )
}

function TwitterCard({ credential, onSave }: any) {
  const { toast } = useToast()

  const handleConnect = () => {
    toast({
      title: "OAuth Coming Soon",
      description: "Twitter/X OAuth will be available during onboarding.",
    })
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <CardTitle>Twitter / X</CardTitle>
            <CardDescription>Tweet scheduling and publishing</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs font-normal">Agent scope</Badge>
            {credential?.is_active ? (
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
        <Button onClick={handleConnect}>
          <ExternalLink className="h-4 w-4 mr-2" />
          Connect Twitter
        </Button>
      </CardContent>
    </Card>
  )
}

function TikTokCard({ credential, onSave }: any) {
  const { toast } = useToast()

  const handleConnect = () => {
    toast({
      title: "OAuth Coming Soon",
      description: "TikTok OAuth will be available during onboarding.",
    })
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <CardTitle>TikTok</CardTitle>
            <CardDescription>Short-form video publishing and scheduling</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs font-normal">Agent scope</Badge>
            {credential?.is_active ? (
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
        <Button onClick={handleConnect}>
          <ExternalLink className="h-4 w-4 mr-2" />
          Connect TikTok
        </Button>
      </CardContent>
    </Card>
  )
}

function YouTubeCard({ credential, onSave }: any) {
  const { toast } = useToast()

  const handleConnect = () => {
    toast({
      title: "OAuth Coming Soon",
      description: "YouTube OAuth will be available during onboarding.",
    })
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <CardTitle>YouTube</CardTitle>
            <CardDescription>Long-form video publishing and channel management</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs font-normal">Agent scope</Badge>
            {credential?.is_active ? (
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
        <Button onClick={handleConnect}>
          <ExternalLink className="h-4 w-4 mr-2" />
          Connect YouTube
        </Button>
      </CardContent>
    </Card>
  )
}

function PinterestCard({ credential, onSave }: any) {
  const { toast } = useToast()

  const handleConnect = () => {
    toast({
      title: "OAuth Coming Soon",
      description: "Pinterest OAuth will be available during onboarding.",
    })
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <CardTitle>Pinterest</CardTitle>
            <CardDescription>Pin boards, listing visuals, and idea publishing</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-xs font-normal">Agent scope</Badge>
            {credential?.is_active ? (
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
        <Button onClick={handleConnect}>
          <ExternalLink className="h-4 w-4 mr-2" />
          Connect Pinterest
        </Button>
      </CardContent>
    </Card>
  )
}
