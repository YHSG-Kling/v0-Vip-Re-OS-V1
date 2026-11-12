'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { updateTitleOrderStatus } from '@/app/actions/partner-orders'

/**
 * The door onto `partner-orders.ts:updateTitleOrderStatus`, which had no caller —
 * a title order could be created but never advanced, so the search outcome the
 * whole panel set reads (`clear` vs `issue`, `completed_at`) could only ever be
 * whatever was picked at creation time.
 *
 * The status list mirrors `title_orders_status_check` exactly (verified live:
 * pending | ordered | in_progress | clear | issue | exception | completed | cancelled).
 * The server re-validates it; this is a convenience, not the gate.
 */
const TITLE_ORDER_STATUSES = [
  'pending',
  'ordered',
  'in_progress',
  'clear',
  'issue',
  'exception',
  'completed',
  'cancelled',
] as const

type TitleOrderStatus = (typeof TITLE_ORDER_STATUSES)[number]

const STATUS_TONE: Record<string, string> = {
  clear: 'bg-green-100 text-green-800 border-green-200',
  completed: 'bg-green-100 text-green-800 border-green-200',
  issue: 'bg-red-100 text-red-800 border-red-200',
  exception: 'bg-amber-100 text-amber-800 border-amber-200',
  cancelled: 'bg-gray-100 text-gray-600 border-gray-200',
}

export interface TitleOrderView {
  id: string
  property_address: string | null
  status: string
  closing_date: string | null
  completed_at: string | null
  created_at: string | null
  search_result: Record<string, unknown> | null
}

export function TitleOrderRow({ order }: { order: TitleOrderView }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<TitleOrderStatus>(
    (TITLE_ORDER_STATUSES as readonly string[]).includes(order.status)
      ? (order.status as TitleOrderStatus)
      : 'pending',
  )
  const [notes, setNotes] = useState(
    typeof order.search_result?.notes === 'string' ? (order.search_result.notes as string) : '',
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    setSaving(true)
    setError(null)
    // Only send search_result when the user actually edited findings — passing
    // `undefined` leaves the stored jsonb untouched (the action omits the column),
    // so re-stamping a status never blanks a search that is already on file.
    const existingNotes =
      typeof order.search_result?.notes === 'string' ? (order.search_result.notes as string) : ''
    const searchResult =
      notes.trim() === existingNotes.trim()
        ? undefined
        : { ...(order.search_result ?? {}), notes: notes.trim() || null }

    const res = await updateTitleOrderStatus(order.id, status, searchResult)
    setSaving(false)
    if (!res.success) {
      setError(res.error ?? 'The title order was not updated')
      return
    }
    setOpen(false)
    router.refresh()
  }

  const findings =
    typeof order.search_result?.notes === 'string' ? (order.search_result.notes as string) : null

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium truncate">{order.property_address || 'Address TBD'}</p>
            <p className="text-xs text-gray-500">
              {order.closing_date
                ? `Closing ${new Date(order.closing_date).toLocaleDateString()}`
                : 'No closing date'}
              {order.completed_at ? ` · Completed ${new Date(order.completed_at).toLocaleDateString()}` : ''}
            </p>
            {findings && <p className="text-xs text-gray-500 mt-1 line-clamp-2">{findings}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant="outline" className={`capitalize ${STATUS_TONE[order.status] ?? ''}`}>
              {order.status.replace(/_/g, ' ')}
            </Badge>
            <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
              {open ? 'Cancel' : 'Update'}
            </Button>
          </div>
        </div>

        {open && (
          <div className="border-t pt-3 space-y-3">
            <div>
              <Label htmlFor={`status-${order.id}`}>Search status</Label>
              <select
                id={`status-${order.id}`}
                value={status}
                onChange={(e) => setStatus(e.target.value as TitleOrderStatus)}
                className="w-full border rounded-md px-3 py-2 text-sm bg-white"
              >
                {TITLE_ORDER_STATUSES.map((s) => (
                  <option key={s} value={s} className="capitalize">
                    {s.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor={`notes-${order.id}`}>Search findings</Label>
              <Input
                id={`notes-${order.id}`}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Liens, exceptions, findings…"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
