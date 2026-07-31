"use client"

import { useEffect, useState, useTransition } from "react"
import { Loader2, Plus, X } from "lucide-react"
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/app/components/ui/sheet"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Textarea } from "@/app/components/ui/textarea"
import {
  EMBED_MODES, MODE_COPY, normalizeEnabledModes, type EmbedMode,
} from "@/lib/embed/widget-modes"
import { Label } from "@/app/components/ui/label"
import { toast } from "sonner"
import {
  updateEmbed, listTwinsForEmbed, type EmbedWidget,
} from "@/app/actions/embed-widgets"

interface Props {
  widget: EmbedWidget
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function EmbedEditor({ widget, open, onOpenChange }: Props) {
  const [label, setLabel] = useState(widget.label)
  const [welcomeMessage, setWelcomeMessage] = useState(widget.welcomeMessage ?? "")
  const [defaultTwinId, setDefaultTwinId] = useState<string | null>(widget.defaultTwinId)
  const [enabledModes, setEnabledModes] = useState<EmbedMode[]>(widget.enabledModes)
  const [leadCaptureMode, setLeadCaptureMode] = useState(widget.leadCaptureMode)
  const [routingMode, setRoutingMode] = useState(widget.routingMode)
  const [allowedDomains, setAllowedDomains] = useState<string[]>(widget.allowedDomains)
  const [domainInput, setDomainInput] = useState("")
  const [bubbleColor, setBubbleColor] = useState((widget.style?.bubble_color ?? "#0066ff") as string)
  const [buttonText, setButtonText] = useState((widget.style?.button_text ?? "Chat with me") as string)
  const [position, setPosition] = useState((widget.style?.position ?? "bottom-right") as string)
  const [twins, setTwins] = useState<{ id: string; label: string; agentName: string | null }[]>([])
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    listTwinsForEmbed(widget.agentId ? "personal" : "brokerage").then((res) => setTwins(res.twins))
  }, [widget.agentId])

  function addDomain() {
    const d = domainInput.trim()
    if (!d) return
    setAllowedDomains((prev) => Array.from(new Set([...prev, d])))
    setDomainInput("")
  }

  function removeDomain(d: string) {
    setAllowedDomains((prev) => prev.filter((x) => x !== d))
  }

  function toggleMode(mode: EmbedMode) {
    // text is not togglable off — see normalizeEnabledModes. Every visitor can
    // type; a widget with text disabled could refuse anyone whose browser blocks
    // the microphone.
    if (mode === "text") return
    setEnabledModes((prev) =>
      prev.includes(mode) ? prev.filter((m) => m !== mode) : [...prev, mode],
    )
  }

  function save() {
    startTransition(async () => {
      const res = await updateEmbed({
        id: widget.id,
        label,
        welcomeMessage: welcomeMessage || null,
        defaultTwinId,
        enabledModes: normalizeEnabledModes(enabledModes),
        leadCaptureMode,
        routingMode: widget.agentId === null ? routingMode : undefined,
        allowedDomains,
        style: {
          ...widget.style,
          bubble_color: bubbleColor,
          button_text: buttonText,
          position,
        },
      })
      if (res.ok) {
        toast.success("Embed updated")
        onOpenChange(false)
      } else {
        toast.error(res.error ?? "Couldn't save")
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Edit Embed</SheetTitle>
          <SheetDescription>Configure how this widget looks and behaves on your site.</SheetDescription>
        </SheetHeader>

        <div className="space-y-5 mt-6">
          <div>
            <Label htmlFor="label">Label</Label>
            <Input id="label" value={label} onChange={(e) => setLabel(e.target.value)} className="mt-1.5" maxLength={64} />
          </div>

          <div>
            <Label>Twin</Label>
            <select
              value={defaultTwinId ?? ""}
              onChange={(e) => setDefaultTwinId(e.target.value || null)}
              className="w-full h-9 rounded-md border bg-background px-3 text-sm mt-1.5"
            >
              {/* The empty option resolves server-side to the OWNER AGENT's default
                  twin — which only exists for a personal embed. On a
                  brokerage-wide embed there is no owner agent, so the same
                  option used to read as a promise the route could not keep; it
                  now reads as the unset state it actually is, and the route
                  refuses rather than borrowing someone's twin. */}
              <option value="">
                {widget.agentId ? "— Use owner agent's default —" : "— Select a twin (required) —"}
              </option>
              {twins.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}{t.agentName ? ` · ${t.agentName}` : ""}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              {widget.agentId
                ? "Only ready + approved twins are listed."
                : "Required — a brokerage-wide embed never borrows an agent's twin automatically. Only ready + approved twins are listed."}
            </p>
          </div>

          <div>
            <Label htmlFor="welcome">Welcome message</Label>
            <Textarea
              id="welcome" value={welcomeMessage} onChange={(e) => setWelcomeMessage(e.target.value)}
              rows={3} className="mt-1.5 text-sm" maxLength={500}
              placeholder="What the visitor sees when they open the bubble"
            />
          </div>

          <div>
            <Label>How visitors can reach your agent</Label>
            {/* THREE ways in, rendered from the ONE vocabulary (EMBED_MODES) that
                the column's CHECK and the public widget also read — so a mode
                cannot appear here that the widget would ignore. */}
            <div className="space-y-1.5 mt-1.5">
              {EMBED_MODES.map((m) => (
                <div key={m} className="flex items-start gap-2">
                  <ToggleChip
                    label={MODE_COPY[m].adminLabel}
                    active={enabledModes.includes(m)}
                    onClick={() => toggleMode(m)}
                  />
                  <p className="text-xs text-muted-foreground pt-1.5 flex-1">
                    {MODE_COPY[m].adminHint}
                  </p>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Talk and Live avatar both use your live AI minutes — turn them off on
              high-traffic pages to save. Type is always on.
            </p>
          </div>

          <div>
            <Label>Lead capture</Label>
            <div className="grid grid-cols-3 gap-2 mt-1.5">
              {([
                { value: "immediate", label: "Right away", desc: "Ask before chatting" },
                { value: "after_first_message", label: "After first message", desc: "Recommended" },
                { value: "optional", label: "Optional", desc: "Visitor can skip" },
              ] as const).map((opt) => (
                <button
                  key={opt.value} type="button"
                  onClick={() => setLeadCaptureMode(opt.value)}
                  className={`text-left rounded-md border p-2 text-xs hover:bg-muted/50 ${
                    leadCaptureMode === opt.value ? "border-primary bg-primary/5" : ""
                  }`}
                >
                  <div className="font-medium">{opt.label}</div>
                  <div className="text-muted-foreground">{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Routing — only visible for brokerage-wide embeds */}
          {widget.agentId === null && (
            <div>
              <Label>Lead routing</Label>
              <p className="text-xs text-muted-foreground mb-2">
                Controls which agent receives captured leads from this brokerage-wide embed.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { value: "primary", label: "Primary agent", desc: "Always routes to the first active agent" },
                  { value: "round_robin", label: "Round-robin", desc: "Distributes evenly across all active agents" },
                ] as const).map((opt) => (
                  <button
                    key={opt.value} type="button"
                    onClick={() => setRoutingMode(opt.value)}
                    className={`text-left rounded-md border p-2 text-xs hover:bg-muted/50 ${
                      routingMode === opt.value ? "border-primary bg-primary/5" : ""
                    }`}
                  >
                    <div className="font-medium">{opt.label}</div>
                    <div className="text-muted-foreground">{opt.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <Label>Allowed domains</Label>
            <p className="text-xs text-muted-foreground mb-2">
              Leave empty to allow any site. Add specific origins to restrict.
            </p>
            <div className="flex gap-2">
              <Input
                value={domainInput} onChange={(e) => setDomainInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addDomain() }}}
                placeholder="https://example.com"
                className="flex-1"
              />
              <Button type="button" onClick={addDomain} size="sm" variant="outline">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {allowedDomains.map((d) => (
                <span key={d} className="inline-flex items-center gap-1 bg-muted text-xs rounded-full px-2 py-1">
                  {d}
                  <button onClick={() => removeDomain(d)} className="hover:text-destructive">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>

          <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
            <p className="text-sm font-medium">Style</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="color" className="text-xs">Bubble color</Label>
                <div className="flex gap-2 mt-1">
                  <input
                    type="color" value={bubbleColor}
                    onChange={(e) => setBubbleColor(e.target.value)}
                    className="h-9 w-12 rounded border cursor-pointer"
                  />
                  <Input value={bubbleColor} onChange={(e) => setBubbleColor(e.target.value)}
                    className="font-mono text-xs" />
                </div>
              </div>
              <div>
                <Label htmlFor="position" className="text-xs">Position</Label>
                <select
                  value={position} onChange={(e) => setPosition(e.target.value)}
                  className="w-full h-9 rounded-md border bg-background px-3 text-xs mt-1"
                >
                  <option value="bottom-right">Bottom right</option>
                  <option value="bottom-left">Bottom left</option>
                </select>
              </div>
            </div>
            <div>
              <Label htmlFor="btn-text" className="text-xs">Button text</Label>
              <Input id="btn-text" value={buttonText} onChange={(e) => setButtonText(e.target.value)} className="mt-1" maxLength={32} />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6 pt-4 border-t">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button onClick={save} disabled={pending}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
            Save
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ToggleChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button" onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-xs border transition-colors ${
        active ? "border-primary bg-primary/10 text-primary font-medium" : "hover:bg-muted/50"
      }`}
    >
      {label}
    </button>
  )
}
