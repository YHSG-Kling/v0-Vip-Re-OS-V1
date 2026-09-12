"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import {
  GraduationCap, Plus, Loader2, AlertTriangle, CheckCircle2,
  Calendar, Award,
} from "lucide-react"
import { logCeCompletion } from "@/app/actions/admin/license-tracking"

interface Profile {
  licenseNumber: string | null
  licenseState: string | null
  licenseExpiry: string | null
  ethicsCompletedAt: string | null
  ethicsDueDate: string | null
  ceHoursRequired: number
  ceHoursCompleted: number
  ceCycleEndDate: string | null
}

interface Completion {
  id: string
  courseName: string
  provider: string | null
  category: string
  hours: number
  completedOn: string
  certificateUrl: string | null
  /** The broker's own record of WHY a credit was entered by hand. Written by
   *  logCeCompletion since it shipped, offered by no form and read by nobody —
   *  see the docblock on listCeCompletions (app/actions/admin/license-tracking.ts:367). */
  notes: string | null
}

interface Props {
  agentId: string
  profile: Profile
  initialCompletions: Completion[]
}

const CATEGORY_LABELS: Record<string, string> = {
  ethics: "Ethics",
  core: "Core",
  elective: "Elective",
  fair_housing: "Fair Housing",
  other: "Other",
}

function daysUntil(date: string | null): number | null {
  if (!date) return null
  return Math.ceil((new Date(date).getTime() - Date.now()) / 86_400_000)
}

function statusBadge(days: number | null) {
  if (days == null) return null
  if (days < 0) return <Badge className="bg-red-100 text-red-800">Expired</Badge>
  if (days <= 30) return <Badge className="bg-red-100 text-red-800">{days}d left</Badge>
  if (days <= 90) return <Badge className="bg-amber-100 text-amber-800">{days}d left</Badge>
  return <Badge className="bg-green-100 text-green-800">{days}d</Badge>
}

