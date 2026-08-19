"use client"

/**
 * app/components/contact/ContactChannelControls.tsx
 *
 * Contact-level channel preference panel rendered on the contact/lead record.
 * Controls:
 *   - Preferred outreach channel (email, sms, phone, direct_mail, social platforms)
 *   - Social handles (facebook, instagram, linkedin, twitter)
 *   - Call stop flag — kill switch blocking all inbound + outbound calls
 *
 * Persists via updateChannelControls server action.
 * Renders as a compact panel suitable for sidebar or tab use.
 */

import { useEffect, useState, useTransition } from "react"
import { PhoneOff, Phone, Mail, MessageSquare, MapPin, Facebook, Instagram, Linkedin, Twitter, ChevronDown, Save, Loader2, AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  updateChannelControls,
  getContactChannelControls,
  type PreferredChannel,
  type SocialHandles,
} from "@/app/actions/contacts/update-channel-controls"

// ─── CHANNEL OPTIONS ──────────────────────────────────────────────────────────

const CHANNEL_OPTIONS: {
  value: PreferredChannel
  label: string
  icon: React.ReactNode
  description: string
}[] = [
  {
    value: "email",
    label: "Email",
    icon: <Mail size={14} />,
    description: "Send AI-personalized email first",
  },
  {
    value: "sms",
    label: "SMS",
    icon: <MessageSquare size={14} />,
    description: "Text message outreach (requires TCPA consent)",
  },
  {
    value: "phone",
    label: "Phone call",
    icon: <Phone size={14} />,
    description: "AI ISA voice call",
  },
  {
    value: "direct_mail",
    label: "Direct mail",
    icon: <MapPin size={14} />,
    description: "Physical mailer — requires address on file",
  },
  {
    value: "facebook",
    label: "Facebook",
    icon: <Facebook size={14} />,
    description: "Facebook DM or Messenger",
  },
  {
    value: "instagram",
    label: "Instagram",
    icon: <Instagram size={14} />,
    description: "Instagram DM",
  },
  {
    value: "linkedin",
    label: "LinkedIn",
    icon: <Linkedin size={14} />,
    description: "LinkedIn message",
  },
]

// ─── PROPS ────────────────────────────────────────────────────────────────────

interface ContactChannelControlsProps {
  contactId: string
  initialPreferredChannel?: PreferredChannel | null
  initialSocialHandles?: SocialHandles | null
  initialCallStopFlag?: boolean
  onSaved?: () => void
}

// ─── COMPONENT ────────────────────────────────────────────────────────────────

