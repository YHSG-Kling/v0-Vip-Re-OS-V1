"use client"

// Client Learning — the surface for the CONTACT rail of the education kernel.
//
// Before this panel, /dashboard/education could author lessons and show a
// brokerage-wide completion percentage, and there was no way for a human to put
// a lesson in front of a client, to record that a client had finished one, or to
// see how a single lesson was actually performing. Those four capabilities
// existed as server actions with nothing pointed at them.
//
// Every handler here reads the server's verdict before it touches the UI: no
// dialog closes, no list refreshes and no success line renders on the strength
// of the call merely having returned.

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { BookOpen, CheckCircle2, BarChart3, Users, Loader2 } from "lucide-react"
import {
  assignResourceAction,
  recordCompletionAction,
  bulkAssignAction,
  getAnalyticsAction,
} from "@/app/actions/education-kernel"

export interface LearningModuleOption {
  id: string
  title: string
  status: string
  estimated_minutes: number | null
}

export interface ContactOption {
  id: string
  name: string
  email: string | null
}

export function ClientLearningPanel({
  modules,
  contacts,
}: {
  modules: LearningModuleOption[]
  contacts: ContactOption[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // ── Assign one lesson to one client ──
  const [assignContactId, setAssignContactId] = useState("")
  const [assignModuleId, setAssignModuleId] = useState("")
  const [assignError, setAssignError] = useState("")
  const [assignNotice, setAssignNotice] = useState("")

  // ── Record a completion ──
  const [completeContactId, setCompleteContactId] = useState("")
  const [completeModuleId, setCompleteModuleId] = useState("")
  const [completeMinutes, setCompleteMinutes] = useState("10")
  const [completeError, setCompleteError] = useState("")
  const [completeNotice, setCompleteNotice] = useState("")

  // ── Bulk assign ──
  const [bulkModuleIds, setBulkModuleIds] = useState<string[]>([])
  const [bulkContactIds, setBulkContactIds] = useState<string[]>([])
  const [bulkError, setBulkError] = useState("")
  const [bulkNotice, setBulkNotice] = useState("")

  // ── Per-lesson analytics ──
  const [analyticsModuleId, setAnalyticsModuleId] = useState("")
  const [analytics, setAnalytics] = useState<
    { viewCount: number; completionCount: number; openCount: number } | null
  >(null)
  const [analyticsError, setAnalyticsError] = useState("")

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id]

  const handleAssign = () => {
    setAssignError("")
    setAssignNotice("")
    if (!assignContactId || !assignModuleId) {
      setAssignError("Pick a client and a lesson.")
      return
    }
    startTransition(async () => {
      const result = await assignResourceAction({
        contactId: assignContactId,
        resourceId: assignModuleId,
      })
      if (!result.success) {
        setAssignError(result.error ?? "Could not assign that lesson.")
        return
      }
      setAssignNotice("Assigned — it is on that client's learning queue now.")
      setAssignModuleId("")
      router.refresh()
    })
  }

  const handleRecordCompletion = () => {
    setCompleteError("")
    setCompleteNotice("")
    if (!completeContactId || !completeModuleId) {
      setCompleteError("Pick a client and a lesson.")
      return
    }
    const minutes = Number(completeMinutes)
    if (!Number.isFinite(minutes) || minutes < 0) {
      setCompleteError("Time spent must be zero or more minutes.")
      return
    }
    startTransition(async () => {
      const result = await recordCompletionAction({
        contactId: completeContactId,
        resourceId: completeModuleId,
        timeSpentMinutes: minutes,
      })
      if (!result.success) {
        setCompleteError(result.error ?? "Could not record that completion.")
        return
      }
      setCompleteNotice("Recorded — the client's progress and the completion event are both written.")
      router.refresh()
    })
  }

  const handleBulkAssign = () => {
    setBulkError("")
    setBulkNotice("")
    if (bulkModuleIds.length === 0 || bulkContactIds.length === 0) {
      setBulkError("Pick at least one lesson and at least one client.")
      return
    }
    startTransition(async () => {
      const result = await bulkAssignAction({
        resourceIds: bulkModuleIds,
        contactIds: bulkContactIds,
      })
      if (!result.success) {
        setBulkError(result.error ?? "Could not assign those lessons.")
        return
      }
      // Report what the server actually did. Re-running a bulk assign is
      // idempotent, so "already had it" is a real and common outcome and
      // calling it a fresh assignment would be a lie.
      setBulkNotice(
        result.alreadyAssigned > 0
          ? `${result.newlyAssigned} newly assigned · ${result.alreadyAssigned} already had it (of ${result.requested}).`
          : `${result.newlyAssigned} newly assigned.`,
      )
      router.refresh()
    })
  }

  const handleLoadAnalytics = (moduleId: string) => {
    setAnalyticsModuleId(moduleId)
    setAnalytics(null)
    setAnalyticsError("")
    if (!moduleId) return
    startTransition(async () => {
      const result = await getAnalyticsAction({ resourceId: moduleId })
      if (!result.success) {
        setAnalyticsError(result.error ?? "Could not read that lesson's usage.")
        return
      }
      setAnalytics({
        viewCount: result.viewCount,
        completionCount: result.completionCount,
        openCount: result.openCount,
      })
    })
  }

  if (modules.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5" />
            Client Learning
          </CardTitle>
          <CardDescription>Put lessons in front of your clients and track what they finish.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground py-6 text-center">
          Author a lesson above first — there is nothing to assign yet.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookOpen className="h-5 w-5" />
          Client Learning
        </CardTitle>
        <CardDescription>
          Assign lessons to clients, record what they finish, and see how each lesson performs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="assign" className="space-y-4">
          <TabsList>
            <TabsTrigger value="assign">Assign</TabsTrigger>
            <TabsTrigger value="complete">Record completion</TabsTrigger>
            <TabsTrigger value="bulk">Bulk assign</TabsTrigger>
            <TabsTrigger value="analytics">Lesson usage</TabsTrigger>
          </TabsList>

          {/* ── Assign one ── */}
          <TabsContent value="assign" className="space-y-3">
            {contacts.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">
                No clients in your brokerage yet — add a contact to assign lessons.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Client</Label>
                    <Select value={assignContactId} onValueChange={setAssignContactId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a client" />
                      </SelectTrigger>
                      <SelectContent>
                        {contacts.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                            {c.email ? ` — ${c.email}` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Lesson</Label>
                    <Select value={assignModuleId} onValueChange={setAssignModuleId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a lesson" />
                      </SelectTrigger>
                      <SelectContent>
                        {modules.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.title}
                            {m.estimated_minutes ? ` · ${m.estimated_minutes} min` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {assignError && <p className="text-sm text-destructive">{assignError}</p>}
                {assignNotice && <p className="text-sm text-emerald-700">{assignNotice}</p>}
                <Button onClick={handleAssign} disabled={isPending || !assignContactId || !assignModuleId}>
                  {isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <BookOpen className="h-4 w-4 mr-2" />}
                  Assign lesson
                </Button>
              </>
            )}
          </TabsContent>

          {/* ── Record a completion ── */}
          <TabsContent value="complete" className="space-y-3">
            {contacts.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">No clients in your brokerage yet.</p>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <Label>Client</Label>
                    <Select value={completeContactId} onValueChange={setCompleteContactId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a client" />
                      </SelectTrigger>
                      <SelectContent>
                        {contacts.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Lesson</Label>
                    <Select value={completeModuleId} onValueChange={setCompleteModuleId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a lesson" />
                      </SelectTrigger>
                      <SelectContent>
                        {modules.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Minutes spent</Label>
                    <Input
                      type="number"
                      min={0}
                      value={completeMinutes}
                      onChange={(e) => setCompleteMinutes(e.target.value)}
                    />
                  </div>
                </div>
                {completeError && <p className="text-sm text-destructive">{completeError}</p>}
                {completeNotice && <p className="text-sm text-emerald-700">{completeNotice}</p>}
                <Button
                  onClick={handleRecordCompletion}
                  disabled={isPending || !completeContactId || !completeModuleId}
                >
                  {isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
                  Record completion
                </Button>
              </>
            )}
          </TabsContent>

          {/* ── Bulk assign ── */}
          <TabsContent value="bulk" className="space-y-3">
            {contacts.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">No clients in your brokerage yet.</p>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="flex items-center gap-1.5">
                      <BookOpen className="h-3.5 w-3.5" />
                      Lessons ({bulkModuleIds.length} selected)
                    </Label>
                    <div className="border rounded-md max-h-56 overflow-y-auto divide-y">
                      {modules.map((m) => (
                        <label key={m.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-muted/50">
                          <Checkbox
                            checked={bulkModuleIds.includes(m.id)}
                            onCheckedChange={() => setBulkModuleIds((prev) => toggle(prev, m.id))}
                          />
                          <span className="truncate">{m.title}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5" />
                      Clients ({bulkContactIds.length} selected)
                    </Label>
                    <div className="border rounded-md max-h-56 overflow-y-auto divide-y">
                      {contacts.map((c) => (
                        <label key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-muted/50">
                          <Checkbox
                            checked={bulkContactIds.includes(c.id)}
                            onCheckedChange={() => setBulkContactIds((prev) => toggle(prev, c.id))}
                          />
                          <span className="truncate">{c.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
                {bulkError && <p className="text-sm text-destructive">{bulkError}</p>}
                {bulkNotice && <p className="text-sm text-emerald-700">{bulkNotice}</p>}
                <Button
                  onClick={handleBulkAssign}
                  disabled={isPending || bulkModuleIds.length === 0 || bulkContactIds.length === 0}
                >
                  {isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Users className="h-4 w-4 mr-2" />}
                  Assign {bulkModuleIds.length * bulkContactIds.length || ""} lesson-client pair
                  {bulkModuleIds.length * bulkContactIds.length === 1 ? "" : "s"}
                </Button>
              </>
            )}
          </TabsContent>

          {/* ── Lesson usage ── */}
          <TabsContent value="analytics" className="space-y-3">
            <div className="space-y-1.5 max-w-md">
              <Label>Lesson</Label>
              <Select value={analyticsModuleId} onValueChange={handleLoadAnalytics}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a lesson" />
                </SelectTrigger>
                <SelectContent>
                  {modules.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {analyticsError && <p className="text-sm text-destructive">{analyticsError}</p>}

            {analytics && (
              <div className="grid grid-cols-3 gap-3 max-w-md">
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Assigned</p>
                  <p className="text-2xl font-bold">{analytics.viewCount}</p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Completed</p>
                  <p className="text-2xl font-bold text-emerald-700">{analytics.completionCount}</p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs text-muted-foreground">Still open</p>
                  <p className="text-2xl font-bold text-amber-700">{analytics.openCount}</p>
                </div>
              </div>
            )}

            {analyticsModuleId && !analytics && !analyticsError && (
              <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                <BarChart3 className="h-4 w-4" />
                Reading usage…
              </p>
            )}
          </TabsContent>
        </Tabs>

        <div className="mt-4 flex flex-wrap gap-1.5">
          <Badge variant="secondary" className="text-xs">
            {modules.length} lesson{modules.length === 1 ? "" : "s"}
          </Badge>
          <Badge variant="secondary" className="text-xs">
            {contacts.length} client{contacts.length === 1 ? "" : "s"}
          </Badge>
        </div>
      </CardContent>
    </Card>
  )
}
