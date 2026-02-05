'use client'

import React from 'react'
import { Input } from '@/components/ui/input'
import { Search } from 'lucide-react'

export function GlobalSearch() {
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    // Trigger Cmd+K programmatically
    const event = new KeyboardEvent('keydown', {
      key: 'k',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    document.dispatchEvent(event)
  }

  return (
    <div className="relative cursor-pointer" onClick={handleClick}>
      <Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" />
      <Input
        placeholder="Search contacts, listings, leads..."
        className="pl-8 border-gray-200 bg-gray-100 text-gray-900 cursor-pointer"
        readOnly
      />
      <span className="absolute right-2 top-2.5 text-xs text-gray-400">⌘K</span>
    </div>
  )
}
