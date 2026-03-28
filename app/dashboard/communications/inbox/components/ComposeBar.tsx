"use client"

import { useState, useTransition } from "react"
import { Send, Loader2, Sparkles, AlertTriangle, ChevronDown, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

type EmailTemplate = {
  id: string
  name: string
  subject?: string
  body?: string
  channel?: string
}

interface ComposeBarProps {
  conversationId: string
  agentId: string
  contactId: string
  channel: "email" | "sms" | "in_app"
  lifecycleState?: string
  /** null = unknown/not set, true = consented, false = explicitly not consented */
  tcpaConsent?: boolean | null
  emailTemplates?: EmailTemplate[]
  onSend: (body: string, subject?: string, channel?: string) => Promise<{ success: boolean; error?: string }>
  onDraft?: (content: string) => Promise<string>
  disabled?: boolean
}

/** These lifecycle states completely block AI ISA outreach — broker compliance rule */
const AUTHORITY_BLOCKED_STATES = ["representation", "active_transaction", "under_contract"]
/** These lifecycle states warn but still allow manual sends */
const WARNING_STATES: string[] = []

const CHANNEL_LABELS: Record<string, string> = {
  email:  "Email",
  sms:    "SMS",
  in_app: "In-App",
}

export default function ComposeBar({
  conversationId,
  agentId,
  contactId,
  channel: defaultChannel,
  lifecycleState,
  tcpaConsent,
  emailTemplates = [],
  onSend,
  onDraft,
  disabled,
}: ComposeBarProps) {
  const [body, setBody]           = useState("")
  const [subject, setSubject]     = useState("")
  // Sync channel when the selected conversation type changes
  const [channel, setChannel]     = useState<"email" | "sms" | "in_app">(defaultChannel)
  const [error, setError]         = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [isDrafting, setIsDrafting] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)

  // Keep channel in sync when conversation changes (different contact selected)
  const prevDefaultRef = useState(defaultChannel)
  if (prevDefaultRef[0] !== defaultChannel) {
    prevDefaultRef[0] = defaultChannel
    setChannel(defaultChannel)
  }

  const isAuthorityBlocked = AUTHORITY_BLOCKED_STATES.includes(lifecycleState ?? "")
  const isSMS = channel === "sms"
  // Hard TCPA block: only trigger when channel is SMS AND consent is explicitly false (not null/unknown)
  const isTCPABlocked = isSMS && tcpaConsent === false

  // Filter templates by channel
  const availableTemplates = emailTemplates.filter(
    t => !t.channel || t.channel === channel || t.channel === "all"
  )

  function applyTemplate(tpl: EmailTemplate) {
    if (tpl.subject) setSubject(tpl.subject)
    if (tpl.body)    setBody(tpl.body)
    setShowTemplates(false)
  }

  const handleSend = () => {
    if (!body.trim() || isPending || isAuthorityBlocked || isTCPABlocked) return
    setError(null)
    startTransition(async () => {
      const result = await onSend(body.trim(), subject.trim() || undefined, channel)
      if (result.success) {
        setBody("")
        setSubject("")
      } else {
        setError(result.error ?? "Failed to send")
      }
    })
  }

  const handleDraft = async () => {
    if (!onDraft || isDrafting) return
    setIsDrafting(true)
    try {
      const draft = await onDraft(body)
      setBody(draft)
    } finally {
      setIsDrafting(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="border-t border-border bg-background px-4 py-3 space-y-2 shrink-0">

      {/* Authority / compliance block banner */}
      {isAuthorityBlocked && (
        <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded-md px-3 py-2">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          <span>
            AI ISA outreach is <strong>blocked</strong> for contacts in{" "}
            <strong>{lifecycleState?.replace(/_/g, " ")}</strong>.
            Manual messages only — verify authorization with supervising broker.
          </span>
        </div>
      )}

      {/* SMS TCPA notice — hard block if tcpaConsent is explicitly false; warn if null/unknown */}
      {isTCPABlocked && (
        <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded-md px-3 py-2">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          <span>
            <strong>TCPA Block:</strong> This contact has not opted in to SMS. Obtain written consent before sending.
            SMS is disabled until consent is recorded.
          </span>
        </div>
      )}
      {isSMS && !isTCPABlocked && (
        <div className="flex items-center gap-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-1.5">
          <AlertTriangle size={12} className="shrink-0" />
          {tcpaConsent
            ? "TCPA: Opt-in consent recorded."
            : "TCPA: Consent status unknown — verify opt-in before sending SMS."}
        </div>
      )}

      {/* Channel selector + Template picker row */}
      <div className="flex items-center gap-2">
        {/* Channel selector */}
        <select
          value={channel}
          onChange={e => setChannel(e.target.value as typeof channel)}
          disabled={isPending || disabled}
          className="text-xs border border-border rounded-md px-2 py-1 bg-background text-foreground h-7"
        >
          <option value="email">Email</option>
          <option value="sms">SMS</option>
          <option value="in_app">In-App</option>
        </select>

        {/* Template picker */}
        {availableTemplates.length > 0 && (
          <div className="relative">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => setShowTemplates(!showTemplates)}
            >
              <FileText size={12} />
              Templates
              <ChevronDown size={11} className={cn("transition-transform", showTemplates && "rotate-180")} />
            </Button>
            {showTemplates && (
              <div className="absolute bottom-full left-0 mb-1 w-56 max-h-48 overflow-y-auto border border-border bg-background rounded-lg shadow-md z-10">
                {availableTemplates.map(tpl => (
                  <button
                    key={tpl.id}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-muted transition-colors border-b border-border last:border-0"
                    onClick={() => applyTemplate(tpl)}
                  >
                    <p className="font-medium text-foreground truncate">{tpl.name}</p>
                    {tpl.subject && (
                      <p className="text-muted-foreground truncate">{tpl.subject}</p>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Subject line (email only) */}
      {channel === "email" && (
        <Input
          value={subject}
          onChange={e => setSubject(e.target.value)}
          placeholder="Subject…"
          className="h-8 text-sm"
          disabled={isPending || disabled}
        />
      )}

      {/* Message body */}
      <Textarea
        value={body}
        onChange={e => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={
          isTCPABlocked
            ? "SMS blocked — consent required"
            : `Reply via ${CHANNEL_LABELS[channel] ?? channel}… (⌘+Enter to send)`
        }
        className="min-h-[72px] max-h-[180px] resize-none text-sm"
        disabled={isPending || disabled || isAuthorityBlocked || isTCPABlocked}
      />

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {onDraft && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleDraft}
              disabled={isDrafting || isPending || isAuthorityBlocked || isTCPABlocked}
              className="text-xs h-7 gap-1"
            >
              {isDrafting ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              AI Draft
            </Button>
          )}
          <span className={cn("text-[10px] text-muted-foreground", body.length > 1500 && "text-destructive")}>
            {body.length} chars
          </span>
        </div>

        <Button
          size="sm"
          onClick={handleSend}
          disabled={!body.trim() || isPending || isAuthorityBlocked || isTCPABlocked || disabled}
          className="h-7 gap-1 text-xs"
        >
          {isPending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
          Send
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
