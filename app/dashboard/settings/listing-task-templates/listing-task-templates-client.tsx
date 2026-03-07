"use client"

import { useState, useTransition } from "react"
import type { ListingTaskTemplate } from "@/app/actions/settings/listing-task-templates"
import {
  createListingTaskTemplate,
  updateListingTaskTemplate,
  deleteListingTaskTemplate,
} from "@/app/actions/settings/listing-task-templates"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog"

const STAGES = [
  "PRE_LISTING",
  "LISTING_PREP",
  "COMING_SOON",
  "MLS_ACTIVE",
  "UNDER_CONTRACT",
  "CLOSED",
  "LIFETIME_CUSTOMER",
]

const PRIORITIES = ["low", "medium", "high", "critical"]
const OWNER_ROLES = ["agent", "TC", "admin", "seller"]

const PRIORITY_COLORS: Record<string, string> = {
  low:      "bg-slate-100 text-slate-700",
  medium:   "bg-amber-100 text-amber-700",
  high:     "bg-orange-100 text-orange-700",
  critical: "bg-red-100 text-red-700",
}

const STAGE_COLORS: Record<string, string> = {
  PRE_LISTING:       "bg-gray-100 text-gray-700",
  LISTING_PREP:      "bg-blue-100 text-blue-700",
  COMING_SOON:       "bg-purple-100 text-purple-700",
  MLS_ACTIVE:        "bg-green-100 text-green-700",
  UNDER_CONTRACT:    "bg-amber-100 text-amber-700",
  CLOSED:            "bg-teal-100 text-teal-700",
  LIFETIME_CUSTOMER: "bg-indigo-100 text-indigo-700",
}

type FormState = {
  stage: string
  title: string
  description: string
  owner_role: string
  due_offset_days: number
  priority: string
  is_required: boolean
}

const EMPTY_FORM: FormState = {
  stage:           "PRE_LISTING",
  title:           "",
  description:     "",
  owner_role:      "agent",
  due_offset_days: 0,
  priority:        "medium",
  is_required:     true,
}

