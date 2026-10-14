/**
 * lib/esign/google-drive-upload.ts — PURE half of the Google eSignature hand-off
 * (lib/esign/google-esign-handoff.ts, lane 88C): the Drive grant rule, the multipart/related
 * upload body, and the Drive window URL. No I/O, no server-only marker, so
 * scripts/form-wizard-esign-simulator.ts asserts the exact bytes the upload sends.
 */

/** PURE: does a recorded OAuth grant include Drive file access? null = unknown grant. */
export function googleDriveGranted(scope: string | null | undefined): boolean | null {
  if (scope === null || scope === undefined || scope.trim() === "") return null
  return /(^|\s)https:\/\/www\.googleapis\.com\/auth\/drive(\.file)?(\s|$)/.test(scope)
}

/** PURE: the multipart/related body Drive's uploadType=multipart expects (JSON metadata, then the PDF). */
export function buildDriveMultipartBody(
  fileName: string,
  pdfBytes: Uint8Array,
  boundary: string,
  description?: string,
): Buffer {
  const meta = JSON.stringify({
    name: fileName.toLowerCase().endsWith(".pdf") ? fileName : `${fileName}.pdf`,
    mimeType: "application/pdf",
    ...(description ? { description } : {}),
  })
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`, "utf8"),
    Buffer.from(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`, "utf8"),
    Buffer.from(pdfBytes),
    Buffer.from(`\r\n--${boundary}--`, "utf8"),
  ])
}

/** PURE: the Drive window the agent opens to press "Request eSignature". */
export function driveFileOpenUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`
}
