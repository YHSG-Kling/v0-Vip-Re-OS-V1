"use client"

import { useState, useRef, useCallback } from "react"
import { Input } from "@/components/ui/input"
import { useClickOutside } from "@/hooks/use-click-outside"
import { suggestAddresses } from "@/app/actions/address-suggestions"
import type { AddressSuggestion } from "@/lib/external/nominatim-geocode"

interface AddressComponents {
  street: string
  city: string
  state: string
  zip: string
  full: string
}

interface AddressAutocompleteProps {
  value: string
  onChange: (value: string) => void
  onSelect?: (address: AddressComponents) => void
  placeholder?: string
  id?: string
  className?: string
  disabled?: boolean
}

// Wave 140 (lane 140P): the Nominatim fetch, the NominatimResult shape, the state table and
// the parser that lived here moved to the SERVER — app/actions/address-suggestions.ts over
// lib/external/nominatim-geocode.ts (suggestAddressesDetailed / parseNominatimAddressRow). A
// browser call reached the vendor outside the connector gateway (no tenant, no health, no
// usage row); this component now receives parsed suggestions only.
const MIN_QUERY = 4

export function AddressAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder = "Enter address...",
  id,
  className,
  disabled,
}: AddressAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const requestIdRef = useRef(0)

  const fetchSuggestions = useCallback(async (query: string) => {
    if (query.length < MIN_QUERY) { setSuggestions([]); setOpen(false); return }
    // Stamp this request so we can discard out-of-order responses
    const currentId = ++requestIdRef.current
    try {
      const res = await suggestAddresses(query)
      // Ignore if a newer request has already been issued
      if (currentId !== requestIdRef.current) return
      const data = res.ok ? res.suggestions : []
      setSuggestions(data)
      setOpen(data.length > 0)
    } catch {
      // silently degrade — user can still type manually
    }
  }, [])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    onChange(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchSuggestions(v), 350)
  }

  const handleSelect = (s: AddressSuggestion) => {
    onChange(s.street || s.label)
    if (onSelect) onSelect({ street: s.street, city: s.city, state: s.state, zip: s.zip, full: s.label })
    setSuggestions([])
    setOpen(false)
  }

  // Duplicate inline mousedown listener retired 2026-09-11 — survivor is
  // hooks/use-click-outside.ts:19 (also covers touchstart, which this
  // duplicate never did).
  useClickOutside(containerRef, () => setOpen(false))

  return (
    <div ref={containerRef} className="relative">
      <Input
        id={id}
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        className={className}
        disabled={disabled}
        autoComplete="off"
        onFocus={() => suggestions.length > 0 && setOpen(true)}
      />
      {open && suggestions.length > 0 && (
        <ul className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md text-sm max-h-60 overflow-auto">
          {suggestions.map((s) => (
            <li
              key={s.placeId}
              className="px-3 py-2 cursor-pointer hover:bg-accent hover:text-accent-foreground truncate"
              onMouseDown={(e) => { e.preventDefault(); handleSelect(s) }}
            >
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