export function LicenseCEClient({ agentId, profile, initialCompletions: completions }: Props) {
  // TOMBSTONE — `const [completions, setCompletions] = useState(initialCompletions)`.
  // The setter was never called; the prop is rendered directly. (handleLog ends
  // in window.location.reload(), a full remount, so this list was not frozen in
  // practice — but a writerless copy of a prop is a wire with no other end, and
  // it would freeze the moment that reload became a router.refresh().)
  const [logOpen, setLogOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [courseName, setCourseName] = useState("")
  const [provider, setProvider] = useState("")
  const [category, setCategory] = useState<"ethics" | "core" | "elective" | "fair_housing" | "other">("core")
  const [hours, setHours] = useState("")
  const [completedOn, setCompletedOn] = useState(new Date().toISOString().slice(0, 10))
  const [certificateUrl, setCertificateUrl] = useState("")
  const [notes, setNotes] = useState("")

  const licDays = daysUntil(profile.licenseExpiry)
  const ethicsDays = daysUntil(profile.ethicsDueDate)
  const ceDays = daysUntil(profile.ceCycleEndDate)
  const ceProgress = profile.ceHoursRequired > 0
    ? Math.min(100, (profile.ceHoursCompleted / profile.ceHoursRequired) * 100)
    : 0

  function reset() {
    setCourseName(""); setProvider(""); setCategory("core")
    setHours(""); setCompletedOn(new Date().toISOString().slice(0, 10))
    setCertificateUrl(""); setNotes(""); setError(null)
  }

  function handleLog() {
    setError(null)
    if (!courseName.trim() || !hours || parseFloat(hours) <= 0) {
      setError("Course name and hours are required")
      return
    }
    startTransition(async () => {
      const result = await logCeCompletion({
        agentId,
        courseName: courseName.trim(),
        provider: provider.trim() || undefined,
        category,
        hours: parseFloat(hours),
        completedOn,
        certificateUrl: certificateUrl.trim() || undefined,
        notes: notes.trim() || undefined,
      })
      if (result.success) {
        // Optimistically add to list (full refresh would re-fetch profile too)
        window.location.reload()
      } else {
        setError(result.error ?? "Save failed")
      }
    })
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <GraduationCap className="h-6 w-6 text-blue-600" />
          License & Continuing Education
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Track your license expiration, NAR ethics renewal, and CE hour progress.
        </p>
      </div>

      {/* Status cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Award className="h-4 w-4 text-blue-600" />
              License
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            <p>{profile.licenseNumber ?? "Not set"}</p>
            <p className="text-xs text-muted-foreground">
              {profile.licenseState ?? "—"} · expires {profile.licenseExpiry ? new Date(profile.licenseExpiry).toLocaleDateString() : "—"}
            </p>
            {statusBadge(licDays)}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              NAR Ethics
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            {profile.ethicsCompletedAt ? (
              <>
                <p>Last completed {new Date(profile.ethicsCompletedAt).toLocaleDateString()}</p>
                <p className="text-xs text-muted-foreground">
                  Due {profile.ethicsDueDate ? new Date(profile.ethicsDueDate).toLocaleDateString() : "—"}
                </p>
                {statusBadge(ethicsDays)}
              </>
            ) : (
              <>
                <p className="text-muted-foreground">Not completed yet</p>
                <Badge className="bg-amber-100 text-amber-800">
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Required
                </Badge>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Calendar className="h-4 w-4 text-purple-600" />
              CE Hours
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            <p className="text-2xl font-bold">
              {profile.ceHoursCompleted.toFixed(1)}
              <span className="text-sm text-muted-foreground"> / {profile.ceHoursRequired}</span>
            </p>
            <div className="w-full bg-gray-100 rounded-full h-1.5">
              <div
                className="bg-purple-600 h-1.5 rounded-full"
                style={{ width: `${ceProgress}%` }}
              />
            </div>
            {profile.ceCycleEndDate && (
              <p className="text-xs text-muted-foreground">
                Cycle ends {new Date(profile.ceCycleEndDate).toLocaleDateString()} ({ceDays}d)
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Log */}
      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Completion History</CardTitle>
          <Button size="sm" className="gap-1.5" onClick={() => { setLogOpen(true); reset() }}>
            <Plus className="h-3.5 w-3.5" />
            Log CE Course
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {completions.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No completions logged yet. Log your first course to start tracking CE hours.
            </p>
          ) : (
            <div className="divide-y">
              {completions.map((c) => (
                <div key={c.id} className="px-4 py-2 flex items-center justify-between gap-3 text-sm">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{c.courseName}</p>
                    <p className="text-xs text-muted-foreground">
                      {c.provider ?? "—"} · {new Date(c.completedOn).toLocaleDateString()}
                    </p>
                    {/* Both of these were recorded and unshowable: `notes` was never
                        selected, and `certificate_url` was selected and never rendered. */}
                    {c.notes && <p className="text-xs text-muted-foreground mt-0.5 truncate">{c.notes}</p>}
                    {c.certificateUrl && (
                      <a href={c.certificateUrl} target="_blank" rel="noopener noreferrer"
                        className="text-xs text-primary underline mt-0.5 inline-block">
                        Certificate
                      </a>
                    )}
                  </div>
                  <Badge variant="outline" className="text-xs capitalize">
                    {CATEGORY_LABELS[c.category] ?? c.category}
                  </Badge>
                  <span className="font-semibold text-sm">{c.hours}h</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Log dialog */}
      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log CE Completion</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Course Name</Label>
              <Input value={courseName} onChange={(e) => setCourseName(e.target.value)}
                placeholder="e.g. NAR Code of Ethics 2026" className="mt-1 h-9" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Provider</Label>
                <Input value={provider} onChange={(e) => setProvider(e.target.value)}
                  placeholder="e.g. CE Shop, NAR" className="mt-1 h-9" />
              </div>
              <div>
                <Label className="text-xs">Category</Label>
                <Select value={category} onValueChange={(v) => setCategory(v as any)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ethics">Ethics (NAR)</SelectItem>
                    <SelectItem value="core">Core</SelectItem>
                    <SelectItem value="elective">Elective</SelectItem>
                    <SelectItem value="fair_housing">Fair Housing</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Hours</Label>
                <Input type="number" min="0" step="0.5" value={hours}
                  onChange={(e) => setHours(e.target.value)} className="mt-1 h-9" />
              </div>
              <div>
                <Label className="text-xs">Completion Date</Label>
                <Input type="date" value={completedOn}
                  onChange={(e) => setCompletedOn(e.target.value)} className="mt-1 h-9" />
              </div>
            </div>
            <div>
              <Label className="text-xs">Certificate URL (optional)</Label>
              <Input value={certificateUrl} onChange={(e) => setCertificateUrl(e.target.value)}
                placeholder="https://..." className="mt-1 h-9" />
            </div>
            {/* THE WRITER'S MISSING HALF. logCeCompletion has accepted `notes` and
                written it to agent_ce_completions.notes since it shipped; this form
                never offered anywhere to type one, so the column was NULL on every
                hand-logged credit. It is the audit line on a license record — why a
                credit was entered by hand rather than reported by an accredited
                provider — so it is collected here and rendered on the row below. */}
            <div>
              <Label className="text-xs">Notes (optional)</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. paper certificate on file, reciprocity credit" className="mt-1 h-9" />
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLogOpen(false)}>Cancel</Button>
            <Button onClick={handleLog} disabled={isPending}>
              {isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Log Completion
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