export function ListingTaskTemplatesClient({
  templates: initialTemplates,
}: {
  templates: ListingTaskTemplate[]
}) {
  const [templates, setTemplates] = useState(initialTemplates)
  const [filterStage, setFilterStage] = useState<string>("all")
  const [showCreate, setShowCreate] = useState(false)
  const [editTarget, setEditTarget] = useState<ListingTaskTemplate | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ListingTaskTemplate | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const filtered = filterStage === "all"
    ? templates
    : templates.filter(t => t.stage === filterStage)

  const grouped = STAGES.reduce<Record<string, ListingTaskTemplate[]>>((acc, stage) => {
    acc[stage] = filtered.filter(t => t.stage === stage)
    return acc
  }, {})

  function openCreate() {
    setForm(EMPTY_FORM)
    setError(null)
    setShowCreate(true)
  }

  function openEdit(t: ListingTaskTemplate) {
    setForm({
      stage:           t.stage,
      title:           t.title,
      description:     t.description ?? "",
      owner_role:      t.owner_role,
      due_offset_days: t.due_offset_days,
      priority:        t.priority,
      is_required:     t.is_required,
    })
    setError(null)
    setEditTarget(t)
  }

  function handleCreate() {
    if (!form.title.trim()) { setError("Title is required"); return }
    setError(null)
    startTransition(async () => {
      const res = await createListingTaskTemplate({
        ...form,
        description: form.description || undefined,
      })
      if (!res.success) { setError(res.error ?? "Failed"); return }
      setShowCreate(false)
      // Optimistic — re-fetch via router.refresh() equivalent: reload
      window.location.reload()
    })
  }

  function handleEdit() {
    if (!editTarget || !form.title.trim()) { setError("Title is required"); return }
    setError(null)
    startTransition(async () => {
      const res = await updateListingTaskTemplate(editTarget.id, {
        title:           form.title,
        description:     form.description || undefined,
        owner_role:      form.owner_role,
        due_offset_days: form.due_offset_days,
        priority:        form.priority,
        is_required:     form.is_required,
      })
      if (!res.success) { setError(res.error ?? "Failed"); return }
      setEditTarget(null)
      window.location.reload()
    })
  }

  function handleDelete() {
    if (!deleteTarget) return
    startTransition(async () => {
      await deleteListingTaskTemplate(deleteTarget.id)
      setTemplates(prev => prev.filter(t => t.id !== deleteTarget.id))
      setDeleteTarget(null)
    })
  }

  function handleToggleActive(t: ListingTaskTemplate) {
    startTransition(async () => {
      await updateListingTaskTemplate(t.id, { is_active: !t.is_active })
      setTemplates(prev =>
        prev.map(x => x.id === t.id ? { ...x, is_active: !x.is_active } : x)
      )
    })
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Listing Task Templates</h1>
          <p className="text-sm text-gray-500 mt-1">
            Define required tasks per lifecycle stage. Templates auto-generate tasks when a listing advances.
          </p>
        </div>
        <Button onClick={openCreate} className="shrink-0">
          Add Template
        </Button>
      </div>

      {/* Stage filter */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => setFilterStage("all")}
          className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
            filterStage === "all"
              ? "bg-gray-900 text-white border-gray-900"
              : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
          }`}
        >
          All stages
        </button>
        {STAGES.map(s => (
          <button
            key={s}
            onClick={() => setFilterStage(s)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              filterStage === s
                ? "bg-gray-900 text-white border-gray-900"
                : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
            }`}
          >
            {s.replace(/_/g, " ")}
          </button>
        ))}
      </div>

      {/* Grouped tables */}
      {STAGES.map(stage => {
        const rows = grouped[stage]
        if (rows.length === 0) return null
        return (
          <div key={stage} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className={`px-4 py-2.5 border-b border-gray-100 flex items-center gap-2 ${STAGE_COLORS[stage]} bg-opacity-40`}>
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${STAGE_COLORS[stage]}`}>
                {stage.replace(/_/g, " ")}
              </span>
              <span className="text-xs text-gray-500">{rows.length} task{rows.length !== 1 ? "s" : ""}</span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 w-1/3">Task</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Owner</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Due</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Priority</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Required</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Active</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map(t => (
                  <tr key={t.id} className={`border-b border-gray-50 hover:bg-gray-50 transition-colors ${!t.is_active ? "opacity-50" : ""}`}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">{t.title}</p>
                      {t.description && (
                        <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{t.description}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700 capitalize">{t.owner_role}</td>
                    <td className="px-4 py-3 text-gray-700">
                      {t.due_offset_days === 0 ? "Day of" : `+${t.due_offset_days}d`}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${PRIORITY_COLORS[t.priority] ?? ""}`}>
                        {t.priority}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium ${t.is_required ? "text-green-700" : "text-gray-400"}`}>
                        {t.is_required ? "Yes" : "No"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleToggleActive(t)}
                        disabled={isPending}
                        className={`relative inline-flex h-5 w-9 rounded-full transition-colors focus:outline-none ${
                          t.is_active ? "bg-gray-900" : "bg-gray-200"
                        }`}
                      >
                        <span className={`inline-block h-4 w-4 mt-0.5 rounded-full bg-white shadow transform transition-transform ${
                          t.is_active ? "translate-x-4" : "translate-x-0.5"
                        }`} />
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2 justify-end">
                        <button
                          onClick={() => openEdit(t)}
                          className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => setDeleteTarget(t)}
                          className="text-xs text-red-500 hover:text-red-700 font-medium"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}

      {filtered.length === 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-gray-500 text-sm">No task templates yet. Click "Add Template" to create one.</p>
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={showCreate || !!editTarget} onOpenChange={open => {
        if (!open) { setShowCreate(false); setEditTarget(null) }
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editTarget ? "Edit Task Template" : "New Task Template"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {!editTarget && (
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1.5">Stage</label>
                <Select value={form.stage} onValueChange={v => setForm(f => ({ ...f, stage: v }))}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STAGES.map(s => (
                      <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1.5">Title *</label>
              <Input
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Upload signed listing agreement"
                className="h-9"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1.5">Description</label>
              <Input
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Optional instructions for this task"
                className="h-9"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1.5">Owner Role</label>
                <Select value={form.owner_role} onValueChange={v => setForm(f => ({ ...f, owner_role: v }))}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {OWNER_ROLES.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1.5">Priority</label>
                <Select value={form.priority} onValueChange={v => setForm(f => ({ ...f, priority: v }))}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1.5">Due Offset (days)</label>
                <Input
                  type="number"
                  min={0}
                  value={form.due_offset_days}
                  onChange={e => setForm(f => ({ ...f, due_offset_days: parseInt(e.target.value) || 0 }))}
                  className="h-9"
                />
              </div>
              <div className="flex items-center gap-3 mt-5">
                <input
                  type="checkbox"
                  id="is_required"
                  checked={form.is_required}
                  onChange={e => setForm(f => ({ ...f, is_required: e.target.checked }))}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <label htmlFor="is_required" className="text-sm text-gray-700">Required task</label>
              </div>
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setShowCreate(false); setEditTarget(null) }}>
              Cancel
            </Button>
            <Button onClick={editTarget ? handleEdit : handleCreate} disabled={isPending}>
              {isPending ? "Saving..." : editTarget ? "Save Changes" : "Create Template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Task Template</AlertDialogTitle>
            <AlertDialogDescription>
              Delete &ldquo;{deleteTarget?.title}&rdquo;? This cannot be undone. Existing listing tasks already generated from this template are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={isPending} className="bg-red-600 hover:bg-red-700">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
