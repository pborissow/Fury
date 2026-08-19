import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * App-wide scrim tokens. This is the ONE place that owns the dim-mask look —
 * opacity, blur, colour, and stacking. Tune these and every mask/overlay in the
 * app (dialogs, panel scrims, lightboxes, …) updates together.
 */
const SCRIM_BG = "bg-black/50" // colour + opacity
const SCRIM_BLUR = "" // e.g. "backdrop-blur-sm" — off by default
const SCRIM_Z = "z-50" // stacking

/** Visual scrim tokens only (no positioning). Share this with callers that
 *  bring their own positioned element — e.g. Radix's `Dialog.Overlay`, which
 *  must stay a Radix node for presence/animation but should still look identical. */
export const maskClassName = cn(SCRIM_BG, SCRIM_BLUR, SCRIM_Z)

export interface MaskProps extends React.ComponentProps<"div"> {
  /** Cover the nearest positioned ancestor (absolute) instead of the viewport
   *  (fixed). Use when anchoring a mask to a single panel/container. */
  contained?: boolean
}

/**
 * A dim scrim that fills its context. Presentational only — the caller owns
 * open/close, dismiss behaviour, and any click handlers (e.g. stopPropagation).
 */
export function Mask({ contained = false, className, ...props }: MaskProps) {
  return (
    <div
      data-slot="mask"
      className={cn(contained ? "absolute" : "fixed", "inset-0", maskClassName, className)}
      {...props}
    />
  )
}
