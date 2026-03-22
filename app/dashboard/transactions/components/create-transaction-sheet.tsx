"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { createTransaction } from "@/app/actions/transactions"
import { Loader2 } from "lucide-react"

interface CreateTransactionSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateTransactionSheet({ open, onOpenChange }: CreateTransactionSheetProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [form, setForm] = useState({
    property_address: "",
    property_city: "",
    property_state: "",
    property_zip: "",
    transaction_type: "purchase" as "purchase" | "sale" | "lease" | "dual",
    contract_price: "",
    client_name: "",
    client_email: "",
    close_date: "",
  })

  function handleChange(key: keyof typeof form, value: string) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!form.property_address.trim()) {
      setError("Property address is required.")
      return
    }
    startTransition(async () => {
      const result = await createTransaction({
        property_address: form.property_address,
        property_city:    form.property_city || undefined,
        property_state:   form.property_state || undefined,
        property_zip:     form.property_zip || undefined,
        transaction_type: form.transaction_type,
        contract_price:   form.contract_price ? Number(form.contract_price) : undefined,
        client_name:      form.client_name || undefined,
        client_email:     form.client_email || undefined,
        close_date:       form.close_date || undefined,
        status:           "active",
      })
      if (result && "id" in result && result.id) {
        onOpenChange(false)
        router.push(`/dashboard/transactions/${result.id}`)
        router.refresh()
      } else if (result && "error" in result) {
        setError(result.error as string)
      } else {
        setError("Failed to create transaction. Please try again.")
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader className="mb-6">
          <SheetTitle>New Transaction</SheetTitle>
          <SheetDescription>
            Enter the property and client details to open a new transaction file.
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Property */}
          <div className="space-y-1">
            <Label htmlFor="property_address">Property Address <span className="text-destructive">*</span></Label>
            <Input
              id="property_address"
              placeholder="123 Main St"
              value={form.property_address}
              onChange={e => handleChange("property_address", e.target.value)}
              disabled={isPending}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="property_city">City</Label>
              <Input
                id="property_city"
                placeholder="Miami"
                value={form.property_city}
                onChange={e => handleChange("property_city", e.target.value)}
                disabled={isPending}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="property_state">State</Label>
              <Input
                id="property_state"
                placeholder="FL"
                maxLength={2}
                value={form.property_state}
                onChange={e => handleChange("property_state", e.target.value.toUpperCase())}
                disabled={isPending}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="property_zip">Zip Code</Label>
              <Input
                id="property_zip"
                placeholder="33101"
                value={form.property_zip}
                onChange={e => handleChange("property_zip", e.target.value)}
                disabled={isPending}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="transaction_type">Type</Label>
              <Select
                value={form.transaction_type}
                onValueChange={v => handleChange("transaction_type", v)}
                disabled={isPending}
              >
                <SelectTrigger id="transaction_type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="purchase">Purchase</SelectItem>
                  <SelectItem value="sale">Sale</SelectItem>
                  <SelectItem value="lease">Lease</SelectItem>
                  <SelectItem value="dual">Dual</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Financials */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="contract_price">Contract Price</Label>
              <Input
                id="contract_price"
                type="number"
                placeholder="500000"
                value={form.contract_price}
                onChange={e => handleChange("contract_price", e.target.value)}
                disabled={isPending}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="close_date">Close Date</Label>
              <Input
                id="close_date"
                type="date"
                value={form.close_date}
                onChange={e => handleChange("close_date", e.target.value)}
                disabled={isPending}
              />
            </div>
          </div>

          {/* Client */}
          <div className="space-y-1">
            <Label htmlFor="client_name">Client Name</Label>
            <Input
              id="client_name"
              placeholder="Jane Smith"
              value={form.client_name}
              onChange={e => handleChange("client_name", e.target.value)}
              disabled={isPending}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="client_email">Client Email</Label>
            <Input
              id="client_email"
              type="email"
              placeholder="jane@example.com"
              value={form.client_email}
              onChange={e => handleChange("client_email", e.target.value)}
              disabled={isPending}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex gap-3 pt-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" className="flex-1" disabled={isPending}>
              {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Create Transaction
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
