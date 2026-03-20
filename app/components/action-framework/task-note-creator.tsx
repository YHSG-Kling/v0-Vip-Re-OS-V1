"use client"

import { useState } from "react"
import { Loader2, Plus, StickyNote, CheckSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ContextualAiAssistBar } from "@/app/components/ai-copilot/contextual-ai-assist-bar"
import { createClient } from "@/lib/supabase/client"

interface TaskNoteCreatorProps {
  agentId: string
  contactId?: string
  transactionId?: string
  defaultType?: "task" | "note"
  onCreated?: () => void
}

export function TaskNoteCreator({
  agentId,
  contactId,
  transactionId,
  defaultType = "task",
  onCreated,
}: TaskNoteCreatorProps) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<"task" | "note">(defaultType)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [priority, setPriority] = useState<"high" | "medium" | "low">("medium")
  const [dueDate, setDueDate] = useState("")
  const [saving, setSaving] = useState(false)

  const resetForm = () => {
    setTitle("")
    setDescription("")
    setPriority("medium")
    setDueDate("")
    setType(defaultType)
  }

  const handleSave = async () => {
    if (!title.trim()) return

    setSaving(true)
    try {
      const supabase = createClient()

      const { data: userData } = await supabase.auth.getUser()
      if (!userData.user) throw new Error("Not authenticated")

      const { data: agent } = await supabase
        .from("agents")
        .select("brokerage_id")
        .eq("id", agentId)
        .single()

      if (!agent) throw new Error("Agent not found")

      const activityData = {
        agent_id: agentId,
        brokerage_id: agent.brokerage_id,
        contact_id: contactId || null,
        transaction_id: transactionId || null,
        activity_type: type,
        title: title.trim(),
        description: description.trim() || null,
        priority: type === "task" ? priority : null,
        scheduled_at: type === "task" && dueDate ? new Date(dueDate).toISOString() : null,
        status: "pending",
      }

      const { error } = await supabase.from("activities").insert(activityData)

      if (error) throw error

      resetForm()
      setOpen(false)
      onCreated?.()
    } catch (error) {
      console.error("[TaskNoteCreator] Save failed:", error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="h-4 w-4 mr-2" />
          Add {defaultType === "task" ? "Task" : "Note"}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>
            Create {type === "task" ? "Task" : "Note"}
          </SheetTitle>
        </SheetHeader>

        <div className="space-y-4 py-4">
          {/* Type Toggle */}
          <div className="space-y-2">
            <Label>Type</Label>
            <ToggleGroup
              type="single"
              value={type}
              onValueChange={(v) => v && setType(v as "task" | "note")}
              className="justify-start"
            >
              <ToggleGroupItem value="task" aria-label="Task">
                <CheckSquare className="h-4 w-4 mr-2" />
                Task
              </ToggleGroupItem>
              <ToggleGroupItem value="note" aria-label="Note">
                <StickyNote className="h-4 w-4 mr-2" />
                Note
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          {/* Title */}
          <div className="space-y-2">
            <Label htmlFor="title">Title *</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={type === "task" ? "Follow up with buyer" : "Client meeting notes"}
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add details..."
              rows={4}
            />
            <ContextualAiAssistBar
              agentId={agentId}
              context={{
                type: "message",
                contactName: "client",
                currentContent: description,
              }}
              onAcceptDraft={(draft) => setDescription(draft)}
            />
          </div>

          {/* Task-specific fields */}
          {type === "task" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="priority">Priority</Label>
                <Select value={priority} onValueChange={(v) => setPriority(v as "high" | "medium" | "low")}>
                  <SelectTrigger id="priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="dueDate">Due Date</Label>
                <Input
                  id="dueDate"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>
            </>
          )}
        </div>

        <div className="flex gap-2 pt-4">
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={saving}
            className="flex-1"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !title.trim()}
            className="flex-1"
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              `Save ${type === "task" ? "Task" : "Note"}`
            )}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
