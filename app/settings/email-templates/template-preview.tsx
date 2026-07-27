"use client"

import { AlertTriangle, Eye, Mail } from "lucide-react"

/**
 * Template preview — walkthrough [35]: "Email templates: very basic forms to create
 * template and no place to view them."
 *
 * A list of names is not viewing a template. What a broker needs to see before this
 * goes to a client is the rendered email — subject and body with the merge tokens
 * resolved — and, more importantly, whether any token WON'T resolve.
 *
 * That last part is the real failure mode. Merge tokens are `{{token}}` throughout this
 * codebase (connector-probe, ai-newsletter, creative-playbooks all use the same shape).
 * A token in the body that isn't declared in the template's `variables` gets no value at
 * send time, so the client receives the literal text "Hi {{first_name}}". This panel
 * finds those before they ship rather than after.
 */

const TOKEN_RE = /\{\{(\w+)\}\}/g

export function extractTokens(text: string): string[] {
  const out = new Set<string>()
  for (const m of (text ?? "").matchAll(TOKEN_RE)) out.add(m[1])
  return [...out]
}

/** Resolve declared variables to sample values; anything undeclared stays flagged. */
function render(text: string, samples: Record<string, string>): string {
  return (text ?? "").replace(TOKEN_RE, (whole, key: string) =>
    key in samples ? samples[key] : whole,
  )
}

export function TemplatePreview({
  subject,
  body,
  variables,
}: {
  subject: string
  body: string
  variables: unknown
}) {
  // `variables` is jsonb — it may be an array of names, or an object of name→sample.
  // Accept both rather than assuming one and rendering nothing for the other.
  const samples: Record<string, string> = {}
  const declared = new Set<string>()
  if (Array.isArray(variables)) {
    for (const v of variables) {
      const name = String(v)
      declared.add(name)
      samples[name] = `[${name}]`
    }
  } else if (variables && typeof variables === "object") {
    for (const [k, v] of Object.entries(variables as Record<string, unknown>)) {
      declared.add(k)
      samples[k] = v == null || String(v).trim() === "" ? `[${k}]` : String(v)
    }
  }

  const used = [...new Set([...extractTokens(subject), ...extractTokens(body)])]
  const undeclared = used.filter(t => !declared.has(t))
  const unused = [...declared].filter(d => !used.includes(d))

  return (
    <div className="rounded-lg border bg-white">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Eye className="h-4 w-4 text-gray-500" />
        <span className="text-sm font-medium text-gray-900">Preview</span>
        <span className="ml-auto text-xs text-gray-500">
          {used.length} merge {used.length === 1 ? "field" : "fields"}
        </span>
      </div>

      {undeclared.length > 0 && (
        <div className="border-b bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {undeclared.length === 1 ? "This field isn't" : "These fields aren't"} defined on the
              template, so {undeclared.length === 1 ? "it" : "they"} will send as literal text:{" "}
              <span className="font-mono">{undeclared.map(t => `{{${t}}}`).join(" ")}</span>
            </span>
          </p>
        </div>
      )}

      {unused.length > 0 && (
        <div className="border-b bg-gray-50 px-4 py-2 text-xs text-gray-600">
          Defined but never used in this template:{" "}
          <span className="font-mono">{unused.join(", ")}</span>
        </div>
      )}

      <div className="space-y-3 px-4 py-3">
        <div className="flex items-start gap-2">
          <Mail className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
          <div className="min-w-0">
            <p className="text-xs text-gray-500">Subject</p>
            <p className="break-words font-medium text-gray-900">
              {render(subject, samples) || <span className="text-gray-400">(no subject)</span>}
            </p>
          </div>
        </div>
        <div className="rounded border bg-gray-50 p-3">
          {/* Rendered as TEXT, never dangerouslySetInnerHTML — this body is
              broker-authored content and a preview must not execute it. */}
          <pre className="whitespace-pre-wrap break-words font-sans text-sm text-gray-800">
            {render(body, samples) || "(empty body)"}
          </pre>
        </div>
      </div>
    </div>
  )
}
