"use client"

import { useState, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AddressAutocomplete } from "@/app/components/ui/address-autocomplete"
import { Upload, Users, Trash2, Plus, FileSpreadsheet } from "lucide-react"
import type { Campaign, Recipient } from "../mail-dashboard"
import { addRecipients, removeRecipient } from "@/app/actions/direct-mail"


interface RecipientsTabProps {
  recipients: Recipient[]
  campaigns: Campaign[]
  selectedCampaignId: string | null
  onSelectCampaign: (id: string) => void
  loading: boolean
  onRefresh: () => void
}

const STATUS_COLORS: Record<Recipient["delivery_status"], string> = {
  pending: "bg-muted text-muted-foreground",
  mailed: "bg-blue-100 text-blue-700",
  delivered: "bg-green-100 text-green-700",
  returned: "bg-amber-100 text-amber-700",
  failed: "bg-red-100 text-red-700",
}

const STATUS_LABELS: Record<Recipient["delivery_status"], string> = {
  pending: "Pending",
  mailed: "Mailed",
  delivered: "Delivered",
  returned: "Returned",
  failed: "Failed",
}

export function RecipientsTab({
  recipients,
  campaigns,
  selectedCampaignId,
  onSelectCampaign,
  loading,
  onRefresh,
}: RecipientsTabProps) {
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false)
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [adding, setAdding] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [newRecipient, setNewRecipient] = useState({
    firstName: "",
    lastName: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    zip: "",
  })

  async function handleFileUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file || !selectedCampaignId) return

    setImporting(true)
    try {
      const text = await file.text()
      const lines = text.split("\n").filter((line) => line.trim())
      const header = lines[0].toLowerCase().split(",")

      // Find column indices
      const firstNameIdx = header.findIndex((h) => h.includes("first"))
      const lastNameIdx = header.findIndex((h) => h.includes("last"))
      const address1Idx = header.findIndex((h) => h.includes("address") && !h.includes("2"))
      const address2Idx = header.findIndex((h) => h.includes("address2") || h.includes("address 2"))
      const cityIdx = header.findIndex((h) => h.includes("city"))
      const stateIdx = header.findIndex((h) => h.includes("state"))
      const zipIdx = header.findIndex((h) => h.includes("zip") || h.includes("postal"))

      const recipientsData = lines.slice(1).map((line) => {
        const values = line.split(",").map((v) => v.trim().replace(/^"|"$/g, ""))
        return {
          firstName: values[firstNameIdx] || "",
          lastName: values[lastNameIdx] || "",
          addressLine1: values[address1Idx] || "",
          addressLine2: values[address2Idx] || "",
          city: values[cityIdx] || "",
          state: values[stateIdx] || "",
          zip: values[zipIdx] || "",
        }
      }).filter((r) => r.addressLine1 && r.city && r.state && r.zip)

      if (recipientsData.length > 0) {
        const result = await addRecipients({
          campaignId: selectedCampaignId,
          recipients: recipientsData,
        })
        if (result.success) {
          onRefresh()
          setIsImportDialogOpen(false)
        } else {
          console.error("Import failed:", result.error)
        }
      }
    } catch (error) {
      console.error("File processing error:", error)
    } finally {
      setImporting(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
    }
  }

  async function handleAddRecipient() {
    if (!selectedCampaignId) return
    setAdding(true)
    try {
      const result = await addRecipients({
        campaignId: selectedCampaignId,
        recipients: [newRecipient],
      })
      if (result.success) {
        onRefresh()
        setIsAddDialogOpen(false)
        setNewRecipient({
          firstName: "",
          lastName: "",
          addressLine1: "",
          addressLine2: "",
          city: "",
          state: "",
          zip: "",
        })
      }
    } catch (error) {
      console.error("Add recipient error:", error)
    } finally {
      setAdding(false)
    }
  }

  async function handleRemoveRecipient(recipientId: string) {
    try {
      const result = await removeRecipient(recipientId)
      if (result.success) {
        onRefresh()
      }
    } catch (error) {
      console.error("Remove error:", error)
    }
  }

  const selectedCampaign = campaigns.find((c) => c.id === selectedCampaignId)

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <Select value={selectedCampaignId || ""} onValueChange={onSelectCampaign}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Select a campaign" />
            </SelectTrigger>
            <SelectContent>
              {campaigns.map((campaign) => (
                <SelectItem key={campaign.id} value={campaign.id}>
                  {campaign.campaign_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground">
            {recipients.length} recipient{recipients.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsImportDialogOpen(true)}
            disabled={!selectedCampaignId || selectedCampaign?.status === "mailed"}
          >
            <Upload className="h-4 w-4 mr-2" />
            Import CSV
          </Button>
          <Button
            size="sm"
            onClick={() => setIsAddDialogOpen(true)}
            disabled={!selectedCampaignId || selectedCampaign?.status === "mailed"}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Recipient
          </Button>
        </div>
      </div>

      {!selectedCampaignId ? (
        <Card className="flex flex-col items-center justify-center p-12 text-center">
          <Users className="h-12 w-12 text-muted-foreground mb-4" />
          <CardTitle className="text-lg mb-2">Select a Campaign</CardTitle>
          <CardDescription>
            Choose a campaign to view and manage its recipients.
          </CardDescription>
        </Card>
      ) : recipients.length === 0 ? (
        <Card className="flex flex-col items-center justify-center p-12 text-center">
          <Users className="h-12 w-12 text-muted-foreground mb-4" />
          <CardTitle className="text-lg mb-2">No recipients yet</CardTitle>
          <CardDescription>
            Import a CSV or add recipients manually to this campaign.
          </CardDescription>
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>City</TableHead>
                <TableHead>State</TableHead>
                <TableHead>ZIP</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recipients.map((recipient) => (
                <TableRow key={recipient.id}>
                  <TableCell className="font-medium">
                    {recipient.first_name} {recipient.last_name}
                  </TableCell>
                  <TableCell>
                    {recipient.address_line1}
                    {recipient.address_line2 && (
                      <span className="text-muted-foreground"> {recipient.address_line2}</span>
                    )}
                  </TableCell>
                  <TableCell>{recipient.city}</TableCell>
                  <TableCell>{recipient.state}</TableCell>
                  <TableCell>{recipient.zip}</TableCell>
                  <TableCell>
                    <Badge className={STATUS_COLORS[recipient.delivery_status]}>
                      {STATUS_LABELS[recipient.delivery_status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {recipient.delivery_status === "pending" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleRemoveRecipient(recipient.id)}
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Import CSV Dialog */}
      <Dialog open={isImportDialogOpen} onOpenChange={setIsImportDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import Recipients from CSV</DialogTitle>
            <DialogDescription>
              Upload a CSV file with columns: First Name, Last Name, Address, City, State, ZIP
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="border-2 border-dashed border-border rounded-lg p-8 text-center">
              <FileSpreadsheet className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <input
                type="file"
                accept=".csv"
                ref={fileInputRef}
                onChange={handleFileUpload}
                className="hidden"
                id="csv-upload"
              />
              <label
                htmlFor="csv-upload"
                className="cursor-pointer text-primary hover:underline"
              >
                {importing ? "Processing..." : "Click to upload CSV file"}
              </label>
              <p className="text-sm text-muted-foreground mt-2">
                CSV should have headers: first_name, last_name, address, city, state, zip
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Recipient Dialog */}
      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Recipient</DialogTitle>
            <DialogDescription>
              Manually add a recipient to this campaign.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="firstName">First Name</Label>
                <Input
                  id="firstName"
                  value={newRecipient.firstName}
                  onChange={(e) => setNewRecipient({ ...newRecipient, firstName: e.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="lastName">Last Name</Label>
                <Input
                  id="lastName"
                  value={newRecipient.lastName}
                  onChange={(e) => setNewRecipient({ ...newRecipient, lastName: e.target.value })}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="address1">Address Line 1</Label>
              <AddressAutocomplete
                id="address1"
                value={newRecipient.addressLine1}
                onChange={v => setNewRecipient({ ...newRecipient, addressLine1: v })}
                onSelect={a => setNewRecipient(r => ({
                  ...r,
                  addressLine1: a.street || r.addressLine1,
                  city: a.city || r.city,
                  state: a.state || r.state,
                  zip: a.zip || r.zip,
                }))}
                placeholder="123 Main St"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="address2">Address Line 2 (Optional)</Label>
              <Input
                id="address2"
                value={newRecipient.addressLine2}
                onChange={(e) => setNewRecipient({ ...newRecipient, addressLine2: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="city">City</Label>
                <Input
                  id="city"
                  value={newRecipient.city}
                  onChange={(e) => setNewRecipient({ ...newRecipient, city: e.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="state">State</Label>
                <Input
                  id="state"
                  maxLength={2}
                  value={newRecipient.state}
                  onChange={(e) => setNewRecipient({ ...newRecipient, state: e.target.value.toUpperCase() })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="zip">ZIP</Label>
                <Input
                  id="zip"
                  value={newRecipient.zip}
                  onChange={(e) => setNewRecipient({ ...newRecipient, zip: e.target.value })}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleAddRecipient}
              disabled={
                adding ||
                !newRecipient.firstName ||
                !newRecipient.lastName ||
                !newRecipient.addressLine1 ||
                !newRecipient.city ||
                !newRecipient.state ||
                !newRecipient.zip
              }
            >
              {adding ? "Adding..." : "Add Recipient"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
