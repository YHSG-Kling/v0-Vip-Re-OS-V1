"use client"

import { useState, useEffect, Fragment, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Upload,
  Search,
  Sparkles,
  UserPlus,
  X,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  TrendingUp,
  ChevronDown,
  ChevronUp,
  Home,
  Brain,
  ExternalLink,
  Zap,
  Users,
  Bot,
  ShieldCheck,
} from "lucide-react"
import { AvailableLeadsSheet } from "@/app/components/leads/AvailableLeadsSheet"
import { AdminAssignmentPanel } from "@/app/components/leads/AdminAssignmentPanel"
import { LeadStatusBadge } from "@/app/components/leads/LeadStatusBadge"
import {
  getLeadsAdmin,
  enrichLead,
  rejectLead,
} from "@/app/actions/lead-management"
import { convertLeadToContact, listUnassignedLeads } from "@/app/actions/lead-lifecycle"
import { batchEvaluateLeadReadiness } from "@/app/actions/lead-readiness/evaluate-readiness"
import { importLeads } from "@/app/actions/lead-management"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/app/components/ui/alert-dialog"
import { getHotLeads } from "@/app/actions/ai-auto-response"
// aiPropertyMatchGenius is deliberately NOT imported here: it resolves against
// contacts and refuses everything else (owner ruling), and every row on this
// screen is pre-conversion. See the note above the table.
import { getTopConversionCandidates } from "@/app/actions/ai-predictions"
import {
  getIntelligenceDashboardStats,
  getMotivatedSellers,
  getUnifiedLeadProfiles,
  deliverIntelligentValue,
  updateLeadProfile,
  getAgentWorkloadStats,
} from "@/app/actions/lead-intelligence"
import type { AgentWorkloadRow } from "@/app/actions/lead-intelligence"
import LeadIntelligencePanel from "@/app/components/intelligence/LeadIntelligencePanel"
import { initiateWhisperBridge, triggerAiVoiceCall } from "@/app/actions/voice-call-bridge"
import { aiBatchReengagement } from "@/app/actions/ai-lead-nurturing"
import { HotLeadCard } from "@/app/components/shared/HotLeadCard"
import { StaleLeadQueue } from "@/app/leads/components/StaleLeadQueue"
import { GhostRecoveryQueue } from "@/app/leads/components/GhostRecoveryQueue"
import type { Lead, LeadScore, LeadIntent, LeadStatus, LeadSource } from "@/app/types/lead-management"
import { cn } from "@/lib/utils"
import { createClient } from "@/lib/supabase/client"
import { toast } from "sonner"

