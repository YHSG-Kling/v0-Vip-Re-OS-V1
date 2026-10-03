"use client"

/**
 * app/components/vendors/vendor-category-select.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE CONTROL THAT AUTHORS A VENDOR CATEGORY.
 *
 * `vendors.category` is CHECK-constrained. The "Add New Vendor" dialog authored
 * it with a free-text <Input> whose placeholder read "e.g., Home Inspection,
 * Photography" — and NEITHER of those strings has ever been an admitted value.
 * Before m304 the column took six Title-Case values ('Lender', 'Title
 * Company', …); after m304 it takes the 38 lowercase_snake values shared with
 * vendor_directory. Under both vocabularies, typing what the placeholder
 * suggested produced a rejected INSERT and a raw Postgres constraint string in
 * the toast.
 *
 * A CHECK-constrained column may only be authored by a control that cannot
 * express a value outside the CHECK. That is this component: the options come
 * from VENDOR_CATEGORY_GROUPS, which the palette guard proves is exactly
 * VENDOR_CATEGORIES — so widening the taxonomy widens every picker, and no
 * picker can drift from the column again.
 *
 * Renders LABELS ("Title Company", "HVAC") and submits TOKENS ("title", "hvac").
 */

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select"
import {
  VENDOR_CATEGORY_GROUPS,
  VENDOR_CATEGORY_LABELS,
  type VendorCategory,
} from "@/lib/kernel/vendor-categories"

export interface VendorCategorySelectProps {
  /** The stored token, or "" for "not chosen yet". */
  value: string
  onChange: (value: VendorCategory) => void
  /** Rendered when nothing is chosen. Never becomes a submitted value. */
  placeholder?: string
  disabled?: boolean
  id?: string
}

export function VendorCategorySelect({
  value,
  onChange,
  placeholder = "Select a service type…",
  disabled,
  id,
}: VendorCategorySelectProps) {
  return (
    <Select
      value={value || undefined}
      onValueChange={(v) => onChange(v as VendorCategory)}
      disabled={disabled}
    >
      <SelectTrigger id={id}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {VENDOR_CATEGORY_GROUPS.map((group) => (
          <SelectGroup key={group.label}>
            <SelectLabel>{group.label}</SelectLabel>
            {group.categories.map((c) => (
              <SelectItem key={c} value={c}>
                {VENDOR_CATEGORY_LABELS[c]}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}
