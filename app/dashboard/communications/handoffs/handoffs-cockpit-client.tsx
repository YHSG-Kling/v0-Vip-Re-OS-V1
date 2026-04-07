"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  ShieldOff,
  Bot,
  ArrowRight,
  RefreshCw,
} from "lucide-react"
import { useRouter } from "next/navigation"

// ── Types ─────────────────────────────────────────────────────────────────────

type HandoffState =
  | "human_required"
  | "ai_waiting_approval"
  | "compliance_hold"
  | "ai_handling"

export interface HandoffContact {
  id: string
  first_name: string | null
  last_name: string | null
  contact_type: string | null
  preferred_channel: string | null
  call_stop_flag: boolean | null
  // Derived from call_analyses joined via voice_calls
  lastAnalysis: {
    urgency_score: number | null
    sentiment: string | null
    suggested_next_action: string | null
  } | null
  // From ai_message_drafts with status = 'pending'
  pendingDraft: {
    id: string
    draft_body: string | null
    channel: string | null
  } | null
  // Derived state
  handoffState: HandoffState
}

interface Props {
  contacts: HandoffContact[]
  agentId: string
  brokerageId: string
}

// ── State badge ───────────────────────────────────────────────────────────────

function HandoffStateBadge({ state }: { state: HandoffState }) {
  switch (state) {
    case "human_required":
      return (
        <Badge className="bg-red-100 text-red-700 border-red-200 shrink-0">
          <AlertTriangle className="h-3 w-3 mr-1" />
          Needs Human
        </Badge>
      )
    case "ai_waiting_approval":
      return (
        <Badge className="bg-amber-100 text-amber-700 border-amber-200 shrink-0">
          <Clock className="h-3 w-3 mr-1" />
          Awaiting Approval
        </Badge>
      )
    case "compliance_hold":
      return (
        <Badge className="bg-gray-100 text-gray-700 border-gray-200 shrink-0">
          <ShieldOff className="h-3 w-3 mr-1" />
          Compliance Hold
        </Badge>
      )
    case "ai_handling":
      return (
        <Badge className="bg-blue-100 text-blue-700 border-blue-200 shrink-0">
          <Bot className="h-3 w-3 mr-1" />
          AI Handling
        </Badge>
      )
  }
}

// ── Handoff card ──────────────────────────────────────────────────────────────

function HandoffCard({
  contact,
  onDraftAction,
  onResumeAI,
  onRemoveCallStop,
}: {
  contact: HandoffContact
  onDraftAction: (draftId: string, action: "approve" | "dismiss") => Promise<void>
  onResumeAI: (contactId: string) => Promise<void>
  onRemoveCallStop: (contactId: string) => Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)

  async function handleAction(key: string, fn: () => Promise<void>) {
    setBusy(key)
    await fn()
    setBusy(null)
  }

  const { handoffState, lastAnalysis, pendingDraft, call_stop_flag } = contact
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "Unknown"

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold leading-tight">{name}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {contact.contact_type ?? "Contact"}
            {contact.preferred_channel ? ` · ${contact.preferred_channel}` : ""}
          </p>
        </div>
        <HandoffStateBadge state={handoffState} />
      </div>

      {/* AI escalation reason */}
      {handoffState === "human_required" && lastAnalysis && (
        <div className="rounded bg-red-50 border border-red-200 p-2 space-y-0.5">
          <p className="text-xs font-medium text-red-800">AI escalation reason:</p>
          <p className="text-xs text-red-700">
            {lastAnalysis.urgency_score !== null && lastAnalysis.urgency_score >= 80
              ? "High urgency detected"
              : ""}
            {lastAnalysis.sentiment === "negative" ? " · Negative sentiment" : ""}
            {lastAnalysis.suggested_next_action
              ? ` · ${lastAnalysis.suggested_next_action.replace(/_/g, " ")}`
              : ""}
          </p>
        </div>
      )}

      {/* Compliance hold */}
      {call_stop_flag && (
        <div className="rounded bg-muted border p-2">
          <p className="text-xs text-muted-foreground">
            Call stop flag active — no AI or human calls permitted
          </p>
        </div>
      )}

      {/* AI pending draft */}
      {handoffState === "ai_waiting_approval" && pendingDraft && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            AI drafted message pending your approval:
          </p>
          <p className="text-sm italic border-l-2 border-indigo-300 pl-2 text-foreground">
            {pendingDraft.draft_body
              ? pendingDraft.draft_body.substring(0, 120) + (pendingDraft.draft_body.length > 120 ? "…" : "")
              : "(No preview available)"}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => handleAction("approve", () => onDraftAction(pendingDraft.id, "approve"))}
            >
              {busy === "approve" ? "Sending…" : "Send"}
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link href={`/crm?contactId=${contact.id}&draftId=${pendingDraft.id}`}>
                Edit
              </Link>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => handleAction("dismiss", () => onDraftAction(pendingDraft.id, "dismiss"))}
            >
              {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
            </Button>
          </div>
        </div>
      )}

      {/* Action bar */}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button size="sm" asChild>
          <Link href={`/crm?contactId=${contact.id}`}>
            Open in CRM
            <ArrowRight className="h-3 w-3 ml-1" />
          </Link>
        </Button>

        {handoffState !== "compliance_hold" && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => handleAction("resume", () => onResumeAI(contact.id))}
          >
            <RefreshCw className="h-3 w-3 mr-1" />
            {busy === "resume" ? "Resuming…" : "Resume AI Follow-up"}
          </Button>
        )}

        {call_stop_flag && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => handleAction("remove-stop", () => onRemoveCallStop(contact.id))}
          >
            {busy === "remove-stop" ? "Removing…" : "Remove Call Block"}
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Filter tabs ───────────────────────────────────────────────────────────────

