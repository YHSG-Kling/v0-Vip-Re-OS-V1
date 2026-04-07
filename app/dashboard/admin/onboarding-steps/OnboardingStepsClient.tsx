"use client"

// app/dashboard/admin/onboarding-steps/OnboardingStepsClient.tsx
// Client component for managing brokerage-specific onboarding steps.
// Global steps (brokerage_id === null) are read-only — all controls disabled.
// No any types. No default export.

import React, { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import type { OnboardingStepRow } from "@/lib/kernel"
import {
  createBrokerageStep,
  updateBrokerageStep,
  deleteBrokerageStep,
} from "@/app/actions/onboarding/onboarding-steps-admin-actions"

type Props = {
  initialSteps: (OnboardingStepRow & { source: "GLOBAL" | "BROKERAGE" })[]
}

const CATEGORIES: OnboardingStepRow["category"][] = [
  "system_setup",
  "training",
  "practice",
  "compliance",
  "certification",
]

type CreateForm = {
  day_number: string
  step_order: string
  step_key: string
  step_name: string
  category: OnboardingStepRow["category"]
  required: boolean
  estimated_minutes: string
  video_url: string
  instructions: string
}

const BLANK_FORM: CreateForm = {
  day_number: "1",
  step_order: "1",
  step_key: "",
  step_name: "",
  category: "training",
  required: true,
  estimated_minutes: "",
  video_url: "",
  instructions: "",
}

export function OnboardingStepsClient({ initialSteps }: Props) {
  const router = useRouter()
  const [steps, setSteps] = useState(initialSteps)
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState<CreateForm>(BLANK_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<Partial<CreateForm>>({})
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleCreateChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) {
    const { name, value, type } = e.target
    setCreateForm(prev => ({
      ...prev,
      [name]: type === "checkbox" ? (e.target as HTMLInputElement).checked : value,
    }))
  }

  function handleEditChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) {
    const { name, value, type } = e.target
    setEditForm(prev => ({
      ...prev,
      [name]: type === "checkbox" ? (e.target as HTMLInputElement).checked : value,
    }))
  }

  function handleCreate() {
    setError(null)
    startTransition(async () => {
      try {
        const result = await createBrokerageStep({
          day_number: parseInt(createForm.day_number, 10),
          step_order: parseInt(createForm.step_order, 10),
          step_key: createForm.step_key.trim(),
          step_name: createForm.step_name.trim(),
          category: createForm.category,
          required: createForm.required,
          estimated_minutes: createForm.estimated_minutes ? parseInt(createForm.estimated_minutes, 10) : null,
          video_url: createForm.video_url.trim() || null,
          instructions: createForm.instructions.trim() || null,
        })
        // Optimistic: reload page to get fresh data from server
        const newStep: OnboardingStepRow & { source: "GLOBAL" | "BROKERAGE" } = {
          id: result.id,
          brokerage_id: "brokerage", // placeholder; page will revalidate
          day_number: parseInt(createForm.day_number, 10),
          step_order: parseInt(createForm.step_order, 10),
          step_key: createForm.step_key.trim(),
          step_name: createForm.step_name.trim(),
          category: createForm.category,
          required: createForm.required,
          estimated_minutes: createForm.estimated_minutes ? parseInt(createForm.estimated_minutes, 10) : null,
          video_url: createForm.video_url.trim() || null,
          instructions: createForm.instructions.trim() || null,
          success_criteria: null,
          source: "BROKERAGE",
        }
        setSteps(prev => [...prev, newStep])
        setCreateForm(BLANK_FORM)
        setShowCreate(false)
        router.refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create step")
      }
    })
  }

  function handleEditStart(step: OnboardingStepRow & { source: "GLOBAL" | "BROKERAGE" }) {
    setEditingId(step.id)
    setEditForm({
      day_number: String(step.day_number),
      step_order: String(step.step_order),
      step_key: step.step_key,
      step_name: step.step_name,
      category: step.category,
      required: step.required,
      estimated_minutes: step.estimated_minutes != null ? String(step.estimated_minutes) : "",
      video_url: step.video_url ?? "",
      instructions: step.instructions ?? "",
    })
  }

  function handleEditSave(stepId: string) {
    setError(null)
    startTransition(async () => {
      try {
        await updateBrokerageStep(stepId, {
          ...(editForm.day_number !== undefined && { day_number: parseInt(editForm.day_number, 10) }),
          ...(editForm.step_order !== undefined && { step_order: parseInt(editForm.step_order, 10) }),
          ...(editForm.step_key !== undefined && { step_key: editForm.step_key }),
          ...(editForm.step_name !== undefined && { step_name: editForm.step_name }),
          ...(editForm.category !== undefined && { category: editForm.category }),
          ...(editForm.required !== undefined && { required: editForm.required }),
          estimated_minutes: editForm.estimated_minutes ? parseInt(editForm.estimated_minutes, 10) : null,
          video_url: editForm.video_url?.trim() || null,
          instructions: editForm.instructions?.trim() || null,
        })
        setSteps(prev =>
          prev.map(s =>
            s.id === stepId
              ? {
                  ...s,
                  day_number: parseInt(editForm.day_number ?? String(s.day_number), 10),
                  step_order: parseInt(editForm.step_order ?? String(s.step_order), 10),
                  step_key: editForm.step_key ?? s.step_key,
                  step_name: editForm.step_name ?? s.step_name,
                  category: (editForm.category ?? s.category) as OnboardingStepRow["category"],
                  required: editForm.required ?? s.required,
                  estimated_minutes: editForm.estimated_minutes ? parseInt(editForm.estimated_minutes, 10) : null,
                  video_url: editForm.video_url?.trim() || null,
                  instructions: editForm.instructions?.trim() || null,
                }
              : s
          )
        )
        setEditingId(null)
        setEditForm({})
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update step")
      }
    })
  }

  function handleDelete(stepId: string) {
    setError(null)
    startTransition(async () => {
      try {
        await deleteBrokerageStep(stepId)
        setSteps(prev => prev.filter(s => s.id !== stepId))
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete step")
      }
    })
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Onboarding Steps</h2>
        <button
          onClick={() => setShowCreate(v => !v)}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          disabled={isPending}
        >
          {showCreate ? "Cancel" : "Add Brokerage Step"}
        </button>
      </div>

      {showCreate && (
        <div className="rounded border border-gray-200 bg-gray-50 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">New Brokerage Step</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Day Number</label>
              <input name="day_number" type="number" min={1} max={30} value={createForm.day_number}
                onChange={handleCreateChange} className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Step Order</label>
              <input name="step_order" type="number" min={1} value={createForm.step_order}
                onChange={handleCreateChange} className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Step Key</label>
              <input name="step_key" type="text" value={createForm.step_key}
                onChange={handleCreateChange} className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" placeholder="e.g. complete_profile" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Step Name</label>
              <input name="step_name" type="text" value={createForm.step_name}
                onChange={handleCreateChange} className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" placeholder="e.g. Complete Your Profile" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
              <select name="category" value={createForm.category} onChange={handleCreateChange}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm">
                {CATEGORIES.map(c => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Est. Minutes</label>
              <input name="estimated_minutes" type="number" min={0} value={createForm.estimated_minutes}
                onChange={handleCreateChange} className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-600 mb-1">Video URL</label>
              <input name="video_url" type="url" value={createForm.video_url}
                onChange={handleCreateChange} className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-600 mb-1">Instructions</label>
              <textarea name="instructions" rows={3} value={createForm.instructions}
                onChange={handleCreateChange} className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
            </div>
            <div className="col-span-2 flex items-center gap-2">
              <input name="required" type="checkbox" id="create-required" checked={createForm.required}
                onChange={handleCreateChange} className="h-4 w-4" />
              <label htmlFor="create-required" className="text-sm text-gray-700">Required step</label>
            </div>
          </div>
          <button
            onClick={handleCreate}
            disabled={isPending || !createForm.step_key.trim() || !createForm.step_name.trim()}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isPending ? "Creating..." : "Create Step"}
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Source</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Day</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Order</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Name</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Category</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Required</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {steps.map(step => {
              const isGlobal = step.source === "GLOBAL"
              const isEditing = editingId === step.id
              return (
                <tr key={step.id} className={isGlobal ? "bg-gray-50" : ""}>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      isGlobal ? "bg-gray-200 text-gray-700" : "bg-blue-100 text-blue-700"
                    }`}>
                      {step.source}
                    </span>
                  </td>
                  {isEditing ? (
                    <>
                      <td className="px-4 py-3">
                        <input name="day_number" type="number" min={1} value={editForm.day_number ?? ""}
                          onChange={handleEditChange} className="w-16 rounded border border-gray-300 px-2 py-1 text-sm" />
                      </td>
                      <td className="px-4 py-3">
                        <input name="step_order" type="number" min={1} value={editForm.step_order ?? ""}
                          onChange={handleEditChange} className="w-16 rounded border border-gray-300 px-2 py-1 text-sm" />
                      </td>
                      <td className="px-4 py-3">
                        <input name="step_name" type="text" value={editForm.step_name ?? ""}
                          onChange={handleEditChange} className="w-48 rounded border border-gray-300 px-2 py-1 text-sm" />
                      </td>
                      <td className="px-4 py-3">
                        <select name="category" value={editForm.category ?? step.category}
                          onChange={handleEditChange} className="rounded border border-gray-300 px-2 py-1 text-sm">
                          {CATEGORIES.map(c => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <input name="required" type="checkbox" checked={editForm.required ?? step.required}
                          onChange={handleEditChange} className="h-4 w-4" />
                      </td>
                      <td className="px-4 py-3 flex gap-2">
                        <button onClick={() => handleEditSave(step.id)} disabled={isPending}
                          className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50">
                          Save
                        </button>
                        <button onClick={() => { setEditingId(null); setEditForm({}) }}
                          className="rounded bg-gray-200 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-300">
                          Cancel
                        </button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-4 py-3 text-gray-700">{step.day_number}</td>
                      <td className="px-4 py-3 text-gray-700">{step.step_order}</td>
                      <td className="px-4 py-3 font-medium text-gray-900">{step.step_name}</td>
                      <td className="px-4 py-3 text-gray-600">{step.category.replace("_", " ")}</td>
                      <td className="px-4 py-3">
                        {step.required ? (
                          <span className="text-green-700 font-medium">Yes</span>
                        ) : (
                          <span className="text-gray-400">No</span>
                        )}
                      </td>
                      <td className="px-4 py-3 flex gap-2">
                        <button
                          onClick={() => handleEditStart(step)}
                          disabled={isGlobal || isPending}
                          title={isGlobal ? "Global steps cannot be edited" : "Edit step"}
                          className="rounded bg-blue-100 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-200 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(step.id)}
                          disabled={isGlobal || isPending}
                          title={isGlobal ? "Global steps cannot be deleted" : "Delete step"}
                          className="rounded bg-red-100 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-200 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Delete
                        </button>
                      </td>
                    </>
                  )}
                </tr>
              )
            })}
            {steps.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400 text-sm">
                  No onboarding steps found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
