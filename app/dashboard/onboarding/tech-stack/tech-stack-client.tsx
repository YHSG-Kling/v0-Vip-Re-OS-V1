"use client"

// ============================================================
// SYSTEM: L11-S03 — Tech Stack Setup Client Component
// VIP Real Estate AI OS — Layer 11
// ============================================================
// Provider cards in responsive grid with slide-over configuration panel

import { useState, useCallback, useMemo } from "react"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { toast } from "sonner"
import {
  Check,
  X,
  AlertCircle,
  Settings,
  Loader2,
  ChevronDown,
  Trash2,
  Play,
  Phone,
  Mail,
  FileSignature,
  Video,
  Users,
  Calendar,
  Calculator,
  Home,
  Send,
  Target,
} from "lucide-react"
import {
  getIntegrationStatus,
  saveCredentials,
  deleteCredentials,
  markTechStackComplete,
  getMaskedCredentials,
  type IntegrationStatusResult,
  type ProviderStatus,
} from "@/app/actions/onboarding/tech-stack"
import {
  PROVIDER_METADATA,
  PROVIDER_GROUPS,
  type ProviderName,
} from "@/lib/onboarding/integration-tester"
import confetti from "canvas-confetti"

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface TechStackClientProps {
  userId: string
  brokerageId: string
  brokerageName: string
  initialStatus: IntegrationStatusResult | null
}

// ─── ICON MAP ─────────────────────────────────────────────────────────────────

