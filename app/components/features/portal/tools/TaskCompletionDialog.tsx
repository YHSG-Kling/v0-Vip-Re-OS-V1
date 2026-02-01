"use client"

import React from "react"

import { useState, useTransition } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Loader2, CheckCircle2, Upload, AlertCircle } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { submitTaskForm } from "@/app/actions/journey-tasks"

// Client-side form field configuration
function getTaskFormFieldsClient(taskType: string): {
  fields: { name: string; label: string; type: string; required: boolean; options?: string[] }[]
  description: string
} {
  switch (taskType) {
    case "pre_approval":
      return {
        description: "Upload your pre-approval letter or provide lender details",
        fields: [
          { name: "lender_name", label: "Lender Name", type: "text", required: true },
          { name: "loan_amount", label: "Pre-Approval Amount", type: "number", required: true },
          { name: "loan_type", label: "Loan Type", type: "select", required: true, options: ["Conventional", "FHA", "VA", "USDA", "Jumbo"] },
          { name: "expiration_date", label: "Expiration Date", type: "date", required: true },
          { name: "notes", label: "Additional Notes", type: "textarea", required: false },
        ],
      }
    case "budget_setup":
      return {
        description: "Define your budget and financing preferences",
        fields: [
          { name: "max_budget", label: "Maximum Budget", type: "number", required: true },
          { name: "down_payment_percent", label: "Down Payment %", type: "number", required: true },
          { name: "monthly_payment_max", label: "Max Monthly Payment", type: "number", required: false },
          { name: "financing_type", label: "Financing Type", type: "select", required: true, options: ["Cash", "Conventional", "FHA", "VA", "USDA"] },
        ],
      }
    case "criteria_setup":
      return {
        description: "Define your property search criteria",
        fields: [
          { name: "min_beds", label: "Minimum Bedrooms", type: "number", required: true },
          { name: "min_baths", label: "Minimum Bathrooms", type: "number", required: true },
          { name: "min_sqft", label: "Minimum Square Feet", type: "number", required: false },
          { name: "property_types", label: "Property Types", type: "multiselect", required: true, options: ["Single Family", "Condo", "Townhouse", "Multi-Family"] },
          { name: "preferred_areas", label: "Preferred Areas/Neighborhoods", type: "text", required: false },
        ],
      }
    case "investment_criteria":
      return {
        description: "Define your investment criteria and goals",
        fields: [
          { name: "target_cap_rate", label: "Target Cap Rate (%)", type: "number", required: true },
          { name: "investment_strategy", label: "Strategy", type: "select", required: true, options: ["Buy and Hold", "Fix and Flip", "BRRRR", "Wholesale", "House Hacking"] },
          { name: "max_purchase_price", label: "Max Purchase Price", type: "number", required: true },
          { name: "target_cash_flow", label: "Target Monthly Cash Flow", type: "number", required: false },
        ],
      }
    case "showing_feedback":
      return {
        description: "Provide feedback on your showing",
        fields: [
          { name: "rating", label: "Overall Rating", type: "select", required: true, options: ["1 - Not Interested", "2 - Somewhat Interested", "3 - Interested", "4 - Very Interested", "5 - Love It!"] },
          { name: "pros", label: "What Did You Like?", type: "textarea", required: false },
          { name: "cons", label: "What Concerns Do You Have?", type: "textarea", required: false },
          { name: "would_offer", label: "Would you consider making an offer?", type: "select", required: true, options: ["Yes", "Maybe", "No"] },
        ],
      }
    case "document_upload":
      return {
        description: "Upload the required document",
        fields: [
          { name: "document_type", label: "Document Type", type: "text", required: true },
          { name: "notes", label: "Notes", type: "textarea", required: false },
          { name: "confirmed", label: "Confirm Upload", type: "checkbox", required: true },
        ],
      }
    default:
      return {
        description: "Mark this task as complete",
        fields: [
          { name: "notes", label: "Notes (optional)", type: "textarea", required: false },
          { name: "confirmed", label: "Confirm Completion", type: "checkbox", required: true },
        ],
      }
  }
}

interface TaskCompletionDialogProps {
  task: {
    id: string
    title: string
    description?: string
    stageId?: string
    stageName?: string
    type?: string
    required?: boolean
    estimatedMinutes?: number
  }
  contactId: string
  persona?: string
  transactionId?: string
  onComplete?: () => void
  children: React.ReactNode
}

