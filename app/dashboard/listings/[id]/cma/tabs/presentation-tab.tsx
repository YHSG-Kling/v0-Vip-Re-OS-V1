"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { generateCompletePresentation } from "@/app/actions/cma-presentation"

interface Listing {
  id: string
  address: string | null
  list_price: number | null
  agent_id: string | null
  brokerage_id: string | null
  seller_contact_id?: string | null
}

interface Props {
  listing: Listing
}

type PresentationStatus = {
  success: boolean
  cmaGenerated: boolean
  netSheetGenerated: boolean
  presentationAssembled: boolean
  videoGenerated: boolean
  readyForDecision: boolean
  errors?: string[]
}

function StepRow({ label, done }: { label: string; done: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-foreground">{label}</span>
      <Badge
        className={
          done
            ? "bg-green-100 text-green-800 border-green-300"
            : "bg-muted text-muted-foreground"
        }
      >
        {done ? "Complete" : "Pending"}
      </Badge>
    </div>
  )
}

export function PresentationTab({ listing }: Props) {
  const [salePrice, setSalePrice] = useState(String(listing.list_price ?? ""))
  const [mortgageBalance, setMortgageBalance] = useState("")
  const [customMessage, setCustomMessage] = useState("")
  const [includeVideo, setIncludeVideo] = useState(false)
  const [result, setResult] = useState<PresentationStatus | null>(null)
  const [isPending, startTransition] = useTransition()

  const missingContact = !listing.seller_contact_id
  const missingAgent = !listing.agent_id

  function handleGenerate() {
    if (missingContact || missingAgent) {
      toast.error("Link a seller contact and agent to this listing first")
      return
    }
    const price = Number(salePrice)
    if (!price || price <= 0) {
      toast.error("Enter a valid sale price")
      return
    }

    startTransition(async () => {
      setResult(null)
      try {
        const res = await generateCompletePresentation({
          listingId: listing.id,
          contactId: listing.seller_contact_id as string,
          agentId: listing.agent_id as string,
          brokerageId: listing.brokerage_id ?? undefined,
          salePrice: price,
          mortgageBalance: Number(mortgageBalance) || undefined,
          includeVideo,
          customMessage: customMessage.trim() || undefined,
        })
        setResult(res)
        if (res.success) {
          toast.success("CMA presentation generated — ready for seller decision")
        } else {
          toast.error(res.errors?.[0] ?? "Presentation generation incomplete")
        }
      } catch (err: any) {
        toast.error(err?.message ?? "Failed to generate presentation")
      }
    })
  }

  return (
    <div className="p-6 space-y-6 pb-20">
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Inputs */}
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm font-medium">
              Generate Complete CMA Presentation
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              Assembles a seller-ready presentation: runs the AI CMA, calculates a
              net sheet, and personalizes the listing presentation. Emits the
              seller decision-ready signal when all artifacts complete.
            </p>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">Sale Price</Label>
                <Input
                  type="number"
                  value={salePrice}
                  onChange={(e) => setSalePrice(e.target.value)}
                  className="mt-1 h-8 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Mortgage Balance</Label>
                <Input
                  type="number"
                  value={mortgageBalance}
                  onChange={(e) => setMortgageBalance(e.target.value)}
                  className="mt-1 h-8 text-sm"
                />
              </div>
            </div>

            <div>
              <Label className="text-xs text-muted-foreground">
                Custom Welcome Message (optional)
              </Label>
              <Textarea
                value={customMessage}
                onChange={(e) => setCustomMessage(e.target.value)}
                placeholder="A personal note to your seller…"
                className="mt-1 text-sm min-h-[72px]"
              />
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="include-video"
                checked={includeVideo}
                onCheckedChange={(c) => setIncludeVideo(c === true)}
              />
              <Label htmlFor="include-video" className="text-sm cursor-pointer">
                Generate presentation video
              </Label>
            </div>

            <Button
              size="sm"
              onClick={handleGenerate}
              disabled={isPending || missingContact || missingAgent}
            >
              {isPending ? "Generating…" : "Generate Presentation"}
            </Button>

            {(missingContact || missingAgent) && (
              <p className="text-xs text-amber-600">
                Link a seller contact and an agent to this listing to generate a
                presentation.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Status */}
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm font-medium">Workflow Status</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-3">
            {!result ? (
              <p className="text-sm text-muted-foreground">
                Run the workflow to assemble the seller presentation.
              </p>
            ) : (
              <>
                <div className="space-y-2">
                  <StepRow label="CMA Generated" done={result.cmaGenerated} />
                  <StepRow label="Net Sheet Generated" done={result.netSheetGenerated} />
                  <StepRow
                    label="Presentation Assembled"
                    done={result.presentationAssembled}
                  />
                  {includeVideo && (
                    <StepRow label="Video Generated" done={result.videoGenerated} />
                  )}
                </div>

                <div className="pt-2 border-t border-border flex items-center justify-between">
                  <span className="text-sm font-medium">Ready for Decision</span>
                  <Badge
                    className={
                      result.readyForDecision
                        ? "bg-green-100 text-green-800 border-green-300"
                        : "bg-amber-100 text-amber-800 border-amber-300"
                    }
                  >
                    {result.readyForDecision ? "Yes" : "Not yet"}
                  </Badge>
                </div>

                {result.errors && result.errors.length > 0 && (
                  <div className="text-xs text-red-700 bg-red-50 rounded px-3 py-2 border border-red-200 space-y-1">
                    {result.errors.map((e, i) => (
                      <p key={i}>{e}</p>
                    ))}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
