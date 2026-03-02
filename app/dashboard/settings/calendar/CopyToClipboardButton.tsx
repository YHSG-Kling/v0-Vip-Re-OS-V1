"use client"

import { useState } from "react"

export function CopyToClipboardButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error("Copy failed:", err)
    }
  }

  return (
    <button
      onClick={handleCopy}
      className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-2 px-3 rounded"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  )
}