export default function LeadsPage() {
  const router = useRouter()

  // Role resolution state
  const [isAdminOrBroker, setIsAdminOrBroker] = useState(false)
  const [roleResolved, setRoleResolved] = useState(false)

  // ── CSV IMPORT ──────────────────────────────────────────────────────────────
  // The dialog above used to be a picture of a dropzone over an importLeads
  // action with zero callers. These carry the real thing.
  const [importRows, setImportRows] = useState<Array<Record<string, string>>>([])
  const [importFileName, setImportFileName] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null)

  /**
   * Minimal RFC-4180-ish CSV parse: quoted fields, escaped quotes, commas and
   * newlines inside quotes. Deliberately small — a dependency is not warranted
   * for a four-column contact list — but NOT naive `split(",")`, because a lead
   * named "Smith, Jr." would silently shift every column after it and import
   * garbage under a real person's name.
   */
  const parseCsv = (text: string): Array<Record<string, string>> => {
    const rows: string[][] = []
    let row: string[] = [], field = "", inQuotes = false
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
        } else field += c
        continue
      }
      if (c === '"') { inQuotes = true; continue }
      if (c === ",") { row.push(field); field = ""; continue }
      if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++
        row.push(field); field = ""
        if (row.some((v) => v.trim() !== "")) rows.push(row)
        row = []
        continue
      }
      field += c
    }
    row.push(field)
    if (row.some((v) => v.trim() !== "")) rows.push(row)
    if (rows.length < 2) return []

    const headers = rows[0].map((h) => h.trim().toLowerCase())
    return rows.slice(1).map((r) => {
      const o: Record<string, string> = {}
      headers.forEach((h, i) => { o[h] = (r[i] ?? "").trim() })
      return o
    })
  }

  const handleCsvFile = async (file: File) => {
    setImportMsg(null)
    setImportFileName(file.name)
    try {
      const parsed = parseCsv(await file.text())
      setImportRows(parsed)
      if (parsed.length === 0) {
        setImportMsg({ ok: false, text: "No data rows found. The first line must be a header." })
      }
    } catch {
      setImportRows([])
      setImportMsg({ ok: false, text: "That file could not be read as CSV." })
    }
  }

  const handleImport = async () => {
    if (importRows.length === 0) return
    setImporting(true)
    setImportMsg(null)

    // Map the documented header set onto the Lead shape, tolerating the common
    // spellings. A row with neither an email nor a phone is DROPPED rather than
    // imported: it is unreachable, and importing it would inflate the count with
    // records no one can act on.
    const leads = importRows
      .map((r) => {
        const full = r["name"] ?? `${r["first_name"] ?? ""} ${r["last_name"] ?? ""}`.trim()
        const [first, ...rest] = full.split(/\s+/)
        return {
          first_name: r["first_name"] || first || "",
          last_name:  r["last_name"] || rest.join(" ") || "",
          email:      r["email"] || null,
          phone:      r["phone"] || r["phone_number"] || null,
          source:     r["source"] || "csv_import",
        }
      })
      .filter((l) => l.email || l.phone)

    const skipped = importRows.length - leads.length
    if (leads.length === 0) {
      setImporting(false)
      setImportMsg({ ok: false, text: "No row had an email or a phone number, so nothing could be imported." })
      return
    }

    const res = await importLeads(leads as any)
    setImporting(false)
    // importLeads returns { success, error, imported, deduped, unassigned } and
    // never throws — read it, so a refusal is not a silent no-op.
    if (!res.success) {
      setImportMsg({ ok: false, text: res.error ?? "Import failed" })
      return
    }
    setImportMsg({
      ok: true,
      text: `Imported ${res.imported}` +
        (res.deduped ? ` · ${res.deduped} already existed` : "") +
        (res.unassigned ? ` · ${res.unassigned} unassigned` : "") +
        (skipped ? ` · ${skipped} skipped (no email or phone)` : ""),
    })
    setImportRows([])
    setImportFileName(null)
    router.refresh()
  }

  // Available leads sheet (agents)
  const [availableSheetOpen, setAvailableSheetOpen] = useState(false)

  // Unassigned lead count for admin badge
  const [unassignedCount, setUnassignedCount] = useState<number | null>(null)

  // Admin pipeline stats bar
  const [pipelineStats, setPipelineStats] = useState<{
    unassigned: number
    assigned: number
    isa_working: number
    stale: number
    ghost_recovery: number
  } | null>(null)

  // Admin assignment panel
  const [adminPanelOpen, setAdminPanelOpen] = useState(false)
  const [userId, setUserId] = useState('')

  const [leads, setLeads] = useState<Lead[]>([])
  /**
   * Readiness state per lead id, from `batchEvaluateLeadReadiness`, which had no
   * caller. Its own docstring says it is for "dashboard views showing lead pipeline
   * status" and this is that view: without it the readiness lane was reachable only
   * one lead at a time from /leads/[leadId], so a pipeline could not be triaged by
   * who is actually ready. The action is authenticated, intersects the ids with the
   * caller's brokerage server-side and caps the batch at 200, so passing the visible
   * page of ids is safe.
   */
  const [readiness, setReadiness] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)

  // Filters
  const [search, setSearch] = useState("")
  const [scoreFilter, setScoreFilter] = useState<LeadScore | "all">("all")
  const [intentFilter, setIntentFilter] = useState<LeadIntent | "all">("all")
  const [statusFilter, setStatusFilter] = useState<LeadStatus | "all">("all")
  const [sourceFilter, setSourceFilter] = useState<LeadSource | "all">("all")

  // Sorting
  const [sortBy, setSortBy] = useState("created_at")
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc")

  // Actions
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  // Hot leads
  const [hotLeads, setHotLeads] = useState<any[]>([])
  const [hotLeadsLoading, setHotLeadsLoading] = useState(true)
  const [agentId, setAgentId] = useState('')
  const [deliveredProfiles, setDeliveredProfiles] = useState<Set<string>>(new Set())
  const [deliveringId, setDeliveringId] = useState<string | null>(null)
  const [brokerageId, setBrokerageId] = useState('')
  const [callingId, setCallingId] = useState<string | null>(null)

  // Lead-to-contact conversion confirmation
  const [convertConfirmLead, setConvertConfirmLead] = useState<Lead | null>(null)
  const [convertingId, setConvertingId] = useState<string | null>(null)
  const [convertedIds, setConvertedIds] = useState<Set<string>>(new Set())
  const [convertSuccessMap, setConvertSuccessMap] = useState<Record<string, string>>({}) // leadId → contactId

  // Top conversion candidates
  const [conversionCandidates, setConversionCandidates] = useState<any[]>([])
  const [candidatesLoading, setCandidatesLoading] = useState(true)

  // Lead intelligence dashboard
  const [intelligenceStats, setIntelligenceStats] = useState<any>(null)
  const [motivatedSellers, setMotivatedSellers] = useState<any[]>([])
  const [sellersExpanded, setSellersExpanded] = useState(false)

  // Unified lead profiles (Part C — ready for outreach, min confidence 70)
  const [unifiedProfiles, setUnifiedProfiles] = useState<any[]>([])
  const [profilesLoading, setProfilesLoading] = useState(false)

  // TRIAGE — the profile card showed the AI's verdict and gave the agent no way
  // to correct or claim it. updateLeadProfile existed the whole time with no
  // caller, so a wrong temperature stayed wrong and nobody could take a profile.
  const [triagingId, setTriagingId] = useState<string | null>(null)

  // Who is carrying which share of the qualified pipeline (broker/admin only).
  const [workload, setWorkload] = useState<AgentWorkloadRow[]>([])
  const [workloadLoading, setWorkloadLoading] = useState(false)

  // Selected lead for inline LeadIntelligencePanel
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null)
  const [selectedLeadData, setSelectedLeadData] = useState<any>(null)

  // Batch reengagement
  const [batchReengagementLoading, setBatchReengagementLoading] = useState(false)
  const [batchReengagementResult, setBatchReengagementResult] = useState<any>(null)

  // AI PROPERTY MATCH GENIUS — WITHDRAWN FROM THIS SCREEN BY OWNER RULING.
  //
  // The action behind this button now resolves its subject against the contacts
  // table and refuses anything else, because property search through IDX Broker is
  // a contacts capability. Every row on this screen comes from the pre-conversion
  // lane, so the button could only ever have produced a refusal — and a control
  // that reliably errors is worse than one that is not there, because it teaches
  // the agent to ignore failures.
  //
  // It is not deleted silently: the cell below says what happened and what to do
  // instead. The capability itself is intact on the contact record
  // (app/crm/contacts/[contactId] — the buyer overview calls the same action with a
  // contacts.id), so the route out of here is Convert, which is the button next to
  // this note.
  //
  // The result state and its inline panel went with it; there is no longer any way
  // to populate them from this screen.

  const handleBatchReengagement = async () => {
    if (!agentId) return
    setBatchReengagementLoading(true)
    setBatchReengagementResult(null)
    try {
      const res = await aiBatchReengagement({ agentId, daysInactive: 30, maxLeads: 50 })
      setBatchReengagementResult(res)
    } catch (err) {
      setBatchReengagementResult({ success: false, error: "Failed to run batch reengagement" })
    } finally {
      setBatchReengagementLoading(false)
    }
  }

  // Fetch leads — respects resolved role; waits until role is known.
  // Non-admin agents never fetch leads — they see the gate screen instead.
  const fetchLeads = useCallback(async () => {
    if (!roleResolved) return
    if (!isAdminOrBroker) return
    setLoading(true)
    const result = await getLeadsAdmin({
      search: search || undefined,
      score: scoreFilter !== "all" ? scoreFilter : undefined,
      intent: intentFilter !== "all" ? intentFilter : undefined,
      status: statusFilter !== "all" ? statusFilter : undefined,
      source: sourceFilter !== "all" ? sourceFilter : undefined,
      page,
      limit: 10,
      sortBy,
      sortOrder,
      adminView: isAdminOrBroker,
    })

    if (result.success) {
      setLeads(result.leads as Lead[])
      setTotal(result.total)
      setTotalPages(result.totalPages)
    }
    setLoading(false)
  }, [roleResolved, isAdminOrBroker, search, scoreFilter, intentFilter, statusFilter, sourceFilter, page, sortBy, sortOrder])

  useEffect(() => {
    fetchLeads()
  }, [fetchLeads])

  // Load hot leads, resolve agentId, and enforce role-based access
  useEffect(() => {
    const loadHotLeads = async () => {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      setUserId(user.id)

      // Resolve user role
      const { data: profile } = await supabase
        .from("users")
        .select("user_type, role, platform_role")
        .eq("id", user.id)
        .single()

      const resolvedType = profile?.user_type ?? profile?.role ?? "agent"

      // ACCESS POLICY (owner): LEADS = BROKERAGE + PLATFORM ONLY. This surface
      // is usable only by brokerage-LEVEL roles (broker/admin family) and
      // platform staff. team_lead / TC / compliance_officer / isa / vendor /
      // lender are redirected — they work contacts, not the lead desk. Agents
      // fall through to the explanatory gate screen below (no lead data is
      // fetched or rendered for them). Server actions re-enforce this gate.
      if (["tc", "transaction_coordinator", "vendor", "lender", "team_lead", "team_leader", "compliance_officer", "compliance_manager", "isa", "title_agent"].includes(resolvedType)) {
        router.push("/dashboard")
        return
      }

      const platformStaff = ["superadmin", "admin", "marketing", "support"].includes(
        String((profile as any)?.platform_role ?? "")
      )
      const adminBroker =
        ["admin", "broker", "broker_owner", "broker_admin", "superadmin"].includes(resolvedType) || platformStaff
      setIsAdminOrBroker(adminBroker)

      // Resolve brokerageId from users table
      const { data: userRow } = await supabase
        .from("users")
        .select("brokerage_id")
        .eq("id", user.id)
        .single()
      if (userRow?.brokerage_id) {
        setBrokerageId(userRow.brokerage_id)
      }

      // Resolve agentId
      const { data: agentRow } = await supabase
        .from("agents")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle()
      const resolvedAgentId = agentRow?.id || ''
      setAgentId(resolvedAgentId)

      // Mark role resolved — triggers fetchLeads
      setRoleResolved(true)

      // Load unassigned lead count for admin badge
      if (adminBroker && userRow?.brokerage_id) {
        listUnassignedLeads({ brokerageId: userRow.brokerage_id, limit: 1 })
          .then((r) => setUnassignedCount(r.total ?? (r.leads?.length ?? 0)))
          .catch(() => setUnassignedCount(null))

        // Load pipeline stats for admin stats bar — single query, client-side aggregate
        supabase
          .from("leads")
          .select("lead_stage, agent_id, reengagement_status, lifecycle_state")
          .eq("brokerage_id", userRow.brokerage_id)
          .eq("is_active", true)
          .then(({ data }: { data: { lead_stage: any; agent_id: any; reengagement_status: any; lifecycle_state: any }[] | null }) => {
            if (data) {
              setPipelineStats({
                unassigned:    data.filter((l: any) => !l.agent_id).length,
                assigned:      data.filter((l: any) => !!l.agent_id).length,
                isa_working:   data.filter((l: any) => l.lifecycle_state === "isa_qualifying").length,
                stale:         data.filter((l: any) => l.lead_stage === "stale").length,
                ghost_recovery: data.filter((l: any) => l.reengagement_status === "active").length,
              })
            }
          })
          .catch(() => {/* non-blocking */})
      }

      // Load hot leads
      try {
        const leads = await getHotLeads(5)
        setHotLeads(Array.isArray(leads) ? leads : [])
      } catch {
        setHotLeads([])
      } finally {
        setHotLeadsLoading(false)
      }

      // Load top conversion candidates
      try {
        const candidates = await getTopConversionCandidates(3)
        setConversionCandidates(Array.isArray(candidates) ? candidates : [])
      } catch {
        setConversionCandidates([])
      } finally {
        setCandidatesLoading(false)
      }

      // Load intelligence stats + motivated sellers + unified profiles in parallel
      setProfilesLoading(true)
      const [statsResult, sellersResult, profilesResult] = await Promise.all([
        getIntelligenceDashboardStats().catch(() => null),
        getMotivatedSellers({ min_score: 60 }).catch(() => ({ success: false, sellers: [] })),
        getUnifiedLeadProfiles({ ready_for_outreach: true, min_confidence: 70 }).catch(() => ({ success: false, profiles: [] })),
      ])
      if (statsResult?.success) setIntelligenceStats(statsResult.stats)
      setMotivatedSellers(sellersResult?.sellers ?? [])
      setUnifiedProfiles(profilesResult?.profiles ?? [])
      setProfilesLoading(false)
    }
    loadHotLeads()
  }, [])

  // Workload distribution — only meaningful to someone who can move work
  // between agents, so it loads only once the role is known to be broker/admin.
  useEffect(() => {
    if (!roleResolved || !isAdminOrBroker) return
    let cancelled = false
    const loadWorkload = async () => {
      setWorkloadLoading(true)
      try {
        const result = await getAgentWorkloadStats()
        if (!cancelled && result.success) setWorkload(result.workload)
      } catch (error) {
        console.error("[leads] Agent workload load failed:", error)
      } finally {
        if (!cancelled) setWorkloadLoading(false)
      }
    }
    loadWorkload()
    return () => {
      cancelled = true
    }
  }, [roleResolved, isAdminOrBroker])

  /**
   * Apply one triage change to a unified profile and reflect the row the server
   * actually wrote — not the value that was clicked. updateLeadProfile resolves
   * "me" to an agents.id and refuses a profile outside this brokerage, so a
   * refused change must not look applied.
   */
  const applyProfileTriage = async (
    profileId: string,
    updates: Parameters<typeof updateLeadProfile>[1],
  ) => {
    setTriagingId(profileId)
    try {
      const result = await updateLeadProfile(profileId, updates)
      if (!result.success) {
        toast.error(result.error ?? "Could not update this profile")
        return
      }
      setUnifiedProfiles((prev) =>
        prev.map((p) => (p.id === profileId ? { ...p, ...result.profile } : p)),
      )
      toast.success("Profile updated")
      if (isAdminOrBroker) {
        const refreshed = await getAgentWorkloadStats()
        if (refreshed.success) setWorkload(refreshed.workload)
      }
    } catch (error: any) {
      toast.error(error?.message ?? "Could not update this profile")
    } finally {
      setTriagingId(null)
    }
  }

  // Debounced search — only runs after role is resolved
  useEffect(() => {
    if (!roleResolved) return
    const timer = setTimeout(() => {
      if (page === 1) {
        fetchLeads()
      } else {
        setPage(1)
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [search, roleResolved])

  const handleSort = (column: string) => {
    if (sortBy === column) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc")
    } else {
      setSortBy(column)
      setSortOrder("desc")
    }
  }

  const handleEnrich = async (leadId: string) => {
    setActionLoading(leadId)
    const result = await enrichLead(leadId)
    if (result.success) {
      fetchLeads()
    }
    setActionLoading(null)
  }

  const handleConvertToContact = async (lead: Lead) => {
    if (!agentId || !brokerageId) return
    setConvertingId(lead.id)
    try {
      const result = await convertLeadToContact({ leadId: lead.id, agentId, brokerageId })
      if (result.success) {
        setConvertedIds((prev) => new Set(prev).add(lead.id))
        const contactId = result.contactId
        if (contactId) {
          setConvertSuccessMap((prev) => ({ ...prev, [lead.id]: contactId }))
        }
        fetchLeads()
        setConvertConfirmLead(null)
        const toastMsg = (result as any).portalInviteCreated
          ? `${lead.first_name} converted — portal invite ready`
          : `${lead.first_name} converted — add email to send portal`
        toast.success(toastMsg)
        router.push(contactId ? `/crm?contact=${contactId}` : "/crm")
      } else {
        // Server-side refusal (e.g. lead not yet AI-ISA qualified) — show why.
        toast.error((result as any).message ?? "Conversion refused")
      }
    } catch (err) {
      // Surface the server-side refusal honestly — the canonical converter now
      // REFUSES unqualified leads (owner round 37: leads convert once the AI ISA
      // qualifies them), and the broker should see why nothing happened.
      toast.error(err instanceof Error ? err.message : "Conversion failed")
    }
    setConvertingId(null)
    setConvertConfirmLead(null)
  }

  const handleReject = async (leadId: string) => {
    setActionLoading(leadId)
    const result = await rejectLead(leadId)
    if (result.success) {
      fetchLeads()
    }
    setActionLoading(null)
  }

  const handleWhisperBridge = async (contactId: string, context: string) => {
    if (!agentId) return
    setCallingId(contactId + 'whisper')
    try {
      await initiateWhisperBridge({ contactId, agentId, context })
    } catch {}
    setCallingId(null)
  }

  const handleAiVoiceCall = async (contactId: string, triggerEvent: string) => {
    setCallingId(contactId + 'ai-voice')
    try {
      await triggerAiVoiceCall({ contactId, triggerEvent })
    } catch {}
    setCallingId(null)
  }

  const getScoreColor = (score: LeadScore) => {
    if (score <= 2) return "text-destructive"
    if (score === 3) return "text-warning"
    return "text-success"
  }

  const getScoreBadgeVariant = (score: LeadScore) => {
    if (score <= 2) return "destructive"
    if (score === 3) return "secondary"
    return "default"
  }

  const getSourceColor = (source: LeadSource) => {
    const colors: Record<LeadSource, string> = {
      scraped: "bg-primary text-primary-foreground",
      website_form: "bg-accent text-accent-foreground",
      ghl: "bg-muted text-muted-foreground",
      manual: "bg-secondary text-secondary-foreground",
    }
    return colors[source]
  }

  const getStatusColor = (status: LeadStatus) => {
    const colors: Record<LeadStatus, "default" | "secondary" | "destructive" | "outline"> = {
      new: "secondary",
      enriched: "default",
      qualified: "default",
      converted: "default",
      rejected: "destructive",
    }
    return colors[status]
  }

  const getLeadStatusBadge = (lead: any): { label: string; color: string } => {
    if (!lead.agent_id && !lead.assigned_agent_id) return { label: "Unassigned", color: "bg-amber-100 text-amber-800" }
    if (lead.lifecycle_state === "isa_qualifying") return { label: "AI-ISA Qualifying", color: "bg-purple-100 text-purple-800" }
    if (lead.reengagement_status === "active") return { label: "Ghost Recovery", color: "bg-red-100 text-red-800" }
    if (lead.lead_stage === "stale") return { label: "Stale", color: "bg-gray-100 text-gray-600" }
    if (lead.lead_stage === "claimed") return { label: "Claimed", color: "bg-blue-100 text-blue-800" }
    if (lead.lead_stage === "qualified") return { label: "Qualified", color: "bg-green-100 text-green-800" }
    return { label: lead.lead_stage || "New", color: "bg-slate-100 text-slate-700" }
  }

  // Non-admin agents: show gate screen instead of leads table
  if (roleResolved && !isAdminOrBroker) {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="max-w-7xl mx-auto">
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <ShieldCheck className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="font-semibold">Leads are managed by your brokerage</h3>
            <p className="text-sm text-muted-foreground mt-2">
              When a lead is qualified and assigned to you, it will appear as a Contact in your CRM.
            </p>
            <Button className="mt-4" onClick={() => router.push("/crm")}>
              Go to My Contacts
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Lead Management</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {total} total leads · Page {page} of {totalPages}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Assign Leads — visible to admin/broker only */}
            {roleResolved && isAdminOrBroker && (
              <div className="relative">
                <Button
                  variant="outline"
                  onClick={() => setAdminPanelOpen(true)}
                >
                  <Users className="h-4 w-4 mr-2" />
                  Assign Leads
                  {unassignedCount !== null && unassignedCount > 0 && (
                    <span className="ml-2 inline-flex items-center justify-center h-4.5 min-w-[1.125rem] px-1 rounded-full text-[10px] font-bold bg-amber-400 text-amber-900 leading-none">
                      {unassignedCount}
                    </span>
                  )}
                </Button>
              </div>
            )}
            {/* Available Leads pool — visible to agents only */}
            {roleResolved && !isAdminOrBroker && (
              <Button
                variant="outline"
                onClick={() => setAvailableSheetOpen(true)}
              >
                <Zap className="h-4 w-4 mr-2 text-yellow-500" />
                Available Leads
              </Button>
            )}
            {/* Import Leads — admin/broker only */}
            {roleResolved && isAdminOrBroker && (
              <Dialog>
                <DialogTrigger asChild>
                  <Button>
                    <Upload className="h-4 w-4 mr-2" />
                    Import Leads
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Import Leads</DialogTitle>
                    <DialogDescription>Upload a CSV file to import</DialogDescription>
                  </DialogHeader>
                  {/* THIS DIALOG WAS A PICTURE OF A DROPZONE. A dashed border, an
                      upload icon and the words "Drop CSV file here or click to
                      browse" — with no <input type="file">, no onClick, no onDrop
                      and no submit button. Nothing could be dropped, nothing
                      opened when clicked, and there was no way to commit. Behind
                      it, importLeads was complete (dedupe, assignment, tenant
                      gate) with ZERO callers anywhere in the repo. */}
                  <div className="space-y-4 py-4">
                    <label
                      htmlFor="lead-csv-input"
                      className="border-2 border-dashed border-border rounded-lg p-8 text-center block cursor-pointer hover:border-primary/50 transition-colors"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault()
                        const f = e.dataTransfer.files?.[0]
                        if (f) handleCsvFile(f)
                      }}
                    >
                      <Upload className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
                      <p className="text-sm text-foreground font-medium">
                        {importFileName ?? "Drop CSV file here or click to browse"}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">CSV format: name, email, phone, source</p>
                      <input
                        id="lead-csv-input"
                        type="file"
                        accept=".csv,text/csv"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0]
                          if (f) handleCsvFile(f)
                        }}
                      />
                    </label>

                    {importRows.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {importRows.length} row{importRows.length === 1 ? "" : "s"} parsed and ready to import.
                      </p>
                    )}
                    {importMsg && (
                      <p className={`text-xs ${importMsg.ok ? "text-emerald-600" : "text-destructive"}`}>
                        {importMsg.text}
                      </p>
                    )}

                    <Button
                      className="w-full"
                      disabled={importing || importRows.length === 0}
                      onClick={handleImport}
                    >
                      {importing
                        ? "Importing…"
                        : `Import ${importRows.length || ""} lead${importRows.length === 1 ? "" : "s"}`.trim()}
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            )}
          </div>
        </div>

        {/* Role-aware context strip */}
        {roleResolved && (
          <div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-2.5">
            {isAdminOrBroker ? (
              <>
                <Badge className="bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-100">
                  Brokerage View — All Leads
                </Badge>
                {leads.filter((l: any) => !(l.agent_id || l.assigned_agent_id)).length > 0 && (
                  <span className="text-sm text-muted-foreground">
                    {leads.filter((l: any) => !(l.agent_id || l.assigned_agent_id)).length} awaiting assignment
                  </span>
                )}
              </>
            ) : (
              <>
                <Badge className="bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-100">
                  My Leads
                </Badge>
                <span className="text-sm text-muted-foreground">Showing leads assigned to you</span>
              </>
            )}
          </div>
        )}

        <Tabs defaultValue="leads" className="space-y-6">
          <TabsList>
            <TabsTrigger value="leads">Lead List</TabsTrigger>
            <TabsTrigger value="intelligence" className="flex items-center gap-1.5">
              <Brain className="h-3.5 w-3.5" />
              Intelligence
              {intelligenceStats?.readyForOutreach > 0 && (
                <span className="ml-1 rounded-full bg-primary text-primary-foreground text-xs px-1.5 py-0.5 leading-none">
                  {intelligenceStats.readyForOutreach}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="leads" className="space-y-6 mt-0">

        {/* Admin stale/ghost recovery alert strip */}
        {isAdminOrBroker && leads.length > 0 && (() => {
          const staleLeads = leads.filter((l: any) => l.lead_stage === "stale")
          const ghostLeads = leads.filter((l: any) => l.reengagement_status === "active")
          if (staleLeads.length === 0 && ghostLeads.length === 0) return null
          return (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="shrink-0 h-4 w-4 text-amber-600">
                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                    <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                  </svg>
                </span>
                <p className="text-sm text-amber-900 font-medium truncate">
                  {staleLeads.length > 0 && `${staleLeads.length} stale lead${staleLeads.length !== 1 ? "s" : ""} need attention`}
                  {staleLeads.length > 0 && ghostLeads.length > 0 && " — "}
                  {ghostLeads.length > 0 && `${ghostLeads.length} in AI ghost recovery`}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {staleLeads.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-amber-300 text-amber-800 hover:bg-amber-100 text-xs h-7"
                    onClick={() => setStatusFilter("stale" as any)}
                  >
                    Review Stale
                  </Button>
                )}
                {ghostLeads.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-amber-300 text-amber-800 hover:bg-amber-100 text-xs h-7"
                    onClick={() => setStatusFilter("ghost_recovery" as any)}
                  >
                    Review Ghost Recovery
                  </Button>
                )}
              </div>
            </div>
          )
        })()}

        {/* Agent: AI-ISA active notification strip */}
        {!isAdminOrBroker && agentId && (() => {
          const isaActiveLeads = leads.filter(
            (l: any) => l.agent_id === agentId && l.lifecycle_state === "isa_qualifying"
          )
          if (isaActiveLeads.length === 0) return null
          return (
            <div className="flex items-center gap-3 rounded-lg border border-purple-200 bg-purple-50 px-4 py-3">
              <Bot className="h-4 w-4 text-purple-600 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-purple-900">
                  AI-ISA is working {isaActiveLeads.length} of your lead{isaActiveLeads.length !== 1 ? "s" : ""}
                </p>
                <p className="text-xs text-purple-700">
                  These leads went cold — AI is re-engaging them on your behalf. You will be notified when they respond.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto shrink-0 border-purple-300 text-purple-700 hover:bg-purple-100 text-xs h-7"
                onClick={() => router.push("/dashboard/isa")}
              >
                View Activity
              </Button>
            </div>
          )
        })()}

        {/* Admin Stale Lead Queue & Ghost Recovery Queue */}
        {isAdminOrBroker && brokerageId && (
          <div className="space-y-3">
            <StaleLeadQueue brokerageId={brokerageId} />
            <GhostRecoveryQueue brokerageId={brokerageId} />
          </div>
        )}

        {/* Filters Card */}
        <Card>
          <CardContent className="pt-6">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
              {/* Search */}
              <div className="md:col-span-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by name, email, or phone..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>

              {/* Score Filter */}
              <Select value={scoreFilter.toString()} onValueChange={(v) => setScoreFilter(v as any)}>
                <SelectTrigger>
                  <SelectValue placeholder="All Scores" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Scores</SelectItem>
                  <SelectItem value="1">Score 1 (Low)</SelectItem>
                  <SelectItem value="2">Score 2</SelectItem>
                  <SelectItem value="3">Score 3 (Medium)</SelectItem>
                  <SelectItem value="4">Score 4</SelectItem>
                  <SelectItem value="5">Score 5 (High)</SelectItem>
                </SelectContent>
              </Select>

              {/* Intent Filter */}
              <Select value={intentFilter} onValueChange={(v) => setIntentFilter(v as any)}>
                <SelectTrigger>
                  <SelectValue placeholder="All Intents" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Intents</SelectItem>
                  <SelectItem value="buying">Buying</SelectItem>
                  <SelectItem value="selling">Selling</SelectItem>
                  <SelectItem value="distress">Distress</SelectItem>
                  <SelectItem value="investor">Investor</SelectItem>
                </SelectContent>
              </Select>

              {/* Status Filter */}
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
                <SelectTrigger>
                  <SelectValue placeholder="All Statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="new">New</SelectItem>
                  <SelectItem value="enriched">Enriched</SelectItem>
                  <SelectItem value="qualified">Qualified</SelectItem>
                  <SelectItem value="converted">Converted</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Active Filters */}
            <div className="flex items-center gap-2 mt-4 flex-wrap">
              {scoreFilter !== "all" && (
                <Badge variant="secondary" className="gap-1">
                  Score: {scoreFilter}
                  <button onClick={() => setScoreFilter("all")} className="ml-1 hover:bg-muted rounded-full">
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              )}
              {intentFilter !== "all" && (
                <Badge variant="secondary" className="gap-1">
                  Intent: {intentFilter}
                  <button onClick={() => setIntentFilter("all")} className="ml-1 hover:bg-muted rounded-full">
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              )}
              {statusFilter !== "all" && (
                <Badge variant="secondary" className="gap-1">
                  Status: {statusFilter}
                  <button onClick={() => setStatusFilter("all")} className="ml-1 hover:bg-muted rounded-full">
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Hot Leads Section */}
        {(hotLeads.length > 0 || hotLeadsLoading) && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <Zap className="h-5 w-5 text-amber-500" />
              <h2 className="text-base font-semibold">Hot Leads Now</h2>
              {!hotLeadsLoading && (
                <Badge variant="secondary" className="text-xs">{hotLeads.length} active signals</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground mb-3">
              These contacts are showing real buying signals right now.
            </p>
            {hotLeadsLoading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {[1, 2, 3].map(i => <div key={i} className="h-28 bg-muted animate-pulse rounded-lg" />)}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {hotLeads.map(lead => (
                  <HotLeadCard
                    key={lead.id}
                    lead={lead}
                    onWhisperBridge={handleWhisperBridge}
                    onAiVoiceCall={handleAiVoiceCall}
                    callingId={callingId}
                    compact={false}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Top Conversion Candidates */}
        {(conversionCandidates.length > 0 || candidatesLoading) && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="h-5 w-5 text-emerald-500" />
              <h2 className="text-base font-semibold">Most Likely to Convert</h2>
              <span className="text-xs text-muted-foreground">AI-ranked by conversion probability</span>
            </div>
            {candidatesLoading ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-20 bg-muted animate-pulse rounded-lg" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {conversionCandidates.map((candidate: any) => {
                  const lead = candidate.leads
                  const contact = candidate.contacts
                  const name = lead
                    ? `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim()
                    : contact
                    ? `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim()
                    : "Unknown"
                  const probability = Math.round((candidate.conversion_probability ?? 0) * 100)
                  const tier = candidate.score_tier ?? "bronze"
                  const tierColors: Record<string, string> = {
                    platinum: "bg-violet-100 text-violet-800 border-violet-200",
                    gold: "bg-amber-100 text-amber-800 border-amber-200",
                    silver: "bg-slate-100 text-slate-700 border-slate-200",
                    bronze: "bg-orange-100 text-orange-800 border-orange-200",
                  }
                  const contactId = candidate.contacts?.id
                  return (
                    <div
                      key={candidate.lead_id}
                      className="rounded-lg border bg-card p-4 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate">{name || "Unnamed Lead"}</p>
                        <span className={`mt-1 inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tierColors[tier] ?? tierColors.bronze}`}>
                          {tier}
                        </span>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-2xl font-bold text-emerald-600">{probability}%</p>
                        <p className="text-xs text-muted-foreground">conversion</p>
                      </div>
                      {contactId && (
                        <a
                          href={`/crm?contact=${contactId}`}
                          className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted transition-colors"
                        >
                          Open Contact
                        </a>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Lead Intelligence Dashboard */}
        {intelligenceStats && (
          <div className="mb-6 grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">Total Profiles</p>
              <p className="text-2xl font-bold">{intelligenceStats.totalLeads}</p>
              <p className="text-xs text-emerald-600">{intelligenceStats.hotLeads} hot</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">Ready for Outreach</p>
              <p className="text-2xl font-bold">{intelligenceStats.readyForOutreach}</p>
              <p className="text-xs text-muted-foreground">AI-qualified</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">Motivated Sellers</p>
              <p className="text-2xl font-bold">{intelligenceStats.motivatedSellers}</p>
              <p className="text-xs text-amber-600">Active signals</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-muted-foreground">Conversion Rate</p>
              <p className="text-2xl font-bold">
                {intelligenceStats.totalLeads > 0
                  ? Math.round((intelligenceStats.readyForOutreach / intelligenceStats.totalLeads) * 100)
                  : 0}%
              </p>
              <p className="text-xs text-muted-foreground">Pipeline to outreach</p>
            </Card>
          </div>
        )}

          {/* Motivated Sellers — collapsible, starts collapsed — in Lead List tab */}
          {motivatedSellers.length > 0 && (
          <div className="mb-6 rounded-lg border bg-card">
            <button
              onClick={() => setSellersExpanded((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors rounded-lg"
            >
              <span className="flex items-center gap-2">
                <Home className="h-4 w-4 text-amber-500" />
                {motivatedSellers.length} Motivated Seller{motivatedSellers.length !== 1 ? "s" : ""} detected
              </span>
              {sellersExpanded ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
            {sellersExpanded && (
              <div className="px-4 pb-4">
                <div className="flex gap-3 overflow-x-auto pb-1">
                  {motivatedSellers.map((seller: any, i: number) => {
                    const prop = seller.property
                    const address = prop?.address ?? "Unknown address"
                    const city = prop?.city ?? ""
                    const score = seller.readiness_to_sell_score ?? 0
                    const timeframe = seller.predicted_timeframe ?? "unknown"
                    const signalType = seller.motivation_type ?? seller.signal_source ?? "signal detected"
                    const profileId = seller.unified_lead_profile_id ?? null
                    return (
                      <div
                        key={seller.id ?? i}
                        className="shrink-0 w-56 rounded-lg border bg-background p-3 flex flex-col gap-2"
                      >
                        <div>
                          <p className="text-sm font-medium leading-snug truncate">{address}</p>
                          {city && <p className="text-xs text-muted-foreground">{city}</p>}
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-amber-700 bg-amber-100 border border-amber-200 rounded-full px-2 py-0.5">
                            Score: {score}
                          </span>
                          <span className="text-xs text-muted-foreground capitalize">{timeframe}</span>
                        </div>
                        <p className="text-xs text-muted-foreground truncate capitalize">{signalType}</p>
                        {profileId && (
                          <a
                            href={`/crm?contact=${profileId}`}
                            className="mt-auto text-xs text-primary underline underline-offset-2 hover:no-underline"
                          >
                            View Profile
                          </a>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

          </TabsContent>

          {/* ── INTELLIGENCE TAB ──────────────────────────────────── */}
          <TabsContent value="intelligence" className="space-y-6 mt-0">

            {/* Stats row */}
            {intelligenceStats && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">Total Profiles</p>
                  <p className="text-2xl font-bold">{intelligenceStats.totalLeads}</p>
                  <p className="text-xs text-emerald-600">{intelligenceStats.hotLeads} hot</p>
                </Card>
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">Ready for Outreach</p>
                  <p className="text-2xl font-bold">{intelligenceStats.readyForOutreach}</p>
                  <p className="text-xs text-muted-foreground">AI-qualified</p>
                </Card>
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">Motivated Sellers</p>
                  <p className="text-2xl font-bold">{intelligenceStats.motivatedSellers}</p>
                  <p className="text-xs text-amber-600">Active signals</p>
                </Card>
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">Pipeline Rate</p>
                  <p className="text-2xl font-bold">
                    {intelligenceStats.totalLeads > 0
                      ? Math.round((intelligenceStats.readyForOutreach / intelligenceStats.totalLeads) * 100)
                      : 0}%
                  </p>
                  <p className="text-xs text-muted-foreground">to outreach</p>
                </Card>
              </div>
            )}

            {/* Batch Reengagement */}
            <div className="flex items-center justify-between rounded-lg border bg-card p-4">
              <div>
                <p className="text-sm font-semibold">AI Batch Reengagement</p>
                <p className="text-xs text-muted-foreground">
                  Identify and plan outreach for leads inactive for 30+ days
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleBatchReengagement}
                  disabled={batchReengagementLoading || !agentId}
                  className="gap-1.5 shrink-0"
                >
                  {batchReengagementLoading
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Zap className="h-3.5 w-3.5 text-amber-500" />}
                  Run Reengagement
                </Button>
                {batchReengagementResult?.success && batchReengagementResult.reengagementPlan && (
                  <Badge variant="secondary" className="text-xs">
                    {batchReengagementResult.reengagementPlan.totalLeads ?? "—"} leads queued
                  </Badge>
                )}
              </div>
            </div>
            {batchReengagementResult?.success && batchReengagementResult.reengagementPlan?.leads?.length > 0 && (
              <div className="rounded-lg border bg-muted/30 p-3 space-y-2 text-xs">
                <p className="font-semibold text-sm">Reengagement Plan</p>
                {batchReengagementResult.reengagementPlan.leads.slice(0, 5).map((lead: any, i: number) => (
                  <div key={i} className="flex items-start justify-between gap-2 border-b pb-2 last:border-0 last:pb-0">
                    <div>
                      <p className="font-medium">{lead.name ?? lead.email ?? `Lead ${i + 1}`}</p>
                      <p className="text-muted-foreground">{lead.recommendedAction ?? lead.action ?? "Follow up"}</p>
                    </div>
                    {lead.priority && (
                      <Badge variant="outline" className="text-xs shrink-0">
                        {lead.priority}
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            )}

          {/* WHO IS CARRYING WHAT. getAgentWorkloadStats aggregated the qualified
              pipeline by assigned agent and had no caller — so "Assign to me"
              above had no counterweight and nobody could see a lopsided desk. */}
            {isAdminOrBroker && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Users className="h-4 w-4 text-primary" />
                  <h2 className="text-base font-semibold">Qualified Pipeline by Agent</h2>
                  <span className="text-xs text-muted-foreground">assigned unified profiles</span>
                </div>
                {workloadLoading ? (
                  <div className="h-20 bg-muted animate-pulse rounded-lg" />
                ) : workload.length === 0 ? (
                  <Card>
                    <CardContent className="py-6 text-center text-muted-foreground text-sm">
                      No profiles are assigned to an agent yet.
                    </CardContent>
                  </Card>
                ) : (
                  <div className="rounded-lg border bg-card divide-y">
                    {workload.map((row) => (
                      <div key={row.agentId} className="flex items-center justify-between gap-3 px-4 py-2">
                        <p className="text-sm font-medium truncate">{row.agentName}</p>
                        <div className="flex items-center gap-1.5 text-[11px] shrink-0">
                          <span className="rounded-full bg-red-100 text-red-700 px-2 py-0.5">{row.hot} hot</span>
                          <span className="rounded-full bg-amber-100 text-amber-700 px-2 py-0.5">{row.warm} warm</span>
                          <span className="rounded-full bg-slate-100 text-slate-600 px-2 py-0.5">{row.cold} cold</span>
                          <span className="rounded-full bg-emerald-100 text-emerald-700 px-2 py-0.5">{row.ready} ready</span>
                          <span className="text-muted-foreground">· {row.total} total</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

          {/* Part C — Top Profiles Ready for Outreach */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-emerald-500" />
                  <h2 className="text-base font-semibold">Top Profiles Ready for Outreach</h2>
                  <span className="text-xs text-muted-foreground">min. 70% confidence · AI-qualified</span>
                </div>
              </div>
              {profilesLoading ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />
                  ))}
                </div>
              ) : unifiedProfiles.length === 0 ? (
                <Card>
                  <CardContent className="py-10 text-center text-muted-foreground text-sm">
                    No profiles at 70%+ confidence yet. Enrich more leads to surface candidates.
                  </CardContent>
                </Card>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {unifiedProfiles.map((profile: any) => {
                    const name =
                      profile.full_name ||
                      `${profile.first_name ?? ""} ${profile.last_name ?? ""}`.trim() ||
                      "Unknown"
                    const confidence = Math.round((profile.confidence_score ?? profile.min_confidence ?? 0) * 100)
                    const leadId = profile.lead_id ?? profile.id
                    const isSelected = selectedLeadId === leadId
                    return (
                      <button
                        key={profile.id}
                        onClick={() => {
                          setSelectedLeadId(isSelected ? null : leadId)
                          setSelectedLeadData(isSelected ? null : profile)
                        }}
                        className={`text-left rounded-lg border bg-card p-4 space-y-2 transition-colors hover:bg-muted/50 w-full ${
                          isSelected ? "border-primary ring-1 ring-primary" : ""
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <p className="font-medium text-sm truncate">{name}</p>
                          <span className="text-xs font-bold text-emerald-600 shrink-0">
                            {confidence}%
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {profile.intent_type && (
                            <Badge variant="outline" className="text-xs capitalize">
                              {profile.intent_type}
                            </Badge>
                          )}
                          {profile.temperature && (
                            <Badge
                              className={`text-xs ${
                                profile.temperature === "hot"
                                  ? "bg-red-100 text-red-700"
                                  : profile.temperature === "warm"
                                  ? "bg-amber-100 text-amber-700"
                                  : "bg-slate-100 text-slate-600"
                              }`}
                            >
                              {profile.temperature}
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center justify-between pt-0.5" onClick={(e) => e.stopPropagation()}>
                          {profile.lead_id ? (
                            <a
                              href={`/leads/${profile.lead_id}`}
                              className="flex items-center gap-1 text-xs text-primary underline underline-offset-2 hover:no-underline"
                            >
                              View lead <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            <span />
                          )}
                          <button
                            type="button"
                            disabled={deliveringId === profile.id || deliveredProfiles.has(profile.id)}
                            onClick={async (e) => {
                              e.stopPropagation()
                              if (deliveredProfiles.has(profile.id) || deliveringId === profile.id) return
                              setDeliveringId(profile.id)
                              try {
                                await deliverIntelligentValue(profile.id)
                                setDeliveredProfiles((prev) => new Set(prev).add(profile.id))
                              } catch {
                                // silent — non-blocking
                              } finally {
                                setDeliveringId(null)
                              }
                            }}
                            className={`flex items-center gap-1 text-xs rounded px-2 py-1 transition-colors ${
                              deliveredProfiles.has(profile.id)
                                ? "bg-emerald-50 text-emerald-700 border border-emerald-200 cursor-default"
                                : "bg-muted hover:bg-muted/80 text-muted-foreground border border-border"
                            } disabled:opacity-60`}
                          >
                            {deliveringId === profile.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : deliveredProfiles.has(profile.id) ? (
                              <>Delivered</>
                            ) : (
                              <><Sparkles className="h-3 w-3" /> Deliver Value</>
                            )}
                          </button>
                        </div>

                        {/* TRIAGE — correct the AI, or claim the lead. */}
                        <div
                          className="flex flex-wrap items-center gap-1 border-t pt-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {(["hot", "warm", "cold"] as const).map((t) => (
                            <button
                              key={t}
                              type="button"
                              disabled={triagingId === profile.id}
                              onClick={(e) => {
                                e.stopPropagation()
                                void applyProfileTriage(profile.id, { temperature: t })
                              }}
                              className={`rounded px-2 py-0.5 text-[11px] border capitalize transition-colors disabled:opacity-60 ${
                                profile.temperature === t
                                  ? "bg-primary text-primary-foreground border-primary"
                                  : "bg-background hover:bg-muted text-muted-foreground border-border"
                              }`}
                            >
                              {t}
                            </button>
                          ))}
                          <button
                            type="button"
                            disabled={triagingId === profile.id}
                            onClick={(e) => {
                              e.stopPropagation()
                              void applyProfileTriage(profile.id, {
                                ready_for_outreach: !profile.ready_for_outreach,
                              })
                            }}
                            className="rounded px-2 py-0.5 text-[11px] border bg-background hover:bg-muted text-muted-foreground border-border transition-colors disabled:opacity-60"
                          >
                            {profile.ready_for_outreach ? "Hold" : "Mark ready"}
                          </button>
                          <button
                            type="button"
                            disabled={triagingId === profile.id}
                            onClick={(e) => {
                              e.stopPropagation()
                              // "me" is resolved server-side to this user's
                              // agents.id — the browser never guesses an id class.
                              void applyProfileTriage(profile.id, { assigned_agent_id: "me" })
                            }}
                            className="rounded px-2 py-0.5 text-[11px] border bg-background hover:bg-muted text-muted-foreground border-border transition-colors disabled:opacity-60"
                          >
                            {triagingId === profile.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              "Assign to me"
                            )}
                          </button>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Canonical LeadIntelligencePanel — shown when a profile is selected */}
            {selectedLeadId && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Brain className="h-4 w-4 text-primary" />
                  <h2 className="text-base font-semibold">Lead Intelligence</h2>
                  <button
                    onClick={() => { setSelectedLeadId(null); setSelectedLeadData(null) }}
                    className="ml-auto text-xs text-muted-foreground underline underline-offset-2 hover:no-underline"
                  >
                    Close
                  </button>
                </div>
                <LeadIntelligencePanel
                  leadId={selectedLeadId}
                  initialData={selectedLeadData}
                />
              </div>
            )}

            {/* Motivated Sellers — expanded by default in Intelligence tab */}
            {motivatedSellers.length > 0 && (
              <div className="rounded-lg border bg-card">
                <div className="flex items-center gap-2 px-4 py-3">
                  <Home className="h-4 w-4 text-amber-500" />
                  <h2 className="text-sm font-semibold">
                    {motivatedSellers.length} Motivated Seller{motivatedSellers.length !== 1 ? "s" : ""} — Active Signals
                  </h2>
                </div>
                <div className="px-4 pb-4">
                  <div className="flex gap-3 overflow-x-auto pb-1">
                    {motivatedSellers.map((seller: any, i: number) => {
                      const prop = seller.property
                      const address = prop?.address ?? "Unknown address"
                      const city = prop?.city ?? ""
                      const score = seller.readiness_to_sell_score ?? 0
                      const timeframe = seller.predicted_timeframe ?? "unknown"
                      const signalType = seller.motivation_type ?? seller.signal_source ?? "signal detected"
                      const profileId = seller.unified_lead_profile_id ?? null
                      return (
                        <div
                          key={seller.id ?? i}
                          className="shrink-0 w-56 rounded-lg border bg-background p-3 flex flex-col gap-2"
                        >
                          <div>
                            <p className="text-sm font-medium leading-snug truncate">{address}</p>
                            {city && <p className="text-xs text-muted-foreground">{city}</p>}
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-amber-700 bg-amber-100 border border-amber-200 rounded-full px-2 py-0.5">
                              Score: {score}
                            </span>
                            <span className="text-xs text-muted-foreground capitalize">{timeframe}</span>
                          </div>
                          <p className="text-xs text-muted-foreground truncate capitalize">{signalType}</p>
                          {profileId && (
                            <a
                              href={`/crm?contact=${profileId}`}
                              className="mt-auto text-xs text-primary underline underline-offset-2 hover:no-underline"
                            >
                              View Profile
                            </a>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}

          </TabsContent>
        </Tabs>

        {/* Admin pipeline stats bar */}
        {isAdminOrBroker && pipelineStats && (
          <div className="grid grid-cols-5 gap-3">
            {/* Unassigned */}
            <button
              type="button"
              onClick={() => setAdminPanelOpen(true)}
              className="flex flex-col items-start gap-1 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-left hover:bg-amber-100 transition-colors"
            >
              <span className="text-xs text-amber-700 font-medium">Unassigned</span>
              <span className="text-2xl font-bold text-amber-900">{pipelineStats.unassigned}</span>
              <span className="text-xs text-amber-600">Assign now</span>
            </button>
            {/* Assigned */}
            <div className="flex flex-col items-start gap-1 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
              <span className="text-xs text-blue-700 font-medium">Assigned</span>
              <span className="text-2xl font-bold text-blue-900">{pipelineStats.assigned}</span>
              <span className="text-xs text-blue-600">Active leads</span>
            </div>
            {/* ISA Working */}
            <button
              type="button"
              onClick={() => router.push("/dashboard/isa")}
              className="flex flex-col items-start gap-1 rounded-lg border border-purple-200 bg-purple-50 px-4 py-3 text-left hover:bg-purple-100 transition-colors"
            >
              <span className="text-xs text-purple-700 font-medium">ISA Working</span>
              <span className="text-2xl font-bold text-purple-900">{pipelineStats.isa_working}</span>
              <span className="text-xs text-purple-600">View ISA</span>
            </button>
            {/* Stale */}
            <button
              type="button"
              onClick={() => setStatusFilter("stale" as any)}
              className="flex flex-col items-start gap-1 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-left hover:bg-red-100 transition-colors"
            >
              <span className="text-xs text-red-700 font-medium">Stale</span>
              <span className="text-2xl font-bold text-red-900">{pipelineStats.stale}</span>
              <span className="text-xs text-red-600">Review leads</span>
            </button>
            {/* Ghost Recovery */}
            <button
              type="button"
              onClick={() => setStatusFilter("ghost" as any)}
              className="flex flex-col items-start gap-1 rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 text-left hover:bg-orange-100 transition-colors"
            >
              <span className="text-xs text-orange-700 font-medium">Ghost Recovery</span>
              <span className="text-2xl font-bold text-orange-900">{pipelineStats.ghost_recovery}</span>
              <span className="text-xs text-orange-600">Review leads</span>
            </button>
          </div>
        )}

        {/* Ready to Convert — only shown to the assigned agent */}
        {!isAdminOrBroker && agentId && (() => {
          const readyLeads = leads.filter(
            (l: any) =>
              l.agent_id === agentId &&
              l.is_active &&
              (l.lead_stage === "qualified" || l.lead_stage === "claimed")
          )
          if (readyLeads.length === 0) return null
          return (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
              <div className="flex items-center gap-2 min-w-0">
                <Users className="shrink-0 h-4 w-4 text-emerald-600" />
                <p className="text-sm text-emerald-900 font-medium">
                  {readyLeads.length} qualified lead{readyLeads.length !== 1 ? "s" : ""} ready to become contact{readyLeads.length !== 1 ? "s" : ""}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="border-emerald-300 text-emerald-800 hover:bg-emerald-100 text-xs h-7 shrink-0"
                onClick={() => setStatusFilter("qualified" as any)}
              >
                View Qualified
              </Button>
            </div>
          )
        })()}

        <Card>
          <CardContent className="p-0">
            {/* Says why the AI Property Match control in each row is inert, rather
                than leaving an agent to discover it by clicking. */}
            <div className="flex items-start gap-2 border-b bg-muted/40 px-4 py-2.5">
              <Brain className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <p className="text-xs text-muted-foreground leading-relaxed">
                <span className="font-medium text-foreground">AI Property Match runs on contacts, not on this screen.</span>{" "}
                Property search reads the brokerage&apos;s IDX Broker feed, which is a contact capability — convert a
                record here and open it in the CRM to use it. The control in each row is disabled for that reason, not
                because it is unavailable.
              </p>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      <button
                        onClick={() => handleSort("source")}
                        className="flex items-center gap-1 hover:text-foreground"
                      >
                        Source
                        <ArrowUpDown className="h-3 w-3" />
                      </button>
                    </TableHead>
                    <TableHead>
                      <button
                        onClick={() => handleSort("first_name")}
                        className="flex items-center gap-1 hover:text-foreground"
                      >
                        Name
                        <ArrowUpDown className="h-3 w-3" />
                      </button>
                    </TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>
                      <button
                        onClick={() => handleSort("ai_score")}
                        className="flex items-center gap-1 hover:text-foreground"
                      >
                        AI Score
                        <ArrowUpDown className="h-3 w-3" />
                      </button>
                    </TableHead>
                    <TableHead>Intent</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead>Readiness</TableHead>
                    {isAdminOrBroker && <TableHead>AI-ISA</TableHead>}
                    <TableHead>
                      <button
                        onClick={() => handleSort("status")}
                        className="flex items-center gap-1 hover:text-foreground"
                      >
                        Status
                        <ArrowUpDown className="h-3 w-3" />
                      </button>
                    </TableHead>
                    <TableHead>
                      <button
                        onClick={() => handleSort("created_at")}
                        className="flex items-center gap-1 hover:text-foreground"
                      >
                        Created
                        <ArrowUpDown className="h-3 w-3" />
                      </button>
                    </TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={isAdminOrBroker ? 12 : 11} className="text-center py-12">
                        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mx-auto" />
                        <p className="text-sm text-muted-foreground mt-2">Loading leads...</p>
                      </TableCell>
                    </TableRow>
                  ) : leads.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={isAdminOrBroker ? 12 : 11} className="text-center py-16">
                        <Search className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
                        <p className="text-sm font-medium text-foreground mb-1">No leads match your filters</p>
                        <p className="text-xs text-muted-foreground mb-4">Try clearing filters or importing new leads</p>
                        <button
                          onClick={() => { setScoreFilter("all"); setIntentFilter("all"); setStatusFilter("all"); setSourceFilter("all"); setSearch("") }}
                          className="text-xs text-primary underline underline-offset-2 hover:no-underline"
                        >
                          Clear all filters
                        </button>
                      </TableCell>
                    </TableRow>
                  ) : (
                    leads.map((lead) => (
                      <Fragment key={lead.id}>
                      <TableRow>
                        <TableCell>
                          <Badge className={cn("capitalize", getSourceColor(lead.source))}>{lead.source}</Badge>
                        </TableCell>
                        <TableCell className="font-medium">
                          {lead.first_name} {lead.last_name}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{lead.email || "—"}</TableCell>
                        <TableCell className="text-muted-foreground">{lead.phone || "—"}</TableCell>
                        <TableCell>
                          <Badge variant={getScoreBadgeVariant(lead.ai_score)} className={getScoreColor(lead.ai_score)}>
                            {lead.ai_score}/5
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {lead.intent ? (
                            <Badge variant="outline" className="capitalize">
                              {lead.intent}
                            </Badge>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell>
                          <LeadStatusBadge lead={lead} />
                        </TableCell>
                        <TableCell>
                          {readiness[lead.id] ? (
                            <Badge
                              variant="outline"
                              className={cn(
                                "capitalize text-xs",
                                readiness[lead.id] === "broker_review_required" &&
                                  "border-red-200 bg-red-50 text-red-700",
                              )}
                            >
                              {readiness[lead.id].replace(/_/g, " ")}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        {isAdminOrBroker && (
                          <TableCell>
                            {lead.reengagement_status === "active" ? (
                              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-purple-100 text-purple-800 border border-purple-200">
                                <Bot className="h-3 w-3" />
                                Active
                              </span>
                            ) : lead.reengagement_status === "completed" ? (
                              <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-emerald-100 text-emerald-800 border border-emerald-200">
                                Recovered
                              </span>
                            ) : lead.reengagement_status === "paused" ? (
                              <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-800 border border-amber-200">
                                Paused
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        )}
                        <TableCell>
                          <Badge variant={getStatusColor(lead.status)} className="capitalize">
                            {lead.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {new Date(lead.created_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {/* AI Property Match Genius USED to sit here. It is a
                                CONTACT capability (owner ruling), so it is gone
                                from this screen rather than left disabled.
                                A disabled control with no handler is INERT, and
                                this repo holds a zero-inert-controls invariant
                                (scripts/wired-surface-simulator.ts): a control
                                that cannot reach a capability teaches an agent to
                                ignore controls. The withdrawal is not silent —
                                the banner above this table says what moved and
                                where to, once, instead of a dead icon on every
                                row. */}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleEnrich(lead.id)}
                              disabled={actionLoading === lead.id || lead.status === "enriched"}
                            >
                              {actionLoading === lead.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Sparkles className="h-4 w-4" />
                              )}
                            </Button>
                            {/* Converted badge */}
                            {convertedIds.has(lead.id) && convertSuccessMap[lead.id] ? (
                              <a
                                href={`/crm?contact=${convertSuccessMap[lead.id]}`}
                                className="flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1 hover:bg-emerald-100"
                              >
                                <UserPlus className="h-3 w-3" />
                                Open in CRM
                              </a>
                            ) : lead.agent_id === agentId &&
                              lead.is_active &&
                              (lead.lead_stage === "qualified" || lead.lead_stage === "claimed") ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs border-emerald-300 text-emerald-800 hover:bg-emerald-50"
                                onClick={() => setConvertConfirmLead(lead)}
                                disabled={convertingId === lead.id}
                              >
                                {convertingId === lead.id ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <UserPlus className="h-3 w-3 mr-1" />
                                )}
                                Convert
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleConvertToContact(lead)}
                                disabled={actionLoading === lead.id || lead.status === "converted"}
                              >
                                <UserPlus className="h-4 w-4" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleReject(lead.id)}
                              disabled={actionLoading === lead.id || lead.status === "rejected"}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      </Fragment>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Showing {(page - 1) * 10 + 1} to {Math.min(page * 10, total)} of {total} leads
            </p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage(page - 1)} disabled={page === 1}>
                <ChevronLeft className="h-4 w-4" />
                Previous
              </Button>
              <div className="flex items-center gap-1">
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  const pageNum = i + 1
                  return (
                    <Button
                      key={pageNum}
                      variant={page === pageNum ? "default" : "outline"}
                      size="sm"
                      onClick={() => setPage(pageNum)}
                    >
                      {pageNum}
                    </Button>
                  )
                })}
              </div>
              <Button variant="outline" size="sm" onClick={() => setPage(page + 1)} disabled={page === totalPages}>
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Available Leads Sheet — agents claim from the brokerage pool */}
      <AvailableLeadsSheet
        open={availableSheetOpen}
        onOpenChange={setAvailableSheetOpen}
        agentId={agentId}
        brokerageId={brokerageId}
        onLeadClaimed={() => fetchLeads()}
      />

      {/* Admin Assignment Panel — admin/broker only */}
      {isAdminOrBroker && (
        <AdminAssignmentPanel
          open={adminPanelOpen}
          onOpenChange={setAdminPanelOpen}
          brokerageId={brokerageId}
          userId={userId}
          onAssigned={() => {
            fetchLeads()
            if (brokerageId) {
              listUnassignedLeads({ brokerageId, limit: 1 })
                .then((r) => setUnassignedCount(r.total ?? (r.leads?.length ?? 0)))
                .catch(() => {})
            }
          }}
        />
      )}

      {/* Lead-to-Contact Conversion Confirmation */}
      <AlertDialog
        open={!!convertConfirmLead}
        onOpenChange={(open) => { if (!open) setConvertConfirmLead(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Convert {convertConfirmLead?.first_name} {convertConfirmLead?.last_name} to a Contact?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Once converted, this lead will appear in your CRM as a full contact. The lead will be marked inactive and all Contact OS features will apply.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!convertingId}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!convertingId}
              onClick={() => convertConfirmLead && handleConvertToContact(convertConfirmLead)}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {convertingId ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-2" />Converting...</>
              ) : (
                "Confirm Conversion"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
