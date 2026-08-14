"use client"

import { useMemo, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog"
import { Building2, MapPin, Plus, Trash2, Users, Pencil } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import {
  createLocationAction, deleteLocationAction, assignUserToLocationAction,
  updateLocationAction,
  type OfficeLocation, type BrokerageAgentRow,
} from "@/app/actions/admin/locations"

const UNASSIGNED = "__unassigned__"

export function LocationsClient({
  initialLocations, initialUnassigned, initialAgents, loadError,
}: {
  initialLocations: OfficeLocation[]
  initialUnassigned: number
  initialAgents: BrokerageAgentRow[]
  loadError: string | null
}) {
  const { toast } = useToast()
  const [locations, setLocations] = useState<OfficeLocation[]>(initialLocations)
  const [agents, setAgents] = useState<BrokerageAgentRow[]>(initialAgents)

  const unassignedCount = useMemo(() => agents.filter((a) => !a.locationId).length || initialUnassigned, [agents, initialUnassigned])
  const countFor = (locId: string) => agents.filter((a) => a.locationId === locId).length

  async function handleAssign(userId: string, value: string) {
    const locationId = value === UNASSIGNED ? null : value
    const prev = agents
    setAgents((cur) => cur.map((a) => (a.userId === userId ? { ...a, locationId } : a)))
    const r = await assignUserToLocationAction(userId, locationId)
    if (!r.ok) { setAgents(prev); toast({ title: "Could not reassign", description: r.error, variant: "destructive" }) }
    else toast({ title: "Agent reassigned" })
  }

  // EDIT — the surface had Add, Delete and Reassign but no way to correct an
  // office. Renaming or fixing an address meant deleting the office (which
  // unassigns every agent in it) and rebuilding it. updateLocationAction already
  // existed, admin-gated and brokerage-scoped; it just had no caller.
  async function handleEdit(loc: OfficeLocation, patch: { name: string; address: string; city: string; state: string }) {
    const prev = locations
    const next: OfficeLocation = {
      ...loc,
      name: patch.name.trim(),
      address: patch.address.trim() || null,
      city: patch.city.trim() || null,
      state: patch.state.trim() || null,
    }
    setLocations((cur) => cur.map((l) => (l.id === loc.id ? next : l)).sort((a, b) => a.name.localeCompare(b.name)))
    const r = await updateLocationAction(loc.id, {
      name: patch.name,
      address: patch.address,
      city: patch.city,
      state: patch.state,
    })
    if (!r.ok) {
      // Roll the optimistic edit back — the action refuses an empty name and a
      // row outside the caller's brokerage, and the list must not keep showing a
      // change the database rejected.
      setLocations(prev)
      toast({ title: "Could not update office", description: r.error, variant: "destructive" })
      return false
    }
    toast({ title: "Office updated" })
    return true
  }

  async function handleDelete(loc: OfficeLocation) {
    const prev = locations
    setLocations((cur) => cur.filter((l) => l.id !== loc.id))
    setAgents((cur) => cur.map((a) => (a.locationId === loc.id ? { ...a, locationId: null } : a)))
    const r = await deleteLocationAction(loc.id)
    if (!r.ok) { setLocations(prev); toast({ title: "Could not delete office", description: r.error, variant: "destructive" }) }
    else toast({ title: `Deleted ${loc.name}`, description: "Its agents were moved to Unassigned." })
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Building2 className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Office Locations</h1>
            <p className="text-sm text-muted-foreground">Manage your brokerage's offices and place agents in them.</p>
          </div>
        </div>
        <NewOfficeDialog onCreated={(loc) => setLocations((cur) => [...cur, loc].sort((a, b) => a.name.localeCompare(b.name)))} />
      </div>

      {loadError ? (
        <Card><CardContent className="py-10 text-center text-red-600">Failed to load: {loadError}</CardContent></Card>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard label="Offices" value={locations.length} icon={Building2} />
            <StatCard label="Agents" value={agents.length} icon={Users} />
            <StatCard label="Unassigned" value={unassignedCount} icon={MapPin} />
            <StatCard label="Largest office" value={locations.reduce((m, l) => Math.max(m, countFor(l.id)), 0)} icon={Users} />
          </div>

          {/* Offices */}
          <Card>
            <CardHeader><CardTitle className="text-base">Offices</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {locations.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No offices yet. Add your first office to get started.</p>
              ) : (
                locations.map((loc) => (
                  <div key={loc.id} className="flex items-center justify-between p-3 rounded-lg border">
                    <div className="min-w-0">
                      <p className="font-medium flex items-center gap-2">{loc.name}<Badge variant="secondary" className="text-xs">{countFor(loc.id)} agents</Badge></p>
                      {(loc.address || loc.city || loc.state) && (
                        <p className="text-sm text-muted-foreground flex items-center gap-1">
                          <MapPin className="h-3 w-3" />{[loc.address, loc.city, loc.state].filter(Boolean).join(", ")}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <EditOfficeDialog location={loc} onSave={(patch) => handleEdit(loc, patch)} />
                      <Button variant="ghost" size="sm" onClick={() => handleDelete(loc)} className="text-red-600 hover:text-red-700">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* Agent assignment */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Agent Assignments</CardTitle>
              <CardDescription>Place each agent in an office, or leave them Unassigned.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {agents.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No agents in this brokerage yet.</p>
              ) : (
                agents.map((a) => (
                  <div key={a.id} className="flex items-center justify-between gap-4 p-2 rounded-lg hover:bg-accent/40">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{a.name}</p>
                      {a.email && <p className="text-xs text-muted-foreground truncate">{a.email}</p>}
                    </div>
                    <Select value={a.locationId ?? UNASSIGNED} onValueChange={(v) => handleAssign(a.userId, v)}>
                      <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                        {locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

function StatCard({ label, value, icon: Icon }: { label: string; value: number; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <Icon className="h-7 w-7 text-muted-foreground" />
        <div><p className="text-2xl font-bold">{value}</p><p className="text-xs text-muted-foreground">{label}</p></div>
      </CardContent>
    </Card>
  )
}

function NewOfficeDialog({ onCreated }: { onCreated: (loc: OfficeLocation) => void }) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [address, setAddress] = useState("")
  const [city, setCity] = useState("")
  const [state, setState] = useState("")
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    if (!name.trim()) { toast({ title: "Office name required", variant: "destructive" }); return }
    setSubmitting(true)
    try {
      const r = await createLocationAction({ name, address, city, state })
      if (!r.ok) { toast({ title: "Could not create office", description: r.error, variant: "destructive" }); return }
      onCreated({ id: r.id, name: name.trim(), address: address.trim() || null, city: city.trim() || null, state: state.trim() || null, agentCount: 0, createdAt: new Date().toISOString() })
      toast({ title: "Office created" })
      setName(""); setAddress(""); setCity(""); setState(""); setOpen(false)
    } finally { setSubmitting(false) }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="h-4 w-4 mr-2" />Add Office</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Add an office</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1"><Label htmlFor="o-name">Office name</Label><Input id="o-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Downtown Austin" /></div>
          <div className="space-y-1"><Label htmlFor="o-addr">Address</Label><Input id="o-addr" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="100 Congress Ave" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label htmlFor="o-city">City</Label><Input id="o-city" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Austin" /></div>
            <div className="space-y-1"><Label htmlFor="o-state">State</Label><Input id="o-state" value={state} onChange={(e) => setState(e.target.value)} placeholder="TX" /></div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={submitting}>{submitting ? "Creating…" : "Create Office"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditOfficeDialog({
  location,
  onSave,
}: {
  location: OfficeLocation
  onSave: (patch: { name: string; address: string; city: string; state: string }) => Promise<boolean>
}) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(location.name)
  const [address, setAddress] = useState(location.address ?? "")
  const [city, setCity] = useState(location.city ?? "")
  const [state, setState] = useState(location.state ?? "")
  const [submitting, setSubmitting] = useState(false)

  function openChange(v: boolean) {
    // Re-seed from the row each time it opens so a cancelled edit does not linger.
    if (v) {
      setName(location.name)
      setAddress(location.address ?? "")
      setCity(location.city ?? "")
      setState(location.state ?? "")
    }
    setOpen(v)
  }

  async function submit() {
    if (!name.trim()) { toast({ title: "Office name required", variant: "destructive" }); return }
    setSubmitting(true)
    try {
      const ok = await onSave({ name, address, city, state })
      if (ok) setOpen(false)
    } finally { setSubmitting(false) }
  }

  return (
    <Dialog open={open} onOpenChange={openChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`Edit ${location.name}`}>
          <Pencil className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit office</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1"><Label htmlFor={`e-name-${location.id}`}>Office name</Label><Input id={`e-name-${location.id}`} value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor={`e-addr-${location.id}`}>Address</Label><Input id={`e-addr-${location.id}`} value={address} onChange={(e) => setAddress(e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label htmlFor={`e-city-${location.id}`}>City</Label><Input id={`e-city-${location.id}`} value={city} onChange={(e) => setCity(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor={`e-state-${location.id}`}>State</Label><Input id={`e-state-${location.id}`} value={state} onChange={(e) => setState(e.target.value)} /></div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={submitting}>{submitting ? "Saving…" : "Save changes"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
