"use client"

import { useState } from "react"
import type {
  ContactType,
  ContactPersona,
  ContactTimeline,
  ContactSource,
  ContactStatus,
  ContactFormData,
  PropertyInterest,
} from "@/types/contact"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  User,
  Mail,
  Phone,
  Building,
  Clock,
  FileText,
  ChevronLeft,
  ChevronRight,
  Check,
  AlertCircle,
  DollarSign,
  Home,
  TrendingUp,
  Briefcase,
} from "lucide-react"

interface ContactFormProps {
  initialData?: Partial<ContactFormData>
  onSubmit: (data: ContactFormData) => Promise<void>
  onCancel?: () => void
  isEditing?: boolean
}

const CONTACT_TYPES: { value: ContactType; label: string; description: string }[] = [
  { value: "buyer", label: "Buyer", description: "Looking to purchase property" },
  { value: "seller", label: "Seller", description: "Looking to sell property" },
  { value: "investor", label: "Investor", description: "Investment properties" },
  { value: "lender", label: "Lender", description: "Loan officer / Lender" },
  { value: "commercial", label: "Commercial", description: "Commercial property" },
  { value: "agent", label: "Agent", description: "Partner agent" },
  { value: "vendor", label: "Vendor", description: "Service vendor" },
  { value: "TC", label: "TC", description: "Transaction Coordinator" },
  { value: "other", label: "Other", description: "Other contact" },
]

const CONTACT_PERSONAS: { value: ContactPersona; label: string; description: string; forTypes: ContactType[] }[] = [
  { value: "first_time_buyer", label: "First-Time Buyer", description: "Never owned before", forTypes: ["buyer"] },
  { value: "luxury_buyer", label: "Luxury Buyer", description: "High-end purchase", forTypes: ["buyer"] },
  { value: "upsizers", label: "Upsizers", description: "Buying larger property", forTypes: ["buyer"] },
  {
    value: "relocating",
    label: "Relocating",
    description: "Moving for job/life change",
    forTypes: ["buyer", "seller"],
  },
  { value: "investor", label: "Investor", description: "Investment focused", forTypes: ["investor"] },
  { value: "first_time_seller", label: "First-Time Seller", description: "First time selling", forTypes: ["seller"] },
  { value: "luxury_seller", label: "Luxury Seller", description: "High-end property sale", forTypes: ["seller"] },
  { value: "motivated_seller", label: "Motivated Seller", description: "Needs to sell quickly", forTypes: ["seller"] },
  { value: "empty_nester", label: "Empty Nester", description: "Downsizing", forTypes: ["seller", "buyer"] },
  { value: "probate", label: "Probate", description: "Inherited property", forTypes: ["seller"] },
  { value: "remote_seller", label: "Remote Seller", description: "Selling from distance", forTypes: ["seller"] },
  { value: "divorce", label: "Divorce", description: "Divorce-related sale", forTypes: ["seller"] },
  { value: "senior", label: "Senior", description: "Senior citizen needs", forTypes: ["seller", "buyer"] },
  { value: "expired", label: "Expired Listing", description: "Expired listing owner", forTypes: ["seller"] },
  { value: "fsbo", label: "FSBO", description: "For Sale By Owner", forTypes: ["seller"] },
  {
    value: "other",
    label: "Other",
    description: "Other persona",
    forTypes: ["buyer", "seller", "investor", "lender", "commercial", "agent", "vendor", "TC", "other"],
  },
]

const TIMELINES: { value: ContactTimeline; label: string; color: string; urgency: string }[] = [
  { value: "0-3_months", label: "0-3 Months", color: "bg-red-500", urgency: "URGENT" },
  { value: "3-6_months", label: "3-6 Months", color: "bg-amber-500", urgency: "SOON" },
  { value: "6-12_months", label: "6-12 Months", color: "bg-blue-500", urgency: "PLANNING" },
  { value: "12+_months", label: "12+ Months", color: "bg-slate-400", urgency: "LONG-TERM" },
]

const SOURCES: { value: ContactSource; label: string }[] = [
  { value: "website", label: "Website" },
  { value: "referral", label: "Referral" },
  { value: "cold_call", label: "Cold Call" },
  { value: "social", label: "Social Media" },
  { value: "zillow", label: "Zillow" },
  { value: "realtor.com", label: "Realtor.com" },
  { value: "other", label: "Other" },
]

