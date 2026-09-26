/**
 * remotion/components/SafeImg.tsx
 *
 * <Img> THAT DEGRADES INSTEAD OF CANCELLING THE RENDER.
 *
 * Every photo, logo and headshot in remotion/ arrives as a TENANT or MLS URL:
 * a listing photo the feed has since rotated, a brokerage logo somebody moved,
 * a headshot on an expired signed URL. Remotion's <Img> retries a failed load
 * `maxRetries` times (default 2, exponential backoff) and then, when no
 * `onError` is supplied, calls cancelRender() — the installed package says so
 * itself (node_modules/remotion/dist/cjs/Img.js, `didGetError`: the branch
 * after `errors > maxRetries` is `cancelRender('Error loading image with src:
 * …')` unless `onError` exists, in which case `onError(e)` is called and
 * nothing is cancelled). So ONE dead URL among a reel's twenty photos used to
 * fail the whole render — the row went to `failed`, the tenant got nothing, and
 * the nineteen good photos were never seen.
 *
 * Before this wrapper, 0 of the ~89 <Img> elements in remotion/ carried an
 * onError (measured 2026-09-03). test:remotion-setup §5 now requires every
 * remote-src <Img> to be this wrapper or to carry its own onError.
 *
 * HOW IT DEGRADES. `onError` fires once the image's own retries are spent; the
 * wrapper flips to `failed` and renders `fallback` (or a translucent neutral
 * panel carrying the same `style`, so the layout holds and the composition's
 * gradients/borders/rings still frame the gap). Unmounting the <Img> runs its
 * layout-effect cleanup, which calls continueRender() on the handle the image
 * had opened — that is what lets the frame finish rather than time out.
 *
 * WHAT `delayRenderRetries={1}` BUYS, AND WHY ONLY ONE. A 404 goes through the
 * error path above. A CDN that HANGS (no error, no load) never reaches
 * onError; that is the delayRender timeout (default 30 s), and
 * `delayRenderRetries` is the number of times the renderer re-attempts the
 * FRAME after such a timeout (delay-render.js: `retriesLeft = retries -
 * (attempt - 1)` adds the retry token to the timeout error). One retry covers
 * a transient stall; more would triple a 30 s wait per hung image on a render
 * that is already going to degrade.
 *
 * NOT FOR DATA URLS. A QR minted in-process (qrCodeDataUrl, optOutQrDataUrl)
 * cannot fail to load unless the producer is broken, and a print piece with a
 * blank square where the QR was is WORSE than a failed render — so those sites
 * stay bare <Img> on purpose and the guard's finder recognises them by name.
 *
 * NO `effects`. With effects, <Img> renders a <CanvasImage> and REFUSES
 * `onError` ("cannot be used on <Img> when effects are passed", Img.js
 * `imgCanvasFallbackIncompatibleProps`). The prop is omitted from this
 * wrapper's type so tsc refuses the combination instead of the renderer.
 */
import React, { useCallback, useState } from "react"
import { Img } from "remotion"

type ImgProps = React.ComponentProps<typeof Img>

export interface SafeImgProps extends Omit<ImgProps, "onError" | "effects"> {
  /** Rendered in place of the image once every retry has failed. Default: a
   *  translucent neutral panel with the same `style`, so the layout holds. */
  fallback?: React.ReactNode
  /** Observe the give-up (logging, a counter). The fallback renders regardless. */
  onError?: ImgProps["onError"]
}

/** The neutral tone the default fallback paints — slate at 18%, so it reads as
 *  "no photo" over a dark brand field AND over a white print sheet. */
export const SAFE_IMG_FALLBACK_TONE = "rgba(148, 163, 184, 0.18)"

export const SafeImg: React.FC<SafeImgProps> = ({ fallback, onError, style, ...rest }) => {
  const [failed, setFailed] = useState(false)
  const giveUp = useCallback<NonNullable<ImgProps["onError"]>>(
    (e) => {
      onError?.(e)
      setFailed(true)
    },
    [onError],
  )

  if (failed) {
    if (fallback !== undefined) return <>{fallback}</>
    return <div aria-hidden style={{ ...style, backgroundColor: SAFE_IMG_FALLBACK_TONE }} />
  }

  return <Img {...rest} style={style} onError={giveUp} delayRenderRetries={1} />
}
