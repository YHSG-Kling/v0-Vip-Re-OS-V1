"use client"

import { useEffect, useState, useRef } from "react"
import { useParams, useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Progress } from "@/components/ui/progress"
import { DealShakyToggle } from "@/components/transactions/DealShakyToggle"
import { WalkthroughOutcomeButtons } from "@/components/transactions/WalkthroughOutcomeButtons"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import {
  Send,
  MoreVertical,
  Clock,
  CheckCircle,
  AlertTriangle,
  FileText,
  MessageSquare,
  Calendar,
  DollarSign,
  Home,
  Users,
  Activity,
  TrendingUp,
  Phone,
  Mail,
  Upload,
  Download,
  Loader2,
} from "lucide-react"
import { loadClientDashboard } from "@/app/actions/transactions"
import { createClient } from "@/lib/supabase/client"

export default function AgentTransactionDetailPage() {
  const params = useParams()
  const router = useRouter()
  const transactionId = params.transactionId as string
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState("overview")

  // Documents tab state
  const [documents, setDocuments] = useState<any[]>([])
  const [docsLoading, setDocsLoading] = useState(false)
  const [uploadingDoc, setUploadingDoc] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Communications tab state — unified timeline from transaction_timeline + activities + lifecycle_events
  const [commsItems, setCommsItems] = useState<any[]>([])
  const [commsLoading, setCommsLoading] = useState(false)

  useEffect(() => {
    async function loadData() {
      try {
        const dashboardData = await loadClientDashboard(transactionId)
        setData(dashboardData)
      } catch (error) {
        console.error("[v0] Failed to load transaction:", error)
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [transactionId])

  // Lazy-load documents when the Documents tab is first opened
  useEffect(() => {
    if (activeTab !== "documents" || documents.length > 0 || docsLoading) return
    setDocsLoading(true)
    const supabase = createClient()
    supabase
      .from("transaction_documents")
      .select("id, doc_type, doc_label, status, storage_url, uploaded_at, uploaded_by, notes")
      .eq("transaction_id", transactionId)
      .order("uploaded_at", { ascending: false })
      .then(({ data: rows }: { data: any[] | null }) => {
        setDocuments(rows ?? [])
        setDocsLoading(false)
      })
  }, [activeTab, transactionId])

  // Lazy-load communications when the Communications tab is first opened
  useEffect(() => {
    if (activeTab !== "communications" || commsItems.length > 0 || commsLoading) return
    setCommsLoading(true)
    const supabase = createClient()

    Promise.all([
      // transaction_timeline — primary source
      supabase
        .from("transaction_timeline")
        .select("id, activity_type, description, performed_by, created_at, metadata")
        .eq("transaction_id", transactionId)
        .order("created_at", { ascending: false })
        .limit(50),
      // activities — any linked directly to this transaction
      supabase
        .from("activities")
        .select("id, activity_type, title, description, created_at, status")
        .eq("transaction_id", transactionId)
        .order("created_at", { ascending: false })
        .limit(30),
      // lifecycle_events — entity_type = 'transaction'
      supabase
        .from("lifecycle_events")
        .select("id, event_type, metadata, created_at, actor_user_id")
        .eq("entity_id", transactionId)
        .eq("entity_type", "transaction")
        .order("created_at", { ascending: false })
        .limit(30),
    ]).then(([timelineRes, activitiesRes, lifecycleRes]) => {
      const timeline = (timelineRes.data ?? []).map((r: any) => ({
        ...r,
        _source: "timeline",
        label: r.activity_type,
        text: r.description,
      }))
      const activities = (activitiesRes.data ?? []).map((r: any) => ({
        ...r,
        _source: "activity",
        label: r.activity_type,
        text: r.title + (r.description ? ` — ${r.description}` : ""),
      }))
      const lifecycle = (lifecycleRes.data ?? []).map((r: any) => ({
        ...r,
        _source: "lifecycle",
        label: r.event_type,
        text: r.event_type.replace(/_/g, " "),
      }))
      const merged = [...timeline, ...activities, ...lifecycle].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )
      setCommsItems(merged)
      setCommsLoading(false)
    })
  }, [activeTab, transactionId])

  async function handleDocumentUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadingDoc(true)
    const supabase = createClient()
    const path = `transactions/${transactionId}/documents/${Date.now()}_${file.name}`
    const { error: uploadError } = await supabase.storage.from("transaction-documents").upload(path, file)
    if (uploadError) {
      setUploadingDoc(false)
      return
    }
    const { data: urlData } = supabase.storage.from("transaction-documents").getPublicUrl(path)
    const { data: inserted } = await supabase
      .from("transaction_documents")
      .insert({
        transaction_id: transactionId,
        doc_label: file.name,
        doc_type: "upload",
        status: "pending",
        storage_url: urlData.publicUrl,
        uploaded_at: new Date().toISOString(),
      })
      .select("id, doc_type, doc_label, status, storage_url, uploaded_at, uploaded_by, notes")
      .single()
    if (inserted) setDocuments((prev) => [inserted, ...prev])
    setUploadingDoc(false)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  if (loading) {
    return (
      <div className="container mx-auto py-8">
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="container mx-auto py-8">
        <div className="text-center">
          <h2 className="text-2xl font-bold">Transaction not found</h2>
          <Button className="mt-4" onClick={() => router.push("/dashboard")}>
            Back to Dashboard
          </Button>
        </div>
      </div>
    )
  }

  const getStageColor = (stage: string) => {
    const colors: Record<string, string> = {
      offer: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
      inspection: "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300",
      appraisal: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300",
      financing: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
      clear_to_close: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
      closed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    }
    return colors[stage] || "bg-gray-100 text-gray-800 dark:bg-gray-950 dark:text-gray-300"
  }

  const getHealthColor = (indicator: string) => {
    if (indicator === "on_track") return "bg-green-500"
    if (indicator === "needs_attention") return "bg-yellow-500 animate-pulse"
    return "bg-red-500 animate-pulse"
  }

  const healthScore = data.team?.[0]?.transactions?.health_score || 75

  return (
    <div className="container mx-auto py-6 space-y-6">
      {/* "Deal feels shaky" — the agent's gut suspends earned autonomy on this file */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <WalkthroughOutcomeButtons transactionId={transactionId} />
        <DealShakyToggle transactionId={transactionId} />
      </div>
      {/* Header */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-4">
              <div className="p-3 bg-primary/10 rounded-lg">
                <Home className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-foreground">{data.hero.property_address}</h1>
                <div className="flex items-center gap-3 mt-2">
                  <Badge className={cn("font-semibold", getStageColor(data.hero.current_stage_display))}>
                    {data.hero.current_stage_display}
                  </Badge>
                  <span className="text-sm text-muted-foreground">
                    Closing: {data.hero.days_until_closing > 0 ? `in ${data.hero.days_until_closing} days` : "TBD"}
                  </span>
                  <div className="flex items-center gap-2">
                    <div className={cn("w-2 h-2 rounded-full", getHealthColor(data.hero.health_indicator))} />
                    <span className="text-sm text-muted-foreground">Health: {healthScore}/100</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Quick Actions */}
            <div className="flex gap-2">
              <Button variant="default" size="sm">
                <Send className="w-4 h-4 mr-2" />
                Update Client
              </Button>
              <Button variant="outline" size="sm">
                <MoreVertical className="w-5 h-5" />
              </Button>
            </div>
          </div>

          {/* Progress Bar */}
          <div className="mt-6">
            <div className="flex justify-between text-sm mb-2">
              <span className="text-muted-foreground">Transaction Progress</span>
              <span className="font-medium">{data.hero.progress_percent}%</span>
            </div>
            <Progress value={data.hero.progress_percent} className="h-2" />
          </div>
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <div className="overflow-x-auto">
          <TabsList className="flex min-w-max sm:grid sm:w-full sm:grid-cols-6">
            <TabsTrigger value="overview" className="min-h-[44px] sm:min-h-0 min-w-[90px] sm:min-w-0">Overview</TabsTrigger>
            <TabsTrigger value="timeline" className="min-h-[44px] sm:min-h-0 min-w-[90px] sm:min-w-0">Timeline</TabsTrigger>
            <TabsTrigger value="tasks" className="min-h-[44px] sm:min-h-0 min-w-[80px] sm:min-w-0">Tasks</TabsTrigger>
            <TabsTrigger value="documents" className="min-h-[44px] sm:min-h-0 min-w-[100px] sm:min-w-0">Documents</TabsTrigger>
            <TabsTrigger value="communications" className="min-h-[44px] sm:min-h-0 min-w-[80px] sm:min-w-0">Comms</TabsTrigger>
            <TabsTrigger value="financials" className="min-h-[44px] sm:min-h-0 min-w-[90px] sm:min-w-0">Financials</TabsTrigger>
          </TabsList>
        </div>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Client Info */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Users className="h-5 w-5" />
                  Client Information
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {data.team.map((member: any, idx: number) => (
                  <div key={idx} className="space-y-2">
                    <p className="font-medium">{member.agents?.name || "Client Name"}</p>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Phone className="h-4 w-4" />
                      <span>{member.agents?.phone || "No phone"}</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Mail className="h-4 w-4" />
                      <span>{member.agents?.email || "No email"}</span>
                    </div>
                  </div>
                ))}
                <Separator />
                <div className="space-y-2">
                  <Button variant="outline" size="sm" className="w-full justify-start bg-transparent">
                    <Phone className="h-4 w-4 mr-2" />
                    Call Client
                  </Button>
                  <Button variant="outline" size="sm" className="w-full justify-start bg-transparent">
                    <Mail className="h-4 w-4 mr-2" />
                    Send Email
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Key Dates */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Calendar className="h-5 w-5" />
                  Key Dates
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.timeline.slice(0, 5).map((milestone: any, idx: number) => (
                  <div key={idx} className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">{milestone.name}</span>
                    <Badge variant={milestone.status === "completed" ? "default" : "outline"} className="text-xs">
                      {new Date(milestone.date).toLocaleDateString()}
                    </Badge>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Transaction Health */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Activity className="h-5 w-5" />
                  Transaction Health
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-center">
                  <div className="text-4xl font-bold mb-2">{healthScore}</div>
                  <p className="text-sm text-muted-foreground">Overall Health Score</p>
                </div>
                <Separator />
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>Timeline Adherence</span>
                    <span className="font-medium">92%</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span>Document Completion</span>
                    <span className="font-medium">85%</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span>Client Engagement</span>
                    <span className="font-medium">78%</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Recent Activity */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5" />
                Recent Activity
              </CardTitle>
              <CardDescription>Latest updates and milestones</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {data.updates.slice(0, 5).map((update: any, idx: number) => (
                  <div key={idx} className="flex items-start gap-3 pb-4 border-b last:border-0">
                    <div
                      className={cn(
                        "p-2 rounded-full",
                        update.type === "celebration"
                          ? "bg-green-100 dark:bg-green-950"
                          : "bg-blue-100 dark:bg-blue-950",
                      )}
                    >
                      {update.type === "celebration" ? (
                        <CheckCircle className="h-4 w-4 text-green-600" />
                      ) : (
                        <Activity className="h-4 w-4 text-blue-600" />
                      )}
                    </div>
                    <div className="flex-1">
                      <p className="text-sm">{update.text}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {new Date(update.timestamp).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Timeline Tab */}
        <TabsContent value="timeline" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Transaction Timeline</CardTitle>
              <CardDescription>All milestones and their status</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                {data.timeline.map((milestone: any, idx: number) => (
                  <div key={idx} className="flex gap-4">
                    <div className="flex flex-col items-center">
                      <div
                        className={cn(
                          "w-10 h-10 rounded-full flex items-center justify-center",
                          milestone.status === "completed"
                            ? "bg-green-100 dark:bg-green-950"
                            : "bg-gray-100 dark:bg-gray-950",
                        )}
                      >
                        {milestone.status === "completed" ? (
                          <CheckCircle className="h-5 w-5 text-green-600" />
                        ) : (
                          <Clock className="h-5 w-5 text-gray-600" />
                        )}
                      </div>
                      {idx < data.timeline.length - 1 && <div className="w-px h-12 bg-border mt-2" />}
                    </div>
                    <div className="flex-1 pb-6">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <h4 className="font-semibold">{milestone.name}</h4>
                          <p className="text-sm text-muted-foreground mt-1">{milestone.description}</p>
                        </div>
                        <Badge variant={milestone.status === "completed" ? "default" : "outline"}>
                          {new Date(milestone.date).toLocaleDateString()}
                        </Badge>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tasks Tab */}
        <TabsContent value="tasks" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Action Items</CardTitle>
              <CardDescription>Tasks and pending items</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {data.next_actions.map((task: any) => (
                  <div key={task.id} className="flex items-center justify-between p-3 border rounded-lg">
                    <div className="flex items-center gap-3">
                      <div
                        className={cn(
                          "w-5 h-5 rounded border-2",
                          task.priority === "high" ? "border-red-500" : "border-gray-300",
                        )}
                      />
                      <div>
                        <p className="font-medium text-sm">{task.task}</p>
                        <p className="text-xs text-muted-foreground">Due: {new Date(task.due_date).toLocaleDateString()}</p>
                      </div>
                    </div>
                    <Badge variant={task.priority === "high" ? "destructive" : "secondary"}>{task.priority}</Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Documents Tab */}
        <TabsContent value="documents" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="h-5 w-5" />
                    Transaction Documents
                  </CardTitle>
                  <CardDescription>All contracts, disclosures, and forms</CardDescription>
                </div>
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    onChange={handleDocumentUpload}
                    accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"
                  />
                  <Button
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingDoc}
                  >
                    {uploadingDoc ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Upload className="h-4 w-4 mr-2" />
                    )}
                    Upload Document
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {docsLoading ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : documents.length === 0 ? (
                <div className="text-center py-10">
                  <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
                  <p className="text-muted-foreground">No documents yet — upload the first one</p>
                </div>
              ) : (
                <div className="divide-y">
                  {documents.map((doc) => (
                    <div key={doc.id} className="flex items-center justify-between py-3">
                      <div className="flex items-start gap-3">
                        <FileText className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
                        <div>
                          <p className="text-sm font-medium">{doc.doc_label || doc.doc_type}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <Badge variant="outline" className="text-xs capitalize">
                              {doc.doc_type}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {doc.uploaded_at
                                ? new Date(doc.uploaded_at).toLocaleDateString()
                                : "—"}
                            </span>
                          </div>
                          {doc.notes && (
                            <p className="text-xs text-muted-foreground mt-0.5">{doc.notes}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={doc.status === "approved" ? "default" : "secondary"}
                          className="text-xs capitalize"
                        >
                          {doc.status}
                        </Badge>
                        {doc.storage_url && (
                          <Button variant="ghost" size="sm" asChild>
                            <a href={doc.storage_url} target="_blank" rel="noopener noreferrer">
                              <Download className="h-4 w-4" />
                            </a>
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Communications Tab */}
        <TabsContent value="communications" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageSquare className="h-5 w-5" />
                Communications Log
              </CardTitle>
              <CardDescription>Unified timeline from all sources — timeline events, activities, and system events</CardDescription>
            </CardHeader>
            <CardContent>
              {commsLoading ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : commsItems.length === 0 ? (
                <div className="text-center py-10">
                  <MessageSquare className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
                  <p className="text-muted-foreground">No communications yet</p>
                </div>
              ) : (
                <div className="space-y-0">
                  {commsItems.map((item, idx) => {
                    const sourceColors: Record<string, string> = {
                      timeline: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
                      activity: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
                      lifecycle: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
                    }
                    const sourceLabel: Record<string, string> = {
                      timeline: "Timeline",
                      activity: "Activity",
                      lifecycle: "System",
                    }
                    return (
                      <div key={item.id ?? idx} className="flex gap-3 pb-4 border-b last:border-0 pt-4 first:pt-0">
                        <div className="flex flex-col items-center">
                          <div className="w-2 h-2 rounded-full bg-primary mt-1.5 shrink-0" />
                          {idx < commsItems.length - 1 && (
                            <div className="w-px flex-1 bg-border mt-1" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge
                              className={cn("text-xs font-normal capitalize", sourceColors[item._source])}
                            >
                              {sourceLabel[item._source]}
                            </Badge>
                            <Badge variant="outline" className="text-xs font-normal capitalize">
                              {(item.label ?? "").replace(/_/g, " ")}
                            </Badge>
                          </div>
                          <p className="text-sm mt-1 capitalize">{item.text}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {new Date(item.created_at).toLocaleString()}
                          </p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Financials Tab */}
        <TabsContent value="financials" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <DollarSign className="h-5 w-5" />
                Financial Details
              </CardTitle>
              <CardDescription>Purchase price, costs, and commission</CardDescription>
            </CardHeader>
            <CardContent>
              {data.costs ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-muted-foreground">Purchase Price</p>
                      <p className="text-2xl font-bold">${data.costs.purchase_price?.toLocaleString() || "TBD"}</p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Est. Commission</p>
                      <p className="text-2xl font-bold">${data.costs.estimated_commission?.toLocaleString() || "TBD"}</p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8">
                  <DollarSign className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
                  <p className="text-muted-foreground">Financial details not available</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
