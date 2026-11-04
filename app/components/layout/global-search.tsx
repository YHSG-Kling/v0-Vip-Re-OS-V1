'use client'

// Wave 149Z (lane 149E Outside-lane 1): this box used to be an inert <Input> — "Search contacts, listings, leads…" with no
// handler, a silently non-functional affordance (record search — contacts, listings, leads — lives on each desk's own
// search; composing searchOsCopy + record search into one box is a product decision, not built). It is now the visible
// trigger for the ONE app-wide search surface, the ⌘K command
// palette (app/components/command-palette.tsx — role-filtered, mounted once in app-shell.tsx). Clicking or focusing it opens
// the palette through the palette's own keyboard listener (document keydown), so there is still exactly one search door.
import { Search } from 'lucide-react'

function openCommandPalette() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true }))
}

export function GlobalSearch() {
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      aria-label="Search — opens the command palette (⌘K)"
      className="relative flex h-9 w-full items-center rounded-md border border-gray-200 bg-gray-100 pl-8 pr-10 text-left text-sm text-gray-600"
    >
      <Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-500" aria-hidden />
      {/* The palette searches pages and actions (not records) — the label says exactly that, never "contacts, listings, leads". */}
      <span className="truncate">Search pages and actions...</span>
      <span className="absolute right-2 top-2.5 text-xs text-gray-500" aria-hidden>⌘K</span>
    </button>
  )
}
