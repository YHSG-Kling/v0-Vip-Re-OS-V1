"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { createTeam } from "@/app/actions/multi-persona"
import { Plus, Loader2 } from "lucide-react"
import { useToast } from "@/hooks/use-toast"

interface AgentOption {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
}

interface CreateTeamDialogProps {
  brokerageId: string
  agents: AgentOption[]
  userRole: string
}

export function CreateTeamDialog({ brokerageId, agents, userRole }: CreateTeamDialogProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [teamName, setTeamName] = useState("")
  const [teamLeaderId, setTeamLeaderId] = useState("")

  const canCreate = ["broker", "admin"].includes(userRole)
  if (!canCreate) return null

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!teamName.trim() || !teamLeaderId) return

    setLoading(true)
    try {
      await createTeam({
        teamName: teamName.trim(),
        teamLeaderId,
        brokerageId,
      })
      toast({ title: "Team created", description: `${teamName} is ready. Add members from the team detail page.` })
      setOpen(false)
      setTeamName("")
      setTeamLeaderId("")
      router.refresh()
    } catch (err: any) {
      toast({ title: "Failed to create team", description: err?.message ?? "Please try again.", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1">
          <Plus className="h-4 w-4" />
          Create Team
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create a New Team</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label htmlFor="teamName">Team Name</Label>
            <Input
              id="teamName"
              placeholder="e.g. The Johnson Group"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="teamLeader">Team Leader</Label>
            <Select value={teamLeaderId} onValueChange={setTeamLeaderId} required>
              <SelectTrigger id="teamLeader">
                <SelectValue placeholder="Select an agent" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.first_name} {agent.last_name}
                    {agent.email ? ` — ${agent.email}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !teamName.trim() || !teamLeaderId}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Create Team
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