type FilterTab = "all" | HandoffState

// ── Main client component ─────────────────────────────────────────────────────

export function HandoffsCockpitClient({ contacts: initialContacts, agentId, brokerageId }: Props) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [contacts, setContacts] = useState<HandoffContact[]>(initialContacts)
  const [activeTab, setActiveTab] = useState<FilterTab>("all")

  // Counts per state for badge display
  const counts: Record<HandoffState, number> = {
    human_required: contacts.filter((c) => c.handoffState === "human_required").length,
    ai_waiting_approval: contacts.filter((c) => c.handoffState === "ai_waiting_approval").length,
    compliance_hold: contacts.filter((c) => c.handoffState === "compliance_hold").length,
    ai_handling: contacts.filter((c) => c.handoffState === "ai_handling").length,
  }

  const filtered =
    activeTab === "all" ? contacts : contacts.filter((c) => c.handoffState === activeTab)

  // ── Actions ───────────────────────────────────────────────────────────────

  async function handleDraftAction(draftId: string, action: "approve" | "dismiss") {
    const supabase = createClient()

    if (action === "approve") {
      await supabase
        .from("ai_message_drafts")
        .update({ status: "approved", acted_at: new Date().toISOString() })
        .eq("id", draftId)
    } else {
      await supabase
        .from("ai_message_drafts")
        .update({ status: "dismissed", acted_at: new Date().toISOString() })
        .eq("id", draftId)
    }

    // Optimistically remove the pending draft from the card
    setContacts((prev) =>
      prev.map((c) =>
        c.pendingDraft?.id === draftId
          ? { ...c, pendingDraft: null, handoffState: "ai_handling" }
          : c
      )
    )
  }

  async function handleResumeAI(contactId: string) {
    const supabase = createClient()

    // Update contact to mark AI as re-engaged
    await supabase
      .from("contacts")
      .update({ isa_reengage_allowed: true, isa_reengage_set_at: new Date().toISOString() })
      .eq("id", contactId)

    // Optimistically update state
    setContacts((prev) =>
      prev.map((c) =>
        c.id === contactId ? { ...c, handoffState: "ai_handling" } : c
      )
    )
  }

  async function handleRemoveCallStop(contactId: string) {
    const supabase = createClient()

    await supabase
      .from("contacts")
      .update({ call_stop_flag: false })
      .eq("id", contactId)

    setContacts((prev) =>
      prev.map((c) =>
        c.id === contactId ? { ...c, call_stop_flag: false, handoffState: "ai_handling" } : c
      )
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Filter tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as FilterTab)}>
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="all">All ({contacts.length})</TabsTrigger>
          <TabsTrigger value="human_required" className="gap-1.5">
            <span>Needs Human</span>
            {counts.human_required > 0 && (
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white">
                {counts.human_required}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="ai_waiting_approval" className="gap-1.5">
            <span>AI Waiting Approval</span>
            {counts.ai_waiting_approval > 0 && (
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-white">
                {counts.ai_waiting_approval}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="compliance_hold">
            Compliance Hold ({counts.compliance_hold})
          </TabsTrigger>
          <TabsTrigger value="ai_handling">
            AI Handling ({counts.ai_handling})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Cards or empty state */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <CheckCircle className="h-12 w-12 text-green-500 mx-auto mb-3" />
          <p className="font-semibold text-foreground">All conversations flowing smoothly</p>
          <p className="text-sm text-muted-foreground mt-1">
            No human intervention needed right now
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((contact) => (
            <HandoffCard
              key={contact.id}
              contact={contact}
              onDraftAction={handleDraftAction}
              onResumeAI={handleResumeAI}
              onRemoveCallStop={handleRemoveCallStop}
            />
          ))}
        </div>
      )}
    </div>
  )
}
