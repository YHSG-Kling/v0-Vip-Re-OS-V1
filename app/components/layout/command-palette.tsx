'use client'

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { NavItem } from '@/app/types/navigation'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CommandPaletteProps {
  items: NavItem[]
}

export function CommandPalette({ items }: CommandPaletteProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const router = useRouter()

  // Handle Cmd/Ctrl + K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  const filteredItems = items.filter((item) =>
    item.label.toLowerCase().includes(search.toLowerCase())
  )

  const handleSelect = (item: NavItem) => {
    if (item.href) {
      router.push(item.href)
      setOpen(false)
      setSearch('')
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="p-0 gap-0 max-w-2xl">
        <div className="flex items-center border-b border-gray-200 px-4">
          <Search className="w-5 h-5 text-gray-400 mr-2" />
          <Input
            placeholder="Search actions, contacts, listings..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border-0 focus-visible:ring-0 focus-visible:ring-offset-0 h-12"
            autoFocus
          />
        </div>

        <div className="max-h-[400px] overflow-y-auto p-2">
          {filteredItems.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-500">
              No results found
            </div>
          ) : (
            <div className="space-y-1">
              {filteredItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => handleSelect(item)}
                  className={cn(
                    'w-full text-left px-4 py-3 rounded-md hover:bg-gray-100 transition-colors',
                    'flex items-center justify-between text-sm'
                  )}
                >
                  <span className="font-medium text-gray-900">{item.label}</span>
                  {item.href && (
                    <span className="text-xs text-gray-500">{item.href}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 px-4 py-2 text-xs text-gray-500 flex items-center justify-between">
          <span>Press ⌘K to toggle</span>
          <span>ESC to close</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
