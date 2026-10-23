"use client"

import Image from "next/image"
import { Card, CardContent } from "@/app/components/ui/card"
import { Mail } from "lucide-react"

export type DirectMailPieceType = "postcard" | "letter" | "handwritten_letter" | "thank_you_note"

/** Palette from the AI design suggestion (aiSuggestDesign colorScheme). Applied
 *  best-effort as inline styles so the preview reflects the suggested design. */
export interface MailPreviewColors {
  primary?: string
  background?: string
  text?: string
  accent?: string
}

interface Props {
  pieceType: DirectMailPieceType
  headline?: string
  body?: string
  cta?: string
  agentName?: string
  agentPhone?: string
  agentLogoUrl?: string
  qrImageUrl?: string | null
  recipientName?: string
  colors?: MailPreviewColors
}

const PIECE_LABELS: Record<DirectMailPieceType, string> = {
  postcard: "Postcard (4×6)",
  letter: "Letter (#10 envelope)",
  handwritten_letter: "Handwritten Letter",
  thank_you_note: "Thank-You Note",
}

export function MailPiecePreview({
  pieceType,
  headline = "Headline goes here",
  body = "Body copy goes here. Lead with value, end with a single clear next step.",
  cta = "Scan to learn more",
  agentName = "Agent Name",
  agentPhone,
  agentLogoUrl,
  qrImageUrl,
  recipientName,
  colors,
}: Props) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Mail className="h-3.5 w-3.5" />
        <span>Preview · {PIECE_LABELS[pieceType]}</span>
      </div>

      {pieceType === "postcard" && <PostcardPreview {...{ headline, body, cta, agentName, agentPhone, agentLogoUrl, qrImageUrl, colors }} />}
      {pieceType === "letter" && <LetterPreview {...{ headline, body, cta, agentName, agentPhone, agentLogoUrl, qrImageUrl, recipientName, colors }} />}
      {pieceType === "handwritten_letter" && <HandwrittenLetterPreview {...{ body, agentName, recipientName }} />}
      {pieceType === "thank_you_note" && <ThankYouNotePreview {...{ body, agentName, recipientName }} />}
    </div>
  )
}

function PostcardPreview({ headline, body, cta, agentName, agentPhone, agentLogoUrl, qrImageUrl, colors }: Omit<Props, "pieceType" | "recipientName">) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        {/* accent bar reflects the suggested design's accent/primary color */}
        {(colors?.accent || colors?.primary) && (
          <div className="h-1.5 w-full" style={{ backgroundColor: colors.accent || colors.primary }} />
        )}
        {/* 4x6 aspect ratio (postcard) */}
        <div className="aspect-[3/2] w-full p-6 flex flex-col gap-3 border" style={{ backgroundColor: colors?.background || "#ffffff" }}>
          <h3 className="text-lg font-bold" style={{ color: colors?.primary || "#111827" }}>{headline}</h3>
          <p className="text-xs flex-1" style={{ color: colors?.text || "#374151" }}>{body}</p>
          <div className="flex items-end justify-between gap-3">
            <div className="text-[10px] text-gray-700">
              {agentLogoUrl && <Image src={agentLogoUrl} alt="logo" width={40} height={40} className="mb-1" />}
              <p className="font-semibold">{agentName}</p>
              {agentPhone && <p>{agentPhone}</p>}
            </div>
            <div className="flex flex-col items-center gap-1">
              {qrImageUrl ? (
                <Image src={qrImageUrl} alt="QR code" width={72} height={72} unoptimized />
              ) : (
                <div className="h-[72px] w-[72px] border-2 border-dashed border-gray-300 flex items-center justify-center text-[8px] text-gray-400 text-center">
                  QR<br />placeholder
                </div>
              )}
              <p className="text-[8px] text-gray-600 max-w-[80px] text-center">{cta}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function LetterPreview({ headline, body, cta, agentName, agentPhone, agentLogoUrl, qrImageUrl, recipientName }: Omit<Props, "pieceType">) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        {/* US Letter aspect ratio */}
        <div className="aspect-[8.5/11] w-full bg-white p-8 flex flex-col gap-4 border">
          <div className="flex items-center justify-between border-b pb-3">
            {agentLogoUrl && <Image src={agentLogoUrl} alt="logo" width={48} height={48} />}
            <div className="text-right text-[10px] text-gray-700">
              <p className="font-semibold">{agentName}</p>
              {agentPhone && <p>{agentPhone}</p>}
            </div>
          </div>
          <p className="text-xs text-gray-800">Dear {recipientName || "[Recipient]"},</p>
          <h3 className="text-base font-semibold text-gray-900">{headline}</h3>
          <p className="text-xs text-gray-700 leading-relaxed flex-1">{body}</p>
          <div className="flex items-end justify-between border-t pt-3">
            <p className="text-xs italic text-gray-700">Warm regards,<br />{agentName}</p>
            <div className="flex flex-col items-center gap-1">
              {qrImageUrl ? (
                <Image src={qrImageUrl} alt="QR code" width={64} height={64} unoptimized />
              ) : (
                <div className="h-[64px] w-[64px] border-2 border-dashed border-gray-300 flex items-center justify-center text-[8px] text-gray-400 text-center">
                  QR<br />placeholder
                </div>
              )}
              <p className="text-[8px] text-gray-600 max-w-[70px] text-center">{cta}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function HandwrittenLetterPreview({ body, agentName, recipientName }: Pick<Props, "body" | "agentName" | "recipientName">) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div className="aspect-[8.5/11] w-full bg-amber-50 p-10 flex flex-col gap-5 border" style={{ fontFamily: '"Caveat", "Brush Script MT", cursive' }}>
          <p className="text-base text-blue-900">Dear {recipientName || "[Recipient]"},</p>
          <p className="text-base text-blue-900 leading-relaxed flex-1 whitespace-pre-wrap">{body}</p>
          <p className="text-base text-blue-900 self-end">Warmly, {agentName}</p>
        </div>
        <div className="px-3 py-2 text-[10px] text-muted-foreground bg-gray-50 border-t">
          Printed via robotic handwriting service for an authentic personal feel.
        </div>
      </CardContent>
    </Card>
  )
}

function ThankYouNotePreview({ body, agentName, recipientName }: Pick<Props, "body" | "agentName" | "recipientName">) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        {/* Folded card — show the inside spread */}
        <div className="aspect-[2/1] w-full grid grid-cols-2 border bg-white">
          <div className="bg-rose-50 border-r p-6 flex items-center justify-center">
            <p className="text-2xl font-serif italic text-rose-900">Thank You</p>
          </div>
          <div className="p-6 flex flex-col gap-3">
            <p className="text-xs text-gray-800">Dear {recipientName || "[Recipient]"},</p>
            <p className="text-xs text-gray-800 flex-1 whitespace-pre-wrap leading-relaxed">{body}</p>
            <p className="text-xs italic text-gray-700 self-end">— {agentName}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
