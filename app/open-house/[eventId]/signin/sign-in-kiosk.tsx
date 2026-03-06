"use client"

import { useState, useRef, useEffect } from "react"
import { CheckCircle, User } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface Props {
  event: {
    id: string
    eventDate: string
    startTime: string | null
    endTime: string | null
    listing: {
      address: string
      city: string | null
      state: string | null
      zip: string | null
      list_price: number | null
    } | null
  }
  agent: { id: string; full_name: string | null; avatar_url: string | null; email: string | null } | null
  branding: { app_name: string | null; app_logo_url: string | null; primary_color: string | null; from_name: string | null } | null
}

const HEAR_ABOUT_OPTIONS = [
  { value: "yard_sign", label: "Yard Sign" },
  { value: "online", label: "Online" },
  { value: "agent_invitation", label: "Agent Invitation" },
  { value: "friend_family", label: "Friend / Family" },
  { value: "postcard", label: "Postcard" },
  { value: "other", label: "Other" },
]

type Step = "form" | "success"

export function SignInKiosk({ event, agent, branding }: Props) {
  const [step, setStep] = useState<Step>("form")
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [workingWithAgent, setWorkingWithAgent] = useState<boolean | null>(null)
  const [hearAboutUs, setHearAboutUs] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const primaryColor = branding?.primary_color ?? "#2563eb"
  const agentName = agent?.full_name ?? branding?.from_name ?? "Your Agent"

  const fmtDate = (d: string) =>
    new Date(d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })

  const resetForm = () => {
    setStep("form")
    setFirstName("")
    setLastName("")
    setEmail("")
    setPhone("")
    setWorkingWithAgent(null)
    setHearAboutUs(null)
    setError(null)
  }

  // Auto-reset 3 seconds after success
  useEffect(() => {
    if (step === "success") {
      resetTimerRef.current = setTimeout(resetForm, 3000)
    }
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    }
  }, [step])

  async function handleSubmit() {
    if (!firstName.trim() || !lastName.trim() || !email.trim() || workingWithAgent === null) {
      setError("Please fill in all required fields.")
      return
    }
    setError(null)
    setSubmitting(true)

    try {
      const res = await fetch("/api/open-house/attend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId: event.id,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          phone: phone.trim() || undefined,
          workingWithAgent,
          hearAboutUs: hearAboutUs ?? undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "Failed to submit. Please try again.")
      } else {
        setStep("success")
      }
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="min-h-screen w-full flex flex-col"
      style={{ backgroundColor: "#f8fafc" }}
    >
      {/* Branded header */}
      <header
        className="flex flex-col items-center gap-2 px-6 py-6 text-white"
        style={{ backgroundColor: primaryColor }}
      >
        {branding?.app_logo_url && (
          <img src={branding.app_logo_url} alt={branding.app_name ?? "Brokerage"} className="h-10 object-contain" />
        )}
        {event.listing && (
          <div className="text-center">
            <p className="text-sm font-medium opacity-90">Open House</p>
            <h1 className="text-xl font-bold leading-tight">{event.listing.address}</h1>
            {(event.listing.city || event.listing.state) && (
              <p className="text-sm opacity-80">
                {[event.listing.city, event.listing.state].filter(Boolean).join(", ")}
              </p>
            )}
            <p className="text-sm font-medium mt-1 opacity-90">
              {fmtDate(event.eventDate)}
              {event.startTime && event.endTime && ` · ${event.startTime} – ${event.endTime}`}
            </p>
          </div>
        )}
        {agent && (
          <div className="flex items-center gap-2 mt-2">
            {agent.avatar_url ? (
              <img src={agent.avatar_url} alt={agentName} className="h-8 w-8 rounded-full object-cover" />
            ) : (
              <div className="h-8 w-8 rounded-full bg-white/20 flex items-center justify-center">
                <User className="h-4 w-4 text-white" />
              </div>
            )}
            <span className="text-sm font-medium">{agentName}</span>
          </div>
        )}
      </header>

      {/* Main content */}
      <main className="flex-1 flex flex-col items-center justify-start px-4 py-8 max-w-xl mx-auto w-full">
        {step === "success" ? (
          <SuccessScreen agentName={agentName} />
        ) : (
          <div className="w-full flex flex-col gap-6">
            <h2 className="text-center text-lg font-semibold text-foreground">
              Sign In to Our Open House
            </h2>

            {/* Name row — side-by-side on tablet */}
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="flex-1 flex flex-col gap-2">
                <Label htmlFor="first-name" className="text-base">First Name *</Label>
                <Input
                  id="first-name"
                  className="h-14 text-lg"
                  placeholder="Jane"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  autoComplete="given-name"
                />
              </div>
              <div className="flex-1 flex flex-col gap-2">
                <Label htmlFor="last-name" className="text-base">Last Name *</Label>
                <Input
                  id="last-name"
                  className="h-14 text-lg"
                  placeholder="Smith"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  autoComplete="family-name"
                />
              </div>
            </div>

            {/* Email */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-base">Email *</Label>
              <Input
                id="email"
                type="email"
                className="h-14 text-lg"
                placeholder="jane@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                inputMode="email"
                autoComplete="email"
              />
            </div>

            {/* Phone */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="phone" className="text-base">Phone</Label>
              <Input
                id="phone"
                type="tel"
                className="h-14 text-lg"
                placeholder="(555) 000-0000"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="tel"
                autoComplete="tel"
              />
            </div>

            {/* Working with agent */}
            <div className="flex flex-col gap-3">
              <Label className="text-base">Are you working with a real estate agent? *</Label>
              <div className="flex gap-3">
                <BigToggle
                  label="Yes"
                  active={workingWithAgent === true}
                  onClick={() => setWorkingWithAgent(true)}
                  color={primaryColor}
                />
                <BigToggle
                  label="No"
                  active={workingWithAgent === false}
                  onClick={() => setWorkingWithAgent(false)}
                  color={primaryColor}
                />
              </div>
            </div>

            {/* How did you hear */}
            <div className="flex flex-col gap-3">
              <Label className="text-base">How did you hear about us?</Label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {HEAR_ABOUT_OPTIONS.map((opt) => (
                  <BigToggle
                    key={opt.value}
                    label={opt.label}
                    active={hearAboutUs === opt.value}
                    onClick={() => setHearAboutUs(hearAboutUs === opt.value ? null : opt.value)}
                    color={primaryColor}
                    small
                  />
                ))}
              </div>
            </div>

            {error && (
              <p className="text-sm text-destructive text-center">{error}</p>
            )}

            <Button
              className="h-16 text-lg w-full rounded-xl font-semibold"
              style={{ backgroundColor: primaryColor, color: "#fff" }}
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? "Submitting..." : "Sign In"}
            </Button>

            <p className="text-center text-xs text-muted-foreground leading-relaxed">
              Your info is kept private and used only by {agentName}.
            </p>
          </div>
        )}
      </main>
    </div>
  )
}

function BigToggle({
  label,
  active,
  onClick,
  color,
  small = false,
}: {
  label: string
  active: boolean
  onClick: () => void
  color: string
  small?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-xl border-2 font-semibold transition-all select-none ${
        small ? "h-12 text-sm" : "h-16 text-lg"
      } ${active ? "text-white" : "bg-background text-foreground border-border hover:bg-muted/50"}`}
      style={active ? { backgroundColor: color, borderColor: color } : {}}
    >
      {label}
    </button>
  )
}

function SuccessScreen({ agentName }: { agentName: string }) {
  return (
    <div className="flex flex-col items-center gap-6 py-16 text-center animate-in fade-in duration-300">
      <div className="flex h-24 w-24 items-center justify-center rounded-full bg-green-100">
        <CheckCircle className="h-14 w-14 text-green-600" />
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-bold text-foreground">Welcome!</h2>
        <p className="text-lg text-muted-foreground">Thank you for visiting.</p>
        <p className="text-sm text-muted-foreground mt-2">{agentName} will be in touch soon.</p>
      </div>
      <p className="text-xs text-muted-foreground mt-4 opacity-60">Form resets in 3 seconds...</p>
    </div>
  )
}
