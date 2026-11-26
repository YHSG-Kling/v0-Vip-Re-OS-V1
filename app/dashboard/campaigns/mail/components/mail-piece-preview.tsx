"use client"

import Image from "next/image"
import { Card, CardContent } from "@/app/components/ui/card"
import { Mail } from "lucide-react"
// The blank layout library (wave 151, lane 151H) — the preview says which GLOBAL layout the piece prints on; piece-type.ts is
// client-safe (type-only import).
import { MAIL_LAYOUT_LIBRARY, HANDWRITING_STYLE_TYPEFACE, decideMailQrRegion, type MailLayoutKey } from "@/lib/direct-mail/mail-piece-rules"

export type DirectMailPieceType = "postcard" | "letter" | "handwritten_letter" | "thank_you_note"

/** Which blank layout(s) a campaign piece type prints on. */
const LAYOUTS_FOR: Record<DirectMailPieceType, Array<keyof typeof MAIL_LAYOUT_LIBRARY>> = {
  postcard: ["postcard_front", "postcard_back"],
  letter: ["letter"],
  handwritten_letter: ["personal_letter"],
  thank_you_note: ["personal_letter"],
}

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
  /** Wave 152 (152C): the campaign's REGISTERED code tracking link — the region prints its token under the symbol. */
  qrScanUrl?: string | null
  recipientName?: string
  colors?: MailPreviewColors
}

/**
 * Wave 152 (lane 152C) — THE OPTIONAL QR REGION, previewed with the SAME decision the renderers use
 * (decideMailQrRegion). A registered code prints with its unique token beneath it; anything else shows the empty
 * region and says the piece still mails — a QR never holds up a mailing.
 */
function QrRegionPreview({ layout, qrImageUrl, qrScanUrl, px }: { layout: MailLayoutKey; qrImageUrl?: string | null; qrScanUrl?: string | null; px: number }) {
  const region = decideMailQrRegion({ layout, scanUrl: qrScanUrl ?? null })
  const spec = MAIL_LAYOUT_LIBRARY[layout].qrRegion
  if (!spec) return null
  if (region.print && qrImageUrl) {
    return (
      <div className="flex flex-col items-center gap-0.5" data-qr-token={region.token}>
        <Image src={qrImageUrl} alt="QR code" width={px} height={px} unoptimized />
        <p className="text-[8px] text-gray-600">Scan with your phone camera</p>
        <p className="font-mono text-[7px] text-gray-500 break-all max-w-[90px] text-center">{region.token}</p>
      </div>
    )
  }
  return (
    <div
      className="border-2 border-dashed border-gray-300 flex items-center justify-center text-[8px] text-gray-500 text-center p-1"
      style={{ width: px, height: px }}
      title={region.print ? "Your campaign's code prints here." : region.note}
    >
      Optional QR<br />{spec.sizeIn} in
    </div>
  )
}

const PIECE_LABELS: Record<DirectMailPieceType, string> = {
  postcard: "Postcard (4×6)",
  letter: "Letter (#10 envelope)",
  // Owner (wave 151): "handwritten font by computer can be a substitute" — described as handwriting-STYLE PRINTED mail, never
  // handwritten. The stored key stays; the words say what it is.
  handwritten_letter: "Handwriting-style printed note",
  thank_you_note: "Thank-you note (handwriting-style, printed)",
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
  qrScanUrl,
  recipientName,
  colors,
}: Props) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Mail className="h-3.5 w-3.5" />
        <span>Preview · {PIECE_LABELS[pieceType]}</span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Prints on the global blank layout{LAYOUTS_FOR[pieceType].length > 1 ? "s" : ""} {LAYOUTS_FOR[pieceType].map((k) => MAIL_LAYOUT_LIBRARY[k].label).join(" + ")} — your logo, colors, name, license line, QR and
        return address are filled in from your settings at proof time; the layout itself carries no brand and no address.
      </p>
      <p className="text-[11px] text-muted-foreground">
        Every layout has an optional QR area. It prints this campaign&apos;s own unique code when one is set; otherwise it stays blank and the piece mails as usual.
      </p>

      {pieceType === "postcard" && <PostcardPreview {...{ headline, body, cta, agentName, agentPhone, agentLogoUrl, qrImageUrl, qrScanUrl, colors }} />}
      {pieceType === "letter" && <LetterPreview {...{ headline, body, cta, agentName, agentPhone, agentLogoUrl, qrImageUrl, qrScanUrl, recipientName, colors }} />}
      {pieceType === "handwritten_letter" && <HandwritingStyleNotePreview {...{ body, agentName, recipientName, qrImageUrl, qrScanUrl }} />}
      {pieceType === "thank_you_note" && <ThankYouNotePreview {...{ body, agentName, recipientName, qrImageUrl, qrScanUrl }} />}
    </div>
  )
}

function PostcardPreview({ headline, body, cta, agentName, agentPhone, agentLogoUrl, qrImageUrl, qrScanUrl, colors }: Omit<Props, "pieceType" | "recipientName">) {
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
              <QrRegionPreview layout="postcard_front" qrImageUrl={qrImageUrl} qrScanUrl={qrScanUrl} px={72} />
              <p className="text-[8px] text-gray-600 max-w-[80px] text-center">{cta}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function LetterPreview({ headline, body, cta, agentName, agentPhone, agentLogoUrl, qrImageUrl, qrScanUrl, recipientName }: Omit<Props, "pieceType">) {
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
              <QrRegionPreview layout="letter" qrImageUrl={qrImageUrl} qrScanUrl={qrScanUrl} px={64} />
              <p className="text-[8px] text-gray-600 max-w-[70px] text-center">{cta}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function HandwritingStyleNotePreview({ body, agentName, recipientName, qrImageUrl, qrScanUrl }: Pick<Props, "body" | "agentName" | "recipientName" | "qrImageUrl" | "qrScanUrl">) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div className="aspect-[8.5/11] w-full bg-amber-50 p-10 flex flex-col gap-5 border" style={{ fontFamily: `"${HANDWRITING_STYLE_TYPEFACE.family}", "Brush Script MT", cursive` }}>
          <p className="text-base text-blue-900">Dear {recipientName || "[Recipient]"},</p>
          <p className="text-base text-blue-900 leading-relaxed flex-1 whitespace-pre-wrap">{body}</p>
          <p className="text-base text-blue-900 self-end">Warmly, {agentName}</p>
          <div className="self-end"><QrRegionPreview layout="personal_letter" qrImageUrl={qrImageUrl} qrScanUrl={qrScanUrl} px={56} /></div>
        </div>
        <div className="px-3 py-2 text-[10px] text-muted-foreground bg-gray-50 border-t">
          {HANDWRITING_STYLE_TYPEFACE.description}. A pen-written card comes only from a handwriting provider (none is active).
        </div>
      </CardContent>
    </Card>
  )
}

function ThankYouNotePreview({ body, agentName, recipientName, qrImageUrl, qrScanUrl }: Pick<Props, "body" | "agentName" | "recipientName" | "qrImageUrl" | "qrScanUrl">) {
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
            {/* The thank-you note mails on the personal-note layout (LAYOUTS_FOR) — its optional QR area. */}
            <div className="self-end"><QrRegionPreview layout="personal_letter" qrImageUrl={qrImageUrl} qrScanUrl={qrScanUrl} px={48} /></div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