export default function ContactChannelControls({
  contactId,
  initialPreferredChannel,
  initialSocialHandles,
  initialCallStopFlag = false,
  onSaved,
}: ContactChannelControlsProps) {
  const [preferredChannel, setPreferredChannel] = useState<PreferredChannel>(
    initialPreferredChannel ?? "email"
  )
  const [socialHandles, setSocialHandles] = useState<SocialHandles>(
    initialSocialHandles ?? {}
  )
  const [callStopFlag, setCallStopFlag] = useState(initialCallStopFlag)
  const [showSocialForm, setShowSocialForm] = useState(false)
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [isPending, startTransition] = useTransition()

  const isSocialChannel = ["facebook", "instagram", "linkedin", "twitter"].includes(
    preferredChannel
  )

  // ── HYDRATE FROM THE RECORD ────────────────────────────────────────────────
  //
  // THE WRITE HALF OF THIS PANEL WAS LIVE AND THE READ HALF WAS NOT.
  // `getContactChannelControls` — the read written for exactly this component —
  // had no caller, and the only mount (the inbox ContactDetailPane) feeds
  // `initialPreferredChannel` / `initialSocialHandles` from a `conversations`
  // query that selects NEITHER column. So both props arrived undefined on every
  // render and the panel opened on its "email" / no-handles defaults for every
  // contact, whatever was actually stored — and pressing Save then WROTE those
  // defaults back over the contact's real preference.
  //
  // The server read is the authority. The initial* props are kept as the
  // pre-hydration paint only. Hydration runs once per contactId — Save is
  // disabled until it lands, so the defaults can no longer be written back
  // over a real preference by someone who clicked before the read returned.
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    let cancelled = false
    setHydrated(false)
    void (async () => {
      const current = await getContactChannelControls(contactId)
      if (cancelled) return
      // The action returns all-nulls both for "no such preference" and for a
      // refused read. Neither is a reason to overwrite what the caller passed
      // in, so a null field leaves the prop-derived value standing.
      if (current.preferredChannel) setPreferredChannel(current.preferredChannel)
      if (current.socialHandles) setSocialHandles(current.socialHandles)
      setCallStopFlag(current.callStopFlag)
      setHydrated(true)
    })()
    return () => {
      cancelled = true
    }
    // `dirty` is deliberately NOT a dependency — re-running on every keystroke
    // is what would clobber the edit this guard exists to protect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId])

  function handleSave() {
    startTransition(async () => {
      const result = await updateChannelControls({
        contactId,
        preferredChannel,
        socialHandles,
        callStopFlag,
      })
      setSaveMsg(
        result.success
          ? { ok: true, text: "Channel preferences saved." }
          : { ok: false, text: result.error ?? "Save failed." }
      )
      setTimeout(() => setSaveMsg(null), 3000)
      if (result.success) onSaved?.()
    })
  }

  return (
    <div className="space-y-4 font-sans">
      {/* ── Call Stop Toggle ─────────────────────────────────────────────── */}
      <div
        className={cn(
          "flex items-start gap-3 rounded-lg border p-3 transition-colors",
          callStopFlag
            ? "border-destructive/40 bg-destructive/5"
            : "border-border bg-muted/30"
        )}
      >
        <button
          type="button"
          role="switch"
          aria-checked={callStopFlag}
          onClick={() => setCallStopFlag((v) => !v)}
          className={cn(
            "mt-0.5 relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            callStopFlag
              ? "border-destructive bg-destructive"
              : "border-border bg-background"
          )}
        >
          <span
            className={cn(
              "pointer-events-none block h-4 w-4 rounded-full bg-white shadow-md transition-transform",
              callStopFlag ? "translate-x-4" : "translate-x-0"
            )}
          />
          <span className="sr-only">Toggle call stop</span>
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {callStopFlag ? (
              <PhoneOff size={13} className="text-destructive shrink-0" />
            ) : (
              <Phone size={13} className="text-muted-foreground shrink-0" />
            )}
            <p className="text-xs font-semibold text-foreground">
              {callStopFlag ? "Calls stopped" : "Calls allowed"}
            </p>
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">
            {callStopFlag
              ? "All inbound and outbound AI calls are blocked for this contact. Toggle off to resume calling."
              : "AI ISA can place and receive calls with this contact."}
          </p>
          {callStopFlag && (
            <div className="flex items-center gap-1 mt-1.5">
              <AlertTriangle size={11} className="text-destructive shrink-0" />
              <span className="text-[10px] text-destructive font-medium">
                TCPA / DNC compliance: call stop is logged to the audit trail.
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Preferred Channel Selector ───────────────────────────────────── */}
      <div>
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          Preferred outreach channel
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          {CHANNEL_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                setPreferredChannel(opt.value)
                if (["facebook", "instagram", "linkedin", "twitter"].includes(opt.value)) {
                  setShowSocialForm(true)
                }
              }}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[11px] transition-colors",
                preferredChannel === opt.value
                  ? "border-primary/60 bg-primary/8 text-primary font-medium"
                  : "border-border bg-background text-foreground hover:bg-muted"
              )}
            >
              <span
                className={cn(
                  "shrink-0",
                  preferredChannel === opt.value
                    ? "text-primary"
                    : "text-muted-foreground"
                )}
              >
                {opt.icon}
              </span>
              <span className="truncate">{opt.label}</span>
            </button>
          ))}
        </div>
        {CHANNEL_OPTIONS.find((o) => o.value === preferredChannel) && (
          <p className="text-[10px] text-muted-foreground mt-1.5 leading-relaxed">
            {CHANNEL_OPTIONS.find((o) => o.value === preferredChannel)!.description}
          </p>
        )}
      </div>

      {/* ── Social Handles Form ──────────────────────────────────────────── */}
      {(isSocialChannel || showSocialForm) && (
        <div>
          <button
            type="button"
            onClick={() => setShowSocialForm((v) => !v)}
            className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2"
          >
            Social handles
            <ChevronDown
              size={11}
              className={cn("transition-transform", showSocialForm ? "rotate-180" : "")}
            />
          </button>

          {showSocialForm && (
            <div className="space-y-2">
              {(
                [
                  { key: "facebook", icon: <Facebook size={12} />, placeholder: "facebook.com/username" },
                  { key: "instagram", icon: <Instagram size={12} />, placeholder: "@username" },
                  { key: "linkedin", icon: <Linkedin size={12} />, placeholder: "linkedin.com/in/username" },
                  { key: "twitter", icon: <Twitter size={12} />, placeholder: "@username" },
                ] as const
              ).map((item) => (
                <div key={item.key} className="flex items-center gap-2">
                  <span className="shrink-0 text-muted-foreground w-4">{item.icon}</span>
                  <input
                    type="text"
                    value={socialHandles[item.key] ?? ""}
                    onChange={(e) =>
                      setSocialHandles((prev) => ({
                        ...prev,
                        [item.key]: e.target.value,
                      }))
                    }
                    placeholder={item.placeholder}
                    className="flex-1 min-w-0 rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Save Button + Status ─────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={isPending || !hydrated}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {isPending || !hydrated ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Save size={12} />
          )}
          {hydrated ? "Save preferences" : "Loading preferences…"}
        </button>

        {saveMsg && (
          <p
            className={cn(
              "text-[11px] font-medium",
              saveMsg.ok ? "text-green-600" : "text-destructive"
            )}
          >
            {saveMsg.text}
          </p>
        )}
      </div>
    </div>
  )
}