const STATUSES: { value: ContactStatus; label: string }[] = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "qualified", label: "Qualified" },
  { value: "appointment_booked", label: "Appointment Booked" },
  { value: "signed_agreement", label: "Signed Agreement" },
  { value: "pre_listing", label: "Pre-Listing" },
  { value: "active_listing", label: "Active Listing" },
  { value: "contingent", label: "Contingent" },
  { value: "pending", label: "Pending" },
  { value: "sold", label: "Sold" },
  { value: "lifetime_customer", label: "Lifetime Customer" },
]

export function ContactForm({ initialData, onSubmit, onCancel, isEditing }: ContactFormProps) {
  const [step, setStep] = useState(1)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const [formData, setFormData] = useState<ContactFormData>({
    first_name: initialData?.first_name || "",
    last_name: initialData?.last_name || "",
    email: initialData?.email || "",
    phone: initialData?.phone || "",
    contact_type: initialData?.contact_type || "buyer",
    contact_persona: initialData?.contact_persona || "first_time_buyer",
    timeline: initialData?.timeline || "3-6_months",
    source: initialData?.source || "website",
    status: initialData?.status || "new",
    notes: initialData?.notes || "",
    property_interest: initialData?.property_interest || {},
  })

  const filteredPersonas = CONTACT_PERSONAS.filter((p) => p.forTypes.includes(formData.contact_type))

  const updateField = (field: keyof ContactFormData, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
    if (errors[field]) {
      setErrors((prev) => {
        const newErrors = { ...prev }
        delete newErrors[field]
        return newErrors
      })
    }
  }

  const updatePropertyInterest = (field: keyof PropertyInterest, value: any) => {
    setFormData((prev) => ({
      ...prev,
      property_interest: { ...prev.property_interest, [field]: value },
    }))
  }

  const validateStep = (stepNum: number): boolean => {
    const newErrors: Record<string, string> = {}

    if (stepNum === 1) {
      if (!formData.first_name.trim()) newErrors.first_name = "First name is required"
      if (!formData.last_name.trim()) newErrors.last_name = "Last name is required"
      if (!formData.email.trim()) newErrors.email = "Email is required"
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) newErrors.email = "Invalid email format"
      if (!formData.phone?.trim()) newErrors.phone = "Phone is required"
    }

    if (stepNum === 2) {
      if (!formData.contact_type) newErrors.contact_type = "Contact type is required"
      if (!formData.contact_persona) newErrors.contact_persona = "Persona is required"
      if (!formData.timeline) newErrors.timeline = "Timeline is required"
      if (!formData.source) newErrors.source = "Source is required"
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const nextStep = () => {
    if (validateStep(step)) {
      setStep((s) => Math.min(s + 1, 5))
    }
  }

  const prevStep = () => setStep((s) => Math.max(s - 1, 1))

  const handleSubmit = async () => {
    if (!validateStep(step)) return

    setIsSubmitting(true)
    try {
      await onSubmit(formData)
    } catch (error) {
      console.error("Error submitting contact:", error)
    } finally {
      setIsSubmitting(false)
    }
  }

  const getPersonaDashboardPreview = () => {
    const persona = formData.contact_persona
    const dashboardMap: Record<ContactPersona, string> = {
      first_time_buyer:
        "First-Time Buyer Dashboard with education resources, mortgage calculator, and step-by-step guides",
      luxury_buyer: "Luxury Buyer Dashboard with exclusive listings, market insights, and concierge services",
      luxury_seller: "Luxury Seller Dashboard with premium marketing, price analysis, and high-end staging",
      investor: "Investor Dashboard with ROI calculators, portfolio tracking, and market analysis",
      first_time_seller: "First-Time Seller Dashboard with selling guides, pricing tools, and preparation checklists",
      motivated_seller:
        "Motivated Seller Dashboard with fast-track timeline, urgent prep tips, and quick-sale strategies",
      relocating: "Relocating Dashboard with neighborhood research, school finder, and cost comparison tools",
      empty_nester: "Empty Nester Dashboard with downsizing guides and community options",
      probate: "Probate Dashboard with estate process guidance, timeline tracking, and specialized resources",
      remote_seller: "Remote Seller Dashboard with virtual tools, digital signing, and video updates",
      divorce: "Divorce Dashboard with confidential guidance, neutral valuation, and discrete options",
      upsizers: "Upsizers Dashboard with larger home search, space planning, and upgrade analysis",
      senior: "Senior Dashboard with accessible design, retirement community options, and estate planning",
      expired: "Expired Listing Dashboard with market analysis, new strategy, and improvement recommendations",
      fsbo: "FSBO Dashboard with professional comparison, hybrid options, and DIY resources",
      other: "Default Contact Dashboard with agent info and general resources",
    }
    return dashboardMap[persona] || "Default Contact Dashboard"
  }

  return (
    <Card className="w-full max-w-3xl mx-auto">
      <CardHeader>
        <CardTitle>{isEditing ? "Edit Contact" : "Create New Contact"}</CardTitle>
        <CardDescription>
          Step {step} of 5 - {["Basic Info", "Classification", "Details", "Additional Info", "Review"][step - 1]}
        </CardDescription>
        {/* Step indicators */}
        <div className="flex gap-2 mt-4">
          {[1, 2, 3, 4, 5].map((s) => (
            <div
              key={s}
              className={`h-2 flex-1 rounded-full transition-colors ${
                s < step ? "bg-green-500" : s === step ? "bg-blue-500" : "bg-slate-200"
              }`}
            />
          ))}
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Step 1: Basic Info */}
        {step === 1 && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="first_name" className="flex items-center gap-2">
                  <User className="w-4 h-4" /> First Name *
                </Label>
                <Input
                  id="first_name"
                  value={formData.first_name}
                  onChange={(e) => updateField("first_name", e.target.value)}
                  className={errors.first_name ? "border-red-500" : ""}
                />
                {errors.first_name && (
                  <p className="text-sm text-red-500 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" /> {errors.first_name}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="last_name">Last Name *</Label>
                <Input
                  id="last_name"
                  value={formData.last_name}
                  onChange={(e) => updateField("last_name", e.target.value)}
                  className={errors.last_name ? "border-red-500" : ""}
                />
                {errors.last_name && (
                  <p className="text-sm text-red-500 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" /> {errors.last_name}
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email" className="flex items-center gap-2">
                <Mail className="w-4 h-4" /> Email *
              </Label>
              <Input
                id="email"
                type="email"
                value={formData.email}
                onChange={(e) => updateField("email", e.target.value)}
                className={errors.email ? "border-red-500" : ""}
              />
              {errors.email && (
                <p className="text-sm text-red-500 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" /> {errors.email}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone" className="flex items-center gap-2">
                <Phone className="w-4 h-4" /> Phone *
              </Label>
              <Input
                id="phone"
                type="tel"
                value={formData.phone}
                onChange={(e) => updateField("phone", e.target.value)}
                className={errors.phone ? "border-red-500" : ""}
              />
              {errors.phone && (
                <p className="text-sm text-red-500 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" /> {errors.phone}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Step 2: Classification */}
        {step === 2 && (
          <div className="space-y-6">
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Briefcase className="w-4 h-4" /> Contact Type *
              </Label>
              <div className="grid grid-cols-3 gap-2">
                {CONTACT_TYPES.map((type) => (
                  <button
                    key={type.value}
                    type="button"
                    onClick={() => {
                      updateField("contact_type", type.value)
                      // Reset persona if not valid for new type
                      const validPersonas = CONTACT_PERSONAS.filter((p) => p.forTypes.includes(type.value))
                      if (!validPersonas.find((p) => p.value === formData.contact_persona)) {
                        updateField("contact_persona", validPersonas[0]?.value || "other")
                      }
                    }}
                    className={`p-3 rounded-lg border text-left transition-all ${
                      formData.contact_type === type.value
                        ? "border-blue-500 bg-blue-50 ring-2 ring-blue-200"
                        : "border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <div className="font-medium text-sm">{type.label}</div>
                    <div className="text-xs text-slate-500">{type.description}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <User className="w-4 h-4" /> Persona *{" "}
                <span className="text-xs text-slate-500">(determines their dashboard)</span>
              </Label>
              <div className="grid grid-cols-2 gap-2 max-h-64 overflow-y-auto">
                {filteredPersonas.map((persona) => (
                  <button
                    key={persona.value}
                    type="button"
                    onClick={() => updateField("contact_persona", persona.value)}
                    className={`p-3 rounded-lg border text-left transition-all ${
                      formData.contact_persona === persona.value
                        ? "border-purple-500 bg-purple-50 ring-2 ring-purple-200"
                        : "border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <div className="font-medium text-sm">{persona.label}</div>
                    <div className="text-xs text-slate-500">{persona.description}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Clock className="w-4 h-4" /> Timeline *{" "}
                <span className="text-xs text-slate-500">(when they want to buy/sell)</span>
              </Label>
              <div className="grid grid-cols-2 gap-2">
                {TIMELINES.map((timeline) => (
                  <button
                    key={timeline.value}
                    type="button"
                    onClick={() => updateField("timeline", timeline.value)}
                    className={`p-3 rounded-lg border text-left transition-all ${
                      formData.timeline === timeline.value
                        ? "border-slate-800 bg-slate-50 ring-2 ring-slate-300"
                        : "border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <div className={`w-3 h-3 rounded-full ${timeline.color}`} />
                      <span className="font-medium text-sm">{timeline.label}</span>
                    </div>
                    <Badge variant="outline" className="mt-1 text-xs">
                      {timeline.urgency}
                    </Badge>
                  </button>
                ))}
              </div>
            </div>

            {/* CHANGE: Move source dropdown from Step 1 to Step 2 for better classification flow */}
            <div className="space-y-2">
              <Label htmlFor="source" className="flex items-center gap-2">
                <Building className="w-4 h-4" /> Source *
              </Label>
              <Select value={formData.source} onValueChange={(v) => updateField("source", v as ContactSource)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  {SOURCES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {/* Step 3: Dynamic Details based on contact_type */}
        {step === 3 && (
          <div className="space-y-4">
            <h3 className="font-medium text-lg">
              {formData.contact_type === "buyer" && "Buyer Details"}
              {formData.contact_type === "seller" && "Seller Details"}
              {formData.contact_type === "investor" && "Investor Details"}
              {formData.contact_type === "lender" && "Lender Details"}
              {!["buyer", "seller", "investor", "lender"].includes(formData.contact_type) && "Additional Details"}
            </h3>

            {formData.contact_type === "buyer" && (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="flex items-center gap-2">
                      <DollarSign className="w-4 h-4" /> Budget Min
                    </Label>
                    <Input
                      type="number"
                      placeholder="250000"
                      value={formData.property_interest?.budget_min || ""}
                      onChange={(e) =>
                        updatePropertyInterest("budget_min", Number.parseInt(e.target.value) || undefined)
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Budget Max</Label>
                    <Input
                      type="number"
                      placeholder="500000"
                      value={formData.property_interest?.budget_max || ""}
                      onChange={(e) =>
                        updatePropertyInterest("budget_max", Number.parseInt(e.target.value) || undefined)
                      }
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <Home className="w-4 h-4" /> Desired Neighborhoods
                  </Label>
                  <Input
                    placeholder="e.g., Downtown, Suburbs, Westside"
                    value={(formData.property_interest?.desired_neighborhoods || []).join(", ")}
                    onChange={(e) =>
                      updatePropertyInterest(
                        "desired_neighborhoods",
                        e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      )
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Property Type Preference</Label>
                  <Input
                    placeholder="e.g., Single Family, Condo, Townhouse"
                    value={(formData.property_interest?.property_type_preference || []).join(", ")}
                    onChange={(e) =>
                      updatePropertyInterest(
                        "property_type_preference",
                        e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      )
                    }
                  />
                </div>
              </>
            )}

            {formData.contact_type === "seller" && (
              <>
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <DollarSign className="w-4 h-4" /> Current Home Value (estimate)
                  </Label>
                  <Input
                    type="number"
                    placeholder="450000"
                    value={formData.property_interest?.current_home_value || ""}
                    onChange={(e) =>
                      updatePropertyInterest("current_home_value", Number.parseInt(e.target.value) || undefined)
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Reason for Selling</Label>
                  <Select
                    value={formData.property_interest?.reason_for_selling || ""}
                    onValueChange={(v) => updatePropertyInterest("reason_for_selling", v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select reason" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="relocating">Relocating</SelectItem>
                      <SelectItem value="downsizing">Downsizing</SelectItem>
                      <SelectItem value="upsizing">Upsizing</SelectItem>
                      <SelectItem value="financial">Financial Reasons</SelectItem>
                      <SelectItem value="divorce">Divorce</SelectItem>
                      <SelectItem value="estate">Estate/Probate</SelectItem>
                      <SelectItem value="investment">Investment</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Property Condition</Label>
                  <Select
                    value={formData.property_interest?.property_condition || ""}
                    onValueChange={(v) => updatePropertyInterest("property_condition", v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select condition" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="excellent">Excellent - Move-in Ready</SelectItem>
                      <SelectItem value="good">Good - Minor Updates Needed</SelectItem>
                      <SelectItem value="fair">Fair - Some Repairs Needed</SelectItem>
                      <SelectItem value="poor">Poor - Major Renovation Needed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}

            {formData.contact_type === "investor" && (
              <>
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <TrendingUp className="w-4 h-4" /> Investment Type
                  </Label>
                  <Select
                    value={formData.property_interest?.investment_type || ""}
                    onValueChange={(v) => updatePropertyInterest("investment_type", v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="rental">Rental Property</SelectItem>
                      <SelectItem value="flip">Fix & Flip</SelectItem>
                      <SelectItem value="commercial">Commercial</SelectItem>
                      <SelectItem value="multi_family">Multi-Family</SelectItem>
                      <SelectItem value="vacation">Vacation Rental</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Target ROI (%)</Label>
                  <Input
                    type="number"
                    placeholder="12"
                    value={formData.property_interest?.target_roi || ""}
                    onChange={(e) =>
                      updatePropertyInterest("target_roi", Number.parseFloat(e.target.value) || undefined)
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Experience Level</Label>
                  <Select
                    value={formData.property_interest?.experience_level || ""}
                    onValueChange={(v) => updatePropertyInterest("experience_level", v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select experience" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="first_time">First-Time Investor</SelectItem>
                      <SelectItem value="some">Some Experience (1-5 properties)</SelectItem>
                      <SelectItem value="experienced">Experienced (5+ properties)</SelectItem>
                      <SelectItem value="professional">Professional Investor</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}

            {formData.contact_type === "lender" && (
              <>
                <div className="space-y-2">
                  <Label>Company</Label>
                  <Input
                    placeholder="Mortgage company name"
                    value={formData.property_interest?.company || ""}
                    onChange={(e) => updatePropertyInterest("company", e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Loan Programs Offered</Label>
                  <Input
                    placeholder="e.g., FHA, VA, Conventional, Jumbo"
                    value={(formData.property_interest?.loan_programs || []).join(", ")}
                    onChange={(e) =>
                      updatePropertyInterest(
                        "loan_programs",
                        e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      )
                    }
                  />
                </div>
              </>
            )}
          </div>
        )}

        {/* Step 4: Additional Info */}
        {step === 4 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={formData.status} onValueChange={(v) => updateField("status", v as ContactStatus)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <FileText className="w-4 h-4" /> Notes
              </Label>
              <Textarea
                placeholder="Any additional notes about this contact..."
                value={formData.notes}
                onChange={(e) => updateField("notes", e.target.value)}
                rows={5}
              />
            </div>
          </div>
        )}

        {/* Step 5: Review */}
        {step === 5 && (
          <div className="space-y-6">
            <div className="bg-slate-50 rounded-lg p-4 space-y-3">
              <h3 className="font-semibold">Contact Summary</h3>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-slate-500">Name:</span>
                  <span className="ml-2 font-medium">
                    {formData.first_name} {formData.last_name}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500">Email:</span>
                  <span className="ml-2">{formData.email}</span>
                </div>
                <div>
                  <span className="text-slate-500">Phone:</span>
                  <span className="ml-2">{formData.phone}</span>
                </div>
                <div>
                  <span className="text-slate-500">Source:</span>
                  <span className="ml-2">{SOURCES.find((s) => s.value === formData.source)?.label}</span>
                </div>
              </div>
            </div>

            <div className="bg-blue-50 rounded-lg p-4 space-y-3">
              <h3 className="font-semibold">Classification</h3>
              <div className="flex flex-wrap gap-2">
                <Badge className="bg-blue-500">
                  {CONTACT_TYPES.find((t) => t.value === formData.contact_type)?.label}
                </Badge>
                <Badge className="bg-purple-500">
                  {CONTACT_PERSONAS.find((p) => p.value === formData.contact_persona)?.label}
                </Badge>
                <Badge className={TIMELINES.find((t) => t.value === formData.timeline)?.color}>
                  {TIMELINES.find((t) => t.value === formData.timeline)?.label}
                </Badge>
              </div>
            </div>

            <div className="bg-green-50 rounded-lg p-4 space-y-2">
              <h3 className="font-semibold flex items-center gap-2">
                <Check className="w-4 h-4 text-green-600" /> Dashboard Preview
              </h3>
              <p className="text-sm text-slate-600">{getPersonaDashboardPreview()}</p>
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="flex justify-between pt-4 border-t">
          <div>
            {step > 1 && (
              <Button variant="outline" onClick={prevStep}>
                <ChevronLeft className="w-4 h-4 mr-2" /> Back
              </Button>
            )}
            {onCancel && step === 1 && (
              <Button variant="outline" onClick={onCancel}>
                Cancel
              </Button>
            )}
          </div>
          <div>
            {step < 5 ? (
              <Button onClick={nextStep}>
                Next <ChevronRight className="w-4 h-4 ml-2" />
              </Button>
            ) : (
              <Button onClick={handleSubmit} disabled={isSubmitting}>
                {isSubmitting ? "Saving..." : isEditing ? "Update Contact" : "Create Contact"}
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
