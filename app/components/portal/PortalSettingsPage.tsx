"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Switch } from "@/components/ui/switch"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { User, Bell, Shield, Smartphone, Mail, Save, ArrowLeft, Camera, Check, AlertCircle } from "lucide-react"
import Link from "next/link"
import { uploadProfilePhoto, updateContactProfile, fileDataSubjectRequestFromPortal } from "@/app/actions/portal-settings"

interface Contact {
  id: string
  first_name?: string
  last_name?: string
  name?: string
  email?: string
  phone?: string
  address?: string
  city?: string
  state?: string
  zip_code?: string
  avatar_url?: string
  contact_persona?: string
  preferred_contact_method?: string
  notes?: string
  metadata?: Record<string, any>
}

interface PortalSettingsPageProps {
  contact: Contact
  contactId: string
}

export default function PortalSettingsPage({ contact, contactId }: PortalSettingsPageProps) {
  // Both privacy controls below used to render with no onClick at all. These
  // are CCPA/CPRA and GDPR obligations with a statutory clock, so a control
  // that silently does nothing is worse than no control — the client believes
  // they have exercised a right.
  const [dsarPending, setDsarPending] = useState<"export" | "delete" | null>(null)
  const [dsarResult, setDsarResult] = useState<{ type: "export" | "delete"; dueDate?: string } | null>(null)
  const [dsarError, setDsarError] = useState<string | null>(null)

  async function fileRequest(requestType: "export" | "delete") {
    if (requestType === "delete" && !confirm(
      "This files a formal request to delete your account and personal data. Your brokerage must action it, and they will contact you to confirm. Continue?",
    )) return
    setDsarPending(requestType)
    setDsarError(null)
    try {
      const res = await fileDataSubjectRequestFromPortal({ contactId, requestType })
      if (!res.success) {
        setDsarError(res.error ?? "We could not file that request. Please contact your agent.")
        return
      }
      setDsarResult({ type: requestType, dueDate: res.dueDate })
    } finally {
      setDsarPending(null)
    }
  }

  const router = useRouter()
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [photoMsg, setPhotoMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // The 2MB limit is enforced HERE as well as advertised below the button.
  // Without it the file goes to storage, Supabase rejects it, and the client
  // sees a raw provider error for a rule we already told them about.
  const MAX_AVATAR_BYTES = 2 * 1024 * 1024

  const handlePhotoUpload = async (file: File) => {
    setPhotoMsg(null)
    if (file.size > MAX_AVATAR_BYTES) {
      setPhotoMsg({ ok: false, text: "That image is over 2MB. Pick a smaller one." })
      return
    }
    setUploadingPhoto(true)
    const res = await uploadProfilePhoto(contact.id, file)
    setUploadingPhoto(false)
    // Returns { success, url, error } and never throws — read it.
    if (res.success) {
      setPhotoMsg({ ok: true, text: "Photo updated." })
      router.refresh()
    } else {
      setPhotoMsg({ ok: false, text: res.error ?? "That photo could not be uploaded." })
    }
  }

  const [isSaving, setIsSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Profile form state
  const [firstName, setFirstName] = useState(contact.first_name || "")
  const [lastName, setLastName] = useState(contact.last_name || "")
  const [email, setEmail] = useState(contact.email || "")
  const [phone, setPhone] = useState(contact.phone || "")
  const [address, setAddress] = useState(contact.address || "")
  const [city, setCity] = useState(contact.city || "")
  const [state, setState] = useState(contact.state || "")
  const [zipCode, setZipCode] = useState(contact.zip_code || "")
  const [preferredContact, setPreferredContact] = useState(contact.preferred_contact_method || "email")

  // Notification preferences — HYDRATED from the buyer's saved choices (contacts.metadata), so the
  // panel reflects reality. A missing key falls back to its sensible default (opt-in for service
  // updates, opt-out for marketing). These are enforced server-side at every buyer-facing send.
  const savedPrefs = (() => {
    const md = typeof contact.metadata === "string"
      ? (() => { try { return JSON.parse(contact.metadata as any) } catch { return {} } })()
      : (contact.metadata ?? {})
    return (md?.notification_preferences ?? {}) as Record<string, boolean | undefined>
  })()
  const pref = (key: string, dflt: boolean) => (typeof savedPrefs[key] === "boolean" ? (savedPrefs[key] as boolean) : dflt)

  const [emailNotifications, setEmailNotifications] = useState(pref("email", true))
  const [smsNotifications, setSmsNotifications] = useState(pref("sms", true))
  const [pushNotifications, setPushNotifications] = useState(pref("push", false))
  const [marketingEmails, setMarketingEmails] = useState(pref("marketing", false))
  const [showingReminders, setShowingReminders] = useState(pref("showing_reminders", true))
  const [offerUpdates, setOfferUpdates] = useState(pref("offer_updates", true))
  const [documentAlerts, setDocumentAlerts] = useState(pref("document_alerts", true))
  const [weeklyDigest, setWeeklyDigest] = useState(pref("weekly_digest", true))

  const displayName = firstName ? `${firstName} ${lastName}`.trim() : contact.name || "User"

  const initials = displayName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2)

  const handleSaveProfile = async () => {
    setIsSaving(true)
    setSaveSuccess(false)
    setSaveError(null)

    try {
      const result = await updateContactProfile(contactId, {
        first_name: firstName,
        last_name: lastName,
        email,
        phone,
        address,
        city,
        state,
        zip_code: zipCode,
        preferred_contact_method: preferredContact,
      })

      if (result.success) {
        setSaveSuccess(true)
        setTimeout(() => setSaveSuccess(false), 3000)
        router.refresh()
      } else {
        setSaveError(result.error || "Failed to save changes")
      }
    } catch (error) {
      setSaveError("An unexpected error occurred")
    } finally {
      setIsSaving(false)
    }
  }

  const handleSaveNotifications = async () => {
    setIsSaving(true)
    setSaveSuccess(false)
    setSaveError(null)

    try {
      const result = await updateContactProfile(contactId, {
        metadata: {
          ...contact.metadata,
          notification_preferences: {
            email: emailNotifications,
            sms: smsNotifications,
            push: pushNotifications,
            marketing: marketingEmails,
            showing_reminders: showingReminders,
            offer_updates: offerUpdates,
            document_alerts: documentAlerts,
            weekly_digest: weeklyDigest,
          },
        },
      })

      if (result.success) {
        setSaveSuccess(true)
        setTimeout(() => setSaveSuccess(false), 3000)
      } else {
        setSaveError(result.error || "Failed to save notification preferences")
      }
    } catch (error) {
      setSaveError("An unexpected error occurred")
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href={`/portal/${contactId}`}>
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">Settings</h1>
            <p className="text-muted-foreground">Manage your profile and preferences</p>
          </div>
        </div>
        {saveSuccess && (
          <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
            <Check className="h-3 w-3 mr-1" />
            Changes saved
          </Badge>
        )}
        {saveError && (
          <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">
            <AlertCircle className="h-3 w-3 mr-1" />
            {saveError}
          </Badge>
        )}
      </div>

      <Tabs defaultValue="profile" className="space-y-6">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="profile" className="flex items-center gap-2">
            <User className="h-4 w-4" />
            Profile
          </TabsTrigger>
          <TabsTrigger value="notifications" className="flex items-center gap-2">
            <Bell className="h-4 w-4" />
            Notifications
          </TabsTrigger>
          <TabsTrigger value="privacy" className="flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Privacy
          </TabsTrigger>
        </TabsList>

        {/* Profile Tab */}
        <TabsContent value="profile" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Profile Picture</CardTitle>
              <CardDescription>Update your profile photo</CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-6">
              <Avatar className="h-24 w-24">
                <AvatarImage src={contact.avatar_url || "/placeholder.svg"} alt={displayName} />
                <AvatarFallback className="bg-primary text-primary-foreground text-2xl">{initials}</AvatarFallback>
              </Avatar>
              {/* Had no onClick, no file input, nothing. uploadProfilePhoto was
                  complete — storage upload, signed URL for the private bucket,
                  contact row update — with ZERO callers, and this file already
                  imported two of its siblings from the same module. */}
              <div className="space-y-2">
                <label htmlFor="portal-avatar-input">
                  <Button variant="outline" size="sm" asChild>
                    <span className="cursor-pointer">
                      <Camera className="h-4 w-4 mr-2" />
                      {uploadingPhoto ? "Uploading…" : "Upload Photo"}
                    </span>
                  </Button>
                </label>
                <input
                  id="portal-avatar-input"
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  className="hidden"
                  disabled={uploadingPhoto}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) handlePhotoUpload(f)
                  }}
                />
                <p className="text-xs text-muted-foreground">JPG, PNG or GIF. Max size 2MB.</p>
                {photoMsg && (
                  <p className={`text-xs ${photoMsg.ok ? "text-emerald-600" : "text-destructive"}`}>
                    {photoMsg.text}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Personal Information</CardTitle>
              <CardDescription>Update your personal details</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="firstName">First Name</Label>
                  <Input
                    id="firstName"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="Enter first name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">Last Name</Label>
                  <Input
                    id="lastName"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Enter last name"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email Address</Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="your@email.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone Number</Label>
                  <Input
                    id="phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="(555) 123-4567"
                  />
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <Label htmlFor="address">Street Address</Label>
                <Input
                  id="address"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="123 Main Street"
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="city">City</Label>
                  <Input id="city" value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="state">State</Label>
                  <Input id="state" value={state} onChange={(e) => setState(e.target.value)} placeholder="State" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="zipCode">ZIP Code</Label>
                  <Input
                    id="zipCode"
                    value={zipCode}
                    onChange={(e) => setZipCode(e.target.value)}
                    placeholder="12345"
                  />
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <Label>Preferred Contact Method</Label>
                <div className="flex gap-4">
                  <Button
                    type="button"
                    variant={preferredContact === "email" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setPreferredContact("email")}
                  >
                    <Mail className="h-4 w-4 mr-2" />
                    Email
                  </Button>
                  <Button
                    type="button"
                    variant={preferredContact === "phone" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setPreferredContact("phone")}
                  >
                    <Smartphone className="h-4 w-4 mr-2" />
                    Phone
                  </Button>
                  <Button
                    type="button"
                    variant={preferredContact === "text" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setPreferredContact("text")}
                  >
                    <Smartphone className="h-4 w-4 mr-2" />
                    Text
                  </Button>
                </div>
              </div>

              <div className="flex justify-end pt-4">
                <Button onClick={handleSaveProfile} disabled={isSaving}>
                  <Save className="h-4 w-4 mr-2" />
                  {isSaving ? "Saving..." : "Save Changes"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Notifications Tab */}
        <TabsContent value="notifications" id="notifications" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Communication Preferences</CardTitle>
              <CardDescription>Choose how you want to receive updates</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base">Email Notifications</Label>
                  <p className="text-sm text-muted-foreground">Receive updates via email</p>
                </div>
                <Switch checked={emailNotifications} onCheckedChange={setEmailNotifications} />
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base">SMS Notifications</Label>
                  <p className="text-sm text-muted-foreground">Receive text message alerts</p>
                </div>
                <Switch checked={smsNotifications} onCheckedChange={setSmsNotifications} />
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base">Push Notifications</Label>
                  <p className="text-sm text-muted-foreground">Receive browser push notifications</p>
                </div>
                <Switch checked={pushNotifications} onCheckedChange={setPushNotifications} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Alert Types</CardTitle>
              <CardDescription>Choose which updates you want to receive</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base">Showing Reminders</Label>
                  <p className="text-sm text-muted-foreground">Get reminders before scheduled showings</p>
                </div>
                <Switch checked={showingReminders} onCheckedChange={setShowingReminders} />
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base">Offer Updates</Label>
                  <p className="text-sm text-muted-foreground">Notifications about offer status changes</p>
                </div>
                <Switch checked={offerUpdates} onCheckedChange={setOfferUpdates} />
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base">Document Alerts</Label>
                  <p className="text-sm text-muted-foreground">Alerts when new documents are available</p>
                </div>
                <Switch checked={documentAlerts} onCheckedChange={setDocumentAlerts} />
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base">Weekly Digest</Label>
                  <p className="text-sm text-muted-foreground">Weekly summary of your activity</p>
                </div>
                <Switch checked={weeklyDigest} onCheckedChange={setWeeklyDigest} />
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base">Marketing Emails</Label>
                  <p className="text-sm text-muted-foreground">News, tips, and promotional content</p>
                </div>
                <Switch checked={marketingEmails} onCheckedChange={setMarketingEmails} />
              </div>

              <div className="flex justify-end pt-4">
                <Button onClick={handleSaveNotifications} disabled={isSaving}>
                  <Save className="h-4 w-4 mr-2" />
                  {isSaving ? "Saving..." : "Save Preferences"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Privacy Tab */}
        <TabsContent value="privacy" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Privacy Settings</CardTitle>
              <CardDescription>Control your data and privacy preferences</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-base">Share Activity with Agent</Label>
                  <p className="text-sm text-muted-foreground">Allow your agent to see your property search activity</p>
                </div>
                <Switch defaultChecked />
              </div>

              <Separator />

              {/* Family Search Visibility - Only for family-oriented personas */}
              {["first_time_buyer", "military_buyer", "upsizing", "relocating"].includes(contact.contact_persona || "") && (
                <>
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label className="text-base">Family Search Visibility</Label>
                      <p className="text-sm text-muted-foreground">Allow family members to see your ratings and comments</p>
                    </div>
                    <Switch defaultChecked />
                  </div>

                  <Separator />
                </>
              )}

              <div className="space-y-4">
                <div className="space-y-0.5">
                  <Label className="text-base">Download Your Data</Label>
                  <p className="text-sm text-muted-foreground">
                    Get a copy of all your data including documents, messages, and activity
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileRequest("export")}
                  disabled={dsarPending !== null || dsarResult?.type === "export"}
                >
                  {dsarPending === "export"
                    ? "Filing request..."
                    : dsarResult?.type === "export"
                      ? "Request filed"
                      : "Request Data Export"}
                </Button>
              </div>

              <Separator />

              <div className="space-y-4">
                <div className="space-y-0.5">
                  <Label className="text-base text-destructive">Delete Account</Label>
                  <p className="text-sm text-muted-foreground">
                    Permanently delete your account and all associated data
                  </p>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => fileRequest("delete")}
                  disabled={dsarPending !== null || dsarResult?.type === "delete"}
                >
                  {dsarPending === "delete"
                    ? "Filing request..."
                    : dsarResult?.type === "delete"
                      ? "Request filed"
                      : "Delete Account"}
                </Button>

                {/* Say what actually happens. Deletion is a governed, audited
                    act with a human in the loop — the button files a request,
                    it does not erase anything on the spot, and pretending
                    otherwise would be the same lie in the other direction. */}
                {dsarResult && (
                  <p className="text-sm text-green-700">
                    Your {dsarResult.type === "delete" ? "deletion" : "data export"} request has been
                    filed{dsarResult.dueDate ? ` and is due by ${new Date(dsarResult.dueDate).toLocaleDateString()}` : ""}.
                    Your brokerage has been notified and will contact you.
                  </p>
                )}
                {dsarError && <p className="text-sm text-destructive">{dsarError}</p>}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