const PROVIDER_TYPE_ICONS: Record<string, React.ElementType> = {
  sms: Phone,
  email: Mail,
  esign: FileSignature,
  video: Video,
  crm: Users,
  calendar: Calendar,
  accounting: Calculator,
  mls: Home,
  direct_mail: Send,
  leads: Target,
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export function TechStackClient({
  userId,
  brokerageId,
  brokerageName,
  initialStatus,
}: TechStackClientProps) {
  const router = useRouter()
  const [configureProvider, setConfigureProvider] = useState<ProviderName | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<ProviderName | null>(null)
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({})
  const [isSaving, setIsSaving] = useState(false)
  const [isTesting, setIsTesting] = useState<ProviderName | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isCompleting, setIsCompleting] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState<string[]>(["required", "recommended"])

  // SWR for real-time status updates
  const { data: status, mutate } = useSWR(
    ["integration-status", brokerageId],
    async () => {
      const result = await getIntegrationStatus(brokerageId)
      return result.data
    },
    {
      fallbackData: initialStatus,
      refreshInterval: 30000, // Refresh every 30 seconds
    }
  )

  // Calculate progress
  const progressPercent = useMemo(() => {
    if (!status) return 0
    const required = ["twilio", "sendgrid", "docusign", "dotloop"]
    const connectedRequired = status.providers.filter(
      p => required.includes(p.provider) && p.status === "connected"
    ).length
    // Need 3 of 4 (SMS + Email + one of DocuSign/DotLoop)
    return Math.min((connectedRequired / 3) * 100, 100)
  }, [status])

  // Group providers
  const groupedProviders = useMemo(() => {
    if (!status) return {}
    return {
      required: status.providers.filter(p =>
        PROVIDER_GROUPS.required.providers.includes(p.provider)
      ),
      recommended: status.providers.filter(p =>
        PROVIDER_GROUPS.recommended.providers.includes(p.provider)
      ),
      optional: status.providers.filter(p =>
        PROVIDER_GROUPS.optional.providers.includes(p.provider)
      ),
    }
  }, [status])

  // Open configuration panel
  const handleConfigure = useCallback(async (provider: ProviderName) => {
    setConfigureProvider(provider)
    setCredentialValues({})

    // Load masked credentials if exists
    const { data: masked } = await getMaskedCredentials(provider, brokerageId)
    if (masked) {
      setCredentialValues(masked)
    }
  }, [brokerageId])

  // Save credentials
  const handleSave = async () => {
    if (!configureProvider) return

    // Check if user is editing masked values (haven't changed them)
    const metadata = PROVIDER_METADATA[configureProvider]
    const hasActualValues = metadata.credentialFields.some(field => {
      const value = credentialValues[field.key]
      return value && !value.includes("•")
    })

    if (!hasActualValues) {
      toast.error("Please enter new credential values")
      return
    }

    // Filter out masked values
    const cleanValues: Record<string, string> = {}
    for (const [key, value] of Object.entries(credentialValues)) {
      if (!value.includes("•")) {
        cleanValues[key] = value
      }
    }

    setIsSaving(true)
    try {
      const result = await saveCredentials(configureProvider, cleanValues, brokerageId)
      if (result.success) {
        toast.success("Credentials saved successfully")
        await mutate()
        setConfigureProvider(null)
      } else {
        toast.error(result.error || "Failed to save credentials")
      }
    } catch (error) {
      toast.error("An error occurred")
    } finally {
      setIsSaving(false)
    }
  }

  // Test connection
  const handleTest = async (provider: ProviderName) => {
    setIsTesting(provider)
    try {
      const response = await fetch("/api/onboarding/integrations/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, brokerage_id: brokerageId }),
      })

      const result = await response.json()

      if (result.pass) {
        toast.success(`${PROVIDER_METADATA[provider].displayName} connected successfully`)
        await mutate()
      } else {
        toast.error(result.detail || "Connection test failed")
      }
    } catch (error) {
      toast.error("Failed to test connection")
    } finally {
      setIsTesting(null)
    }
  }

  // Delete credentials
  const handleDelete = async () => {
    if (!deleteConfirm) return

    setIsDeleting(true)
    try {
      const result = await deleteCredentials(deleteConfirm, brokerageId)
      if (result.success) {
        toast.success("Credentials deleted")
        await mutate()
        setDeleteConfirm(null)
      } else {
        toast.error(result.error || "Failed to delete credentials")
      }
    } catch (error) {
      toast.error("An error occurred")
    } finally {
      setIsDeleting(false)
    }
  }

  // Complete tech stack setup
  const handleComplete = async () => {
    setIsCompleting(true)
    try {
      const result = await markTechStackComplete(brokerageId)
      if (result.success) {
        confetti({
          particleCount: 100,
          spread: 70,
          origin: { y: 0.6 },
        })
        toast.success("Tech stack setup complete!")
        setTimeout(() => {
          router.push("/dashboard/onboarding/training")
        }, 2000)
      } else {
        toast.error(result.error || "Failed to complete setup")
      }
    } catch (error) {
      toast.error("An error occurred")
    } finally {
      setIsCompleting(false)
    }
  }

  // Toggle group expansion
  const toggleGroup = (group: string) => {
    setExpandedGroups(prev =>
      prev.includes(group) ? prev.filter(g => g !== group) : [...prev, group]
    )
  }

  // Get status badge
  const getStatusBadge = (provider: ProviderStatus) => {
    switch (provider.status) {
      case "connected":
        return (
          <Badge className="bg-green-500/10 text-green-600 border-green-200">
            <Check className="mr-1 h-3 w-3" />
            Connected
          </Badge>
        )
      case "error":
        return (
          <Badge variant="destructive" className="bg-red-500/10 text-red-600 border-red-200">
            <AlertCircle className="mr-1 h-3 w-3" />
            Error
          </Badge>
        )
      default:
        return (
          <Badge variant="secondary" className="bg-muted text-muted-foreground">
            Not Configured
          </Badge>
        )
    }
  }

  // Render provider card
  const renderProviderCard = (provider: ProviderStatus) => {
    const Icon = PROVIDER_TYPE_ICONS[provider.providerType] || Settings
    const metadata = PROVIDER_METADATA[provider.provider]

    return (
      <Card key={provider.provider} className="relative">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                <Icon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <CardTitle className="text-base">{provider.displayName}</CardTitle>
                <CardDescription className="text-xs capitalize">
                  {provider.providerType.replace("_", " ")}
                </CardDescription>
              </div>
            </div>
            {getStatusBadge(provider)}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {provider.lastTestedAt && (
            <p className="text-xs text-muted-foreground">
              Last tested: {new Date(provider.lastTestedAt).toLocaleDateString()}
            </p>
          )}

          {/* Error accordion */}
          {provider.status === "error" && provider.lastError && (
            <Accordion type="single" collapsible className="w-full">
              <AccordionItem value="error" className="border-destructive/20">
                <AccordionTrigger className="text-xs text-destructive py-2">
                  View error details
                </AccordionTrigger>
                <AccordionContent className="text-xs text-muted-foreground bg-destructive/5 rounded p-2">
                  {provider.lastError}
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          )}

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleConfigure(provider.provider)}
              className="flex-1"
            >
              <Settings className="mr-1 h-3 w-3" />
              Configure
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleTest(provider.provider)}
              disabled={!provider.hasCredentials || isTesting === provider.provider}
              className="flex-1"
            >
              {isTesting === provider.provider ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Play className="mr-1 h-3 w-3" />
              )}
              Test
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Render provider group
  const renderGroup = (
    groupKey: "required" | "recommended" | "optional",
    groupInfo: typeof PROVIDER_GROUPS.required,
    providers: ProviderStatus[]
  ) => {
    const isExpanded = expandedGroups.includes(groupKey)
    const connectedCount = providers.filter(p => p.status === "connected").length

    return (
      <Collapsible
        key={groupKey}
        open={isExpanded}
        onOpenChange={() => toggleGroup(groupKey)}
        className="space-y-4"
      >
        <CollapsibleTrigger asChild>
          <button className="flex w-full items-center justify-between rounded-lg border bg-card p-4 text-left hover:bg-accent/50 transition-colors">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">{groupInfo.label}</h3>
                <Badge variant="outline" className="text-xs">
                  {connectedCount}/{providers.length}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">{groupInfo.description}</p>
            </div>
            <ChevronDown
              className={`h-5 w-5 text-muted-foreground transition-transform ${
                isExpanded ? "rotate-180" : ""
              }`}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {providers.map(renderProviderCard)}
          </div>
        </CollapsibleContent>
      </Collapsible>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight">Tech Stack Setup</h1>
          <p className="mt-2 text-muted-foreground">
            Configure your third-party integrations to power your AI assistant
          </p>
        </div>

        {/* Progress */}
        <Card className="mb-8">
          <CardContent className="py-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">
                {status?.connectedCount || 0} of {status?.totalRequired || 3} required integrations connected
              </span>
              <span className="text-sm text-muted-foreground">
                {Math.round(progressPercent)}%
              </span>
            </div>
            <Progress value={progressPercent} className="h-2" />
            {status?.requiredComplete && (
              <p className="mt-2 text-sm text-green-600 flex items-center gap-1">
                <Check className="h-4 w-4" />
                All required integrations connected
              </p>
            )}
          </CardContent>
        </Card>

        {/* Provider Groups */}
        <div className="space-y-6">
          {renderGroup("required", PROVIDER_GROUPS.required, groupedProviders.required || [])}
          {renderGroup("recommended", PROVIDER_GROUPS.recommended, groupedProviders.recommended || [])}
          {renderGroup("optional", PROVIDER_GROUPS.optional, groupedProviders.optional || [])}
        </div>

        {/* Continue Button */}
        <div className="mt-8 flex justify-end">
          <Button
            size="lg"
            onClick={handleComplete}
            disabled={!status?.requiredComplete || isCompleting}
          >
            {isCompleting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Completing...
              </>
            ) : (
              "Continue to Training"
            )}
          </Button>
        </div>
      </div>

      {/* Configuration Slide-Over */}
      <Sheet open={!!configureProvider} onOpenChange={() => setConfigureProvider(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          {configureProvider && (
            <>
              <SheetHeader>
                <SheetTitle>
                  Configure {PROVIDER_METADATA[configureProvider].displayName}
                </SheetTitle>
                <SheetDescription>
                  Enter your credentials to connect this integration.
                  Credentials are encrypted and stored securely.
                </SheetDescription>
              </SheetHeader>

              <div className="mt-6 space-y-4">
                {PROVIDER_METADATA[configureProvider].isOAuth ? (
                  // OAuth providers
                  <div className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                      Click the button below to connect your{" "}
                      {PROVIDER_METADATA[configureProvider].displayName} account.
                    </p>
                    <Button className="w-full">
                      Connect {PROVIDER_METADATA[configureProvider].displayName} Account
                    </Button>
                  </div>
                ) : (
                  // Standard credential fields
                  <>
                    {PROVIDER_METADATA[configureProvider].credentialFields.map(field => (
                      <div key={field.key} className="space-y-2">
                        <Label htmlFor={field.key}>
                          {field.label}
                          {field.required && <span className="text-destructive ml-1">*</span>}
                        </Label>
                        {field.type === "select" && field.options ? (
                          <Select
                            value={credentialValues[field.key] || ""}
                            onValueChange={value =>
                              setCredentialValues(prev => ({ ...prev, [field.key]: value }))
                            }
                          >
                            <SelectTrigger>
                              <SelectValue placeholder={`Select ${field.label.toLowerCase()}`} />
                            </SelectTrigger>
                            <SelectContent>
                              {field.options.map(opt => (
                                <SelectItem key={opt.value} value={opt.value}>
                                  {opt.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            id={field.key}
                            type={field.type === "password" ? "password" : "text"}
                            value={credentialValues[field.key] || ""}
                            onChange={e =>
                              setCredentialValues(prev => ({
                                ...prev,
                                [field.key]: e.target.value,
                              }))
                            }
                            placeholder={field.placeholder}
                          />
                        )}
                      </div>
                    ))}

                    <div className="flex gap-2 pt-4">
                      <Button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="flex-1"
                      >
                        {isSaving ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : null}
                        Save
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={() => {
                          setDeleteConfirm(configureProvider)
                          setConfigureProvider(null)
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Credentials</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the credentials for{" "}
              {deleteConfirm && PROVIDER_METADATA[deleteConfirm].displayName}?
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
