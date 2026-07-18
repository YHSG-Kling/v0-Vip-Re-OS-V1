"use client"

/**
 * YOUR AI TEAMMATES — the tenant's own chartered AI team, beside the built-in
 * manager bench. Each teammate is a tenant-named identity on a built-in
 * manager ("Maya — Luxury Listings Concierge" on the Marketing Manager) with
 * a charter that genuinely feeds draft composition and a base-manager badge
 * from the canonical registry. Create / edit / pause / retire here; autonomy
 * shown honestly — the server clamps any request past what the tenancy's
 * earned-autonomy ledger allows, and this panel says so.
 */

import { useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Bot, Loader2, Pencil, Pause, Play, Plus, Trash2, X } from "lucide-react"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import {
  TEAMMATE_AUTONOMY_LEVELS,
  TEAMMATE_AUTONOMY_LABELS,
  grantLedgerForManager,
  type TeammateAutonomy,
} from "@/lib/kernel/ai-teammates"
import {
  createAiTeammateAction,
  updateAiTeammateAction,
  setAiTeammateStatusAction,
  type AiTeammateView,
} from "@/app/actions/ai-teammates"

interface FormState {
  id: string | null // null = creating
  name: string
  roleTitle: string
  baseManagerKey: ManagerKey
  charter: string
  focusTags: string
  autonomy: TeammateAutonomy
}

const EMPTY_FORM: FormState = {
  id: null,
  name: "",
  roleTitle: "",
  baseManagerKey: "marketing_agent",
  charter: "",
  focusTags: "",
  autonomy: "draft_only",
}

const MANAGER_KEYS = Object.keys(MANAGERS) as ManagerKey[]