export function TaskCompletionDialog({
  task,
  contactId,
  persona,
  transactionId,
  onComplete,
  children,
}: TaskCompletionDialogProps) {
  const [open, setOpen] = useState(false)
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [formData, setFormData] = useState<Record<string, any>>({})

  // Get form fields based on task type
  const taskType = task.type || inferTaskType(task.title)
  const formConfig = getTaskFormFieldsClient(taskType)

  function inferTaskType(title: string): string {
    const lowercaseTitle = title.toLowerCase()
    if (lowercaseTitle.includes("pre-approval") || lowercaseTitle.includes("preapproval")) return "pre_approval"
    if (lowercaseTitle.includes("budget")) return "budget_setup"
    if (lowercaseTitle.includes("criteria") || lowercaseTitle.includes("requirements")) return "criteria_setup"
    if (lowercaseTitle.includes("investment") && lowercaseTitle.includes("criteria")) return "investment_criteria"
    if (lowercaseTitle.includes("feedback") || lowercaseTitle.includes("showing")) return "showing_feedback"
    if (lowercaseTitle.includes("document") || lowercaseTitle.includes("upload")) return "document_upload"
    return "default"
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    startTransition(async () => {
      const result = await submitTaskForm({
        contactId,
        transactionId,
        taskId: task.id,
        taskName: task.title,
        taskType,
        formData,
      })

      if (result.success) {
        toast({
          title: "Task Completed",
          description: `"${task.title}" has been marked as complete.`,
        })
        setOpen(false)
        setFormData({})
        onComplete?.()
      } else {
        toast({
          title: "Error",
          description: result.error || "Failed to complete task",
          variant: "destructive",
        })
      }
    })
  }

  const handleFieldChange = (fieldName: string, value: any) => {
    setFormData((prev) => ({ ...prev, [fieldName]: value }))
  }

  const onOpenChange = (open: boolean) => {
    setOpen(open)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {children}
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {task.required && <AlertCircle className="w-5 h-5 text-orange-500" />}
            {task.title}
          </DialogTitle>
          <DialogDescription>
            {task.description || formConfig.description}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {formConfig.fields.map((field) => (
            <div key={field.name} className="space-y-2">
              <Label htmlFor={field.name} className="flex items-center gap-2">
                {field.label}
                {field.required && <Badge variant="outline" className="text-xs">Required</Badge>}
              </Label>

              {field.type === "text" && (
                <Input
                  id={field.name}
                  value={formData[field.name] || ""}
                  onChange={(e) => handleFieldChange(field.name, e.target.value)}
                  required={field.required}
                />
              )}

              {field.type === "number" && (
                <Input
                  id={field.name}
                  type="number"
                  value={formData[field.name] || ""}
                  onChange={(e) => handleFieldChange(field.name, e.target.value)}
                  required={field.required}
                />
              )}

              {field.type === "date" && (
                <Input
                  id={field.name}
                  type="date"
                  value={formData[field.name] || ""}
                  onChange={(e) => handleFieldChange(field.name, e.target.value)}
                  required={field.required}
                />
              )}

              {field.type === "textarea" && (
                <Textarea
                  id={field.name}
                  value={formData[field.name] || ""}
                  onChange={(e) => handleFieldChange(field.name, e.target.value)}
                  required={field.required}
                  rows={3}
                />
              )}

              {field.type === "select" && field.options && (
                <Select
                  value={formData[field.name] || ""}
                  onValueChange={(value) => handleFieldChange(field.name, value)}
                  required={field.required}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={`Select ${field.label.toLowerCase()}`} />
                  </SelectTrigger>
                  <SelectContent>
                    {field.options.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {field.type === "multiselect" && field.options && (
                <div className="flex flex-wrap gap-2">
                  {field.options.map((option) => {
                    const selected = (formData[field.name] || []).includes(option)
                    return (
                      <Badge
                        key={option}
                        variant={selected ? "default" : "outline"}
                        className="cursor-pointer"
                        onClick={() => {
                          const current = formData[field.name] || []
                          if (selected) {
                            handleFieldChange(field.name, current.filter((o: string) => o !== option))
                          } else {
                            handleFieldChange(field.name, [...current, option])
                          }
                        }}
                      >
                        {option}
                      </Badge>
                    )
                  })}
                </div>
              )}

              {field.type === "checkbox" && (
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id={field.name}
                    checked={formData[field.name] || false}
                    onCheckedChange={(checked) => handleFieldChange(field.name, checked)}
                    required={field.required}
                  />
                  <label htmlFor={field.name} className="text-sm text-muted-foreground">
                    I confirm this task is complete
                  </label>
                </div>
              )}

              {field.type === "file" && (
                <div className="border-2 border-dashed rounded-lg p-6 text-center">
                  <Upload className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">
                    Click to upload or drag and drop
                  </p>
                  <Input
                    id={field.name}
                    type="file"
                    className="hidden"
                    onChange={(e) => handleFieldChange(field.name, e.target.files?.[0]?.name)}
                  />
                </div>
              )}
            </div>
          ))}

          <div className="flex gap-3 pt-4">
            <Button
              type="button"
              variant="outline"
              className="flex-1 bg-transparent"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending} className="flex-1">
              {isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                  Complete Task
                </>
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
