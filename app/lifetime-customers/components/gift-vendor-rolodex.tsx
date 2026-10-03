"use client"

// GIFT VENDOR ROLODEX (owner: "wire a small rolodex" — lane F2 2026-08-28).
// The door for app/actions/ai-client-gifting.ts:getVendors / createVendor over
// gift_vendors — the agent's own gift-supplier list (florists, engravers,
// gift-basket shops), a different process from the brokerage vendor
// marketplace. Scope is the SESSION agent inside the actions; this card sends
// only the vendor's details. Errors are shown, never swallowed — an empty list
// and a refused read are different statements.

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Loader2, Plus, Store } from "lucide-react"
import { getVendors, createVendor } from "@/app/actions/ai-client-gifting"

interface GiftVendor {
  id: string
  name: string
  category: string | null
  contact_name: string | null
  email: string | null
  phone: string | null
  website: string | null
  notes: string | null
  is_active: boolean | null
  created_at: string | null
}

const SUGGESTED_CATEGORIES = [
  "Gift baskets",
  "Flowers",
  "Wine & spirits",
  "Engraving & personalization",
  "Home goods",
  "Local experiences",
]

export function GiftVendorRolodex() {
  const [vendors, setVendors] = useState<GiftVendor[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: "", category: "", contactName: "", email: "", phone: "", website: "", notes: "" })
  const [formError, setFormError] = useState<string | null>(null)
  const [isSaving, startSaving] = useTransition()

  async function load() {
    setLoadError(null)
    const res = await getVendors()
    if (!res.success) {
      setLoadError(res.error ?? "Could not load your gift vendors.")
      setVendors([])
    } else {
      setVendors((res.vendors ?? []) as GiftVendor[])
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function setField(field: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [field]: value }))
    setFormError(null)
  }

  function handleAdd() {
    startSaving(async () => {
      const res = await createVendor({
        name: form.name,
        category: form.category,
        contactName: form.contactName || undefined,
        email: form.email || undefined,
        phone: form.phone || undefined,
        website: form.website || undefined,
        notes: form.notes || undefined,
      })
      if (!res.success) {
        setFormError(res.error ?? "The vendor was not saved.")
        return
      }
      setForm({ name: "", category: "", contactName: "", email: "", phone: "", website: "", notes: "" })
      setShowForm(false)
      await load()
    })
  }

  // Group by category for the rolodex read.
  const byCategory = new Map<string, GiftVendor[]>()
  for (const v of vendors) {
    const cat = v.category?.trim() || "Uncategorized"
    if (!byCategory.has(cat)) byCategory.set(cat, [])
    byCategory.get(cat)!.push(v)
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Store className="h-4 w-4" />
            Gift Vendor Rolodex
          </CardTitle>
          <Button size="sm" variant="outline" onClick={() => setShowForm((v) => !v)}>
            <Plus className="h-3 w-3 mr-1" />
            {showForm ? "Cancel" : "Add vendor"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Your own gift suppliers — the shops you actually order closing and anniversary gifts from.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {showForm && (
          <div className="rounded-lg border border-border p-3 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="gv-name">Name</Label>
                <Input id="gv-name" value={form.name} onChange={(e) => setField("name", e.target.value)} placeholder="e.g. Bloom & Vine Florals" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="gv-category">Category</Label>
                <Input id="gv-category" value={form.category} onChange={(e) => setField("category", e.target.value)} placeholder="e.g. Flowers" list="gv-categories" />
                <datalist id="gv-categories">
                  {SUGGESTED_CATEGORIES.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label htmlFor="gv-contact">Contact person</Label>
                <Input id="gv-contact" value={form.contactName} onChange={(e) => setField("contactName", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="gv-email">Email</Label>
                <Input id="gv-email" type="email" value={form.email} onChange={(e) => setField("email", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="gv-phone">Phone</Label>
                <Input id="gv-phone" type="tel" value={form.phone} onChange={(e) => setField("phone", e.target.value)} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="gv-website">Website</Label>
              <Input id="gv-website" value={form.website} onChange={(e) => setField("website", e.target.value)} placeholder="https://…" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="gv-notes">Notes</Label>
              <Textarea id="gv-notes" rows={2} value={form.notes} onChange={(e) => setField("notes", e.target.value)} placeholder="Minimum order, lead time, discount code…" />
            </div>
            {formError && <p className="text-xs text-destructive">{formError}</p>}
            <Button size="sm" onClick={handleAdd} disabled={isSaving || !form.name.trim() || !form.category.trim()}>
              {isSaving ? (
                <>
                  <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save vendor"
              )}
            </Button>
          </div>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading vendors…
          </p>
        ) : loadError ? (
          <p className="text-sm text-destructive">{loadError}</p>
        ) : vendors.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No gift vendors yet. Add the shops you order from so gift planning starts from your own
            suppliers.
          </p>
        ) : (
          <div className="space-y-4">
            {Array.from(byCategory.entries()).map(([cat, rows]) => (
              <div key={cat}>
                <div className="flex items-center gap-2 mb-2">
                  <h4 className="text-sm font-medium">{cat}</h4>
                  <Badge variant="outline" className="text-xs">
                    {rows.length}
                  </Badge>
                </div>
                <div className="space-y-2">
                  {rows.map((v) => (
                    <div key={v.id} className="rounded-md border border-border p-2.5 text-sm">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{v.name}</span>
                        {v.is_active === false && (
                          <Badge variant="secondary" className="text-xs">
                            inactive
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                        {v.contact_name && <span>{v.contact_name}</span>}
                        {v.phone && <span>{v.phone}</span>}
                        {v.email && <span>{v.email}</span>}
                        {v.website && (
                          <a href={v.website} target="_blank" rel="noreferrer" className="underline">
                            {v.website.replace(/^https?:\/\//, "")}
                          </a>
                        )}
                      </div>
                      {v.notes && <p className="text-xs text-muted-foreground mt-1">{v.notes}</p>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