export function AiTeammatesPanel({
  teammates: initial,
  limit,
  autonomousUnlocked,
}: {
  teammates: AiTeammateView[]
  /** null = unlimited on this tier. */
  limit: number | null
  /** Base manager keys where 'autonomous' is currently earned. */
  autonomousUnlocked: string[]
}) {
  const [teammates, setTeammates] = useState<AiTeammateView[]>(initial)
  const [form, setForm] = useState<FormState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [saving, startSaving] = useTransition()

  const atLimit = limit !== null && teammates.length >= limit
  const unlockedSet = new Set(autonomousUnlocked)

  const openCreate = () => { setError(null); setNote(null); setForm({ ...EMPTY_FORM }) }
  const openEdit = (t: AiTeammateView) => {
    setError(null); setNote(null)
    setForm({
      id: t.id,
      name: t.name,
      roleTitle: t.roleTitle,
      baseManagerKey: (t.baseManagerKey in MANAGERS ? t.baseManagerKey : "marketing_agent") as ManagerKey,
      charter: t.charter,
      focusTags: t.focusTags.join(", "),
      autonomy: t.autonomy,
    })
  }

  const submit = () => {
    if (!form) return
    setError(null); setNote(null)
    const input = {
      name: form.name,
      roleTitle: form.roleTitle,
      baseManagerKey: form.baseManagerKey,
      charter: form.charter,
      focusTags: form.focusTags.split(",").map((t) => t.trim()).filter(Boolean),
      autonomy: form.autonomy,
    }
    startSaving(async () => {
      const r = form.id
        ? await updateAiTeammateAction({ id: form.id, ...input })
        : await createAiTeammateAction(input)
      if (!r.ok) { setError(r.error); return }
      setTeammates((prev) => form.id
        ? prev.map((t) => (t.id === form.id ? r.teammate : t))
        : [...prev, r.teammate])
      if (r.autonomyNote) setNote(r.autonomyNote)
      setForm(null)
    })
  }

  const setStatus = (t: AiTeammateView, status: "active" | "paused" | "retired") => {
    setBusyId(t.id); setError(null)
    startSaving(async () => {
      try {
        const r = await setAiTeammateStatusAction({ id: t.id, status })
        if (!r.ok) { setError(r.error); return }
        setTeammates((prev) => status === "retired"
          ? prev.filter((x) => x.id !== t.id)
          : prev.map((x) => (x.id === t.id ? r.teammate : x)))
      } finally {
        setBusyId(null)
      }
    })
  }

  const autonomyHint = (managerKey: ManagerKey): string => {
    if (unlockedSet.has(managerKey)) return "Your team has earned autonomy in this domain — 'autonomous' is available."
    return grantLedgerForManager(managerKey)
      ? "Requests for 'autonomous' are held at approval until this domain earns a grant (see Earned autonomy)."
      : "This domain has no autonomy ladder — teammates run at approval; every send clears your queue."
  }

  return (
    <Card className="border-l-4 border-l-sky-500">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-lg">Your AI teammates</CardTitle>
            <CardDescription>
              Name and charter your own teammates on the built-in manager bench — their charter shapes every draft in their domain
              {limit !== null ? ` · ${teammates.length}/${limit} on your plan` : ""}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-sky-600" />
            {!form && (
              <Button size="sm" className="h-7 gap-1 text-xs" onClick={openCreate} disabled={atLimit || saving}>
                <Plus className="h-3 w-3" /> New teammate
              </Button>
            )}
          </div>
        </div>
        {atLimit && !form && (
          <p className="text-xs text-amber-700 mt-1">
            Your plan includes {limit} custom teammate{limit === 1 ? "" : "s"} — retire one or upgrade to add more.
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p className="text-sm text-red-700 rounded-md border border-red-200 bg-red-50 px-3 py-2">{error}</p>}
        {note && <p className="text-sm text-amber-800 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">{note}</p>}

        {form && (
          <div className="rounded-lg border p-4 space-y-3 bg-muted/20">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">{form.id ? "Edit teammate" : "Charter a new teammate"}</p>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setForm(null)} disabled={saving}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="tm-name" className="text-xs">Name</Label>
                <Input id="tm-name" placeholder="Maya" value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="tm-role" className="text-xs">Role title</Label>
                <Input id="tm-role" placeholder="Luxury Listings Concierge" value={form.roleTitle}
                  onChange={(e) => setForm({ ...form, roleTitle: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="tm-base" className="text-xs">Built on</Label>
                <select
                  id="tm-base"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={form.baseManagerKey}
                  onChange={(e) => setForm({ ...form, baseManagerKey: e.target.value as ManagerKey })}
                >
                  {MANAGER_KEYS.map((k) => (
                    <option key={k} value={k}>{MANAGERS[k].label} — {MANAGERS[k].domain}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="tm-autonomy" className="text-xs">Autonomy</Label>
                <select
                  id="tm-autonomy"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={form.autonomy}
                  onChange={(e) => setForm({ ...form, autonomy: e.target.value as TeammateAutonomy })}
                >
                  {TEAMMATE_AUTONOMY_LEVELS.map((a) => (
                    <option key={a} value={a}>{TEAMMATE_AUTONOMY_LABELS[a]}</option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground">{autonomyHint(form.baseManagerKey)}</p>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="tm-charter" className="text-xs">Charter</Label>
              <Textarea
                id="tm-charter" rows={3}
                placeholder="Own our luxury listing presence: every draft leads with the property's story, never with price. Warm, editorial tone; always offer a private showing."
                value={form.charter}
                onChange={(e) => setForm({ ...form, charter: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tm-tags" className="text-xs">Focus tags (comma-separated)</Label>
              <Input id="tm-tags" placeholder="luxury, waterfront, relocation" value={form.focusTags}
                onChange={(e) => setForm({ ...form, focusTags: e.target.value })} />
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setForm(null)} disabled={saving}>Cancel</Button>
              <Button size="sm" className="h-8 text-xs gap-1" onClick={submit} disabled={saving}>
                {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                {form.id ? "Save changes" : "Create teammate"}
              </Button>
            </div>
          </div>
        )}

        {teammates.length === 0 && !form ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No custom teammates yet — create your first and the AI team starts answering in your people's names.
          </p>
        ) : (
          <ul className="space-y-2">
            {teammates.map((t) => {
              const accent = t.baseManagerKey in MANAGERS
                ? MANAGERS[t.baseManagerKey as ManagerKey].accent
                : "bg-slate-100 text-slate-700"
              const busy = busyId === t.id
              return (
                <li key={t.id} className="rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold">{t.name}</span>
                        <span className="text-sm text-muted-foreground">— {t.roleTitle}</span>
                        <Badge className={accent} title={t.baseManagerKey in MANAGERS ? MANAGERS[t.baseManagerKey as ManagerKey].domain : ""}>
                          {t.baseManagerLabel}
                        </Badge>
                        <Badge className={t.autonomy === "autonomous" ? "bg-emerald-100 text-emerald-800" : t.autonomy === "approved_send" ? "bg-sky-100 text-sky-800" : "bg-slate-100 text-slate-700"}>
                          {TEAMMATE_AUTONOMY_LABELS[t.autonomy]}
                        </Badge>
                        {t.status === "paused" && <Badge className="bg-amber-100 text-amber-800">paused</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{t.charter}</p>
                      {t.focusTags.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {t.focusTags.map((tag) => (
                            <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{tag}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Edit"
                        disabled={saving} onClick={() => openEdit(t)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                        title={t.status === "active" ? "Pause — stops charter injection and attributions" : "Resume"}
                        disabled={saving}
                        onClick={() => setStatus(t, t.status === "active" ? "paused" : "active")}>
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t.status === "active" ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-600 hover:text-red-700" title="Retire"
                        disabled={saving} onClick={() => setStatus(t, "retired")}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
