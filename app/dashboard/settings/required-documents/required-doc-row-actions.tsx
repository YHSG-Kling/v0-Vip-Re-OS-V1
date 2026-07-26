"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Loader2, Trash2, Paperclip, X } from "lucide-react"
import {
  setRequiredDocBlocking,
  removeRequiredDoc,
  setRequiredDocTemplate,
} from "@/app/actions/compliance/manage-required-docs"

export interface TemplateFormOption {
  id: string
  name: string
  state: string
  packetType: string
}

/** Per-row edit controls for an active required-document rule: flip
 *  blocking↔warning, remove, and attach/detach a blank template form from the
 *  brokerage_form_library (the ONE forms upload pipeline — Transaction Forms).
 *  Server actions enforce role/scope + brokerage. */
export function RequiredDocRowActions({
  id,
  blockOnMissing,
  templateFormId,
  formOptions,
}: {
  id: string
  blockOnMissing: boolean
  templateFormId: string | null
  formOptions: TemplateFormOption[]
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [picking, setPicking] = useState(false)
  const [pickId, setPickId] = useState<string>(templateFormId ?? "")

  function toggle() {
    start(async () => {
      await setRequiredDocBlocking({ id, blockOnMissing: !blockOnMissing })
      router.refresh()
    })
  }
  function remove() {
    start(async () => {
      await removeRequiredDoc({ id })
      router.refresh()
    })
  }
  function saveTemplate(formId: string | null) {
    start(async () => {
      await setRequiredDocTemplate({ id, formId })
      setPicking(false)
      router.refresh()
    })
  }

  const attached = formOptions.find(f => f.id === templateFormId) ?? null

  return (
    <div className="flex items-center gap-2 shrink-0">
      {picking ? (
        <span className="flex items-center gap-1">
          <select
            className="border rounded px-2 py-1 text-xs max-w-[180px]"
            value={pickId}
            onChange={e => setPickId(e.target.value)}
            disabled={pending}
          >
            <option value="">No template</option>
            {formOptions.map(f => (
              <option key={f.id} value={f.id}>{f.name} ({f.state})</option>
            ))}
          </select>
          <Button size="sm" variant="outline" className="text-xs" disabled={pending}
            onClick={() => saveTemplate(pickId || null)}>
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
          </Button>
          <Button size="sm" variant="ghost" className="text-xs" onClick={() => setPicking(false)} disabled={pending}>
            <X className="h-3 w-3" />
          </Button>
        </span>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => { setPickId(templateFormId ?? ""); setPicking(true) }}
          disabled={pending}
          className="text-xs gap-1"
          title={attached ? `Template: ${attached.name}` : "Attach the blank form agents should use"}
        >
          <Paperclip className="h-3 w-3" />
          {attached ? "Template ✓" : "Template"}
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={toggle} disabled={pending} className="text-xs">
        {pending && !picking ? <Loader2 className="h-3 w-3 animate-spin" /> : blockOnMissing ? "Make warning" : "Make blocking"}
      </Button>
      <Button variant="ghost" size="sm" onClick={remove} disabled={pending} aria-label="Remove rule" className="text-red-600 hover:text-red-700">
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
