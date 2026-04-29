"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Input } from "@/components/ui/input"

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

interface NominatimResult {
  place_id: number
  display_name: string
  address: {
    house_number?: string
    road?: string
    neighbourhood?: string
    suburb?: string
    city?: string
    town?: string
    village?: string
    state?: string
    postcode?: string
  }
}

const STATE_ABBR: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA",
  Colorado: "CO", Connecticut: "CT", Delaware: "DE", Florida: "FL", Georgia: "GA",
  Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA",
  Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD",
  Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS",
  Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH",
  "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC",
  "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA",
  "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN",
  Texas: "TX", Utah: "UT", Vermont: "VT", Virginia: "VA", Washington: "WA",
  "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
  "District of Columbia": "DC",
}

function parseNominatim(result: NominatimResult): AddressComponents {
  const a = result.address
  const street = [a.house_number, a.road].filter(Boolean).join(" ")
  const city = a.city ?? a.town ?? a.village ?? a.suburb ?? a.neighbourhood ?? ""
  const stateFull = a.state ?? ""
  const state = STATE_ABBR[stateFull] ?? stateFull
  const zip = a.postcode ?? ""
  return { street, city, state, zip, full: result.display_name }
}

export function AddressAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder = "Enter address...",
  id,
  className,
  disabled,
}: AddressAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<NominatimResult[]>([])
  const [open, setOpen] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const requestIdRef = useRef(0)

  const fetchSuggestions = useCallback(async (query: string) => {
    if (query.length < 4) { setSuggestions([]); setOpen(false); return }
    // Stamp this request so we can discard out-of-order responses
    const currentId = ++requestIdRef.current
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&countrycodes=us&limit=5&q=${encodeURIComponent(query)}`
      const res = await fetch(url, { headers: { "Accept-Language": "en" } })
      if (!res.ok) return
      const data: NominatimResult[] = await res.json()
      // Ignore if a newer request has already been issued
      if (currentId !== requestIdRef.current) return
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

  const handleSelect = (result: NominatimResult) => {
    const parsed = parseNominatim(result)
    onChange(parsed.street || parsed.full)
    if (onSelect) onSelect(parsed)
    setSuggestions([])
    setOpen(false)
  }

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

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
              key={s.place_id}
              className="px-3 py-2 cursor-pointer hover:bg-accent hover:text-accent-foreground truncate"
              onMouseDown={(e) => { e.preventDefault(); handleSelect(s) }}
            >
              {s.display_name}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
