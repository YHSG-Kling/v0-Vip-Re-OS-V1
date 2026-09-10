export { VideoBusinessPurposePicker, PURPOSE_OPTIONS } from "./video-business-purpose-picker"
export type { VideoPurpose } from "./video-business-purpose-picker"

export { VideoContextPicker } from "./video-context-picker"

// TOMBSTONE: ./repurpose-destinations-card.tsx deleted (wave 52). This whole
// `business-context/` directory is UNREACHABLE — nothing imports it by deep
// path, and the sibling file app/dashboard/videos/components/business-context.tsx
// wins Node/webpack's file-before-directory-index resolution for every
// `from "../components/business-context"` import in the tree, so this
// directory's own RepurposeDestinationsCard (with its listingId/contactId
// gating) never rendered for anyone. That gating is merged onto the survivor,
// business-context.tsx's RepurposeDestinationsCard (see its own header
// comment). The rest of this directory (VideoBusinessPurposePicker,
// VideoContextPicker, ListingVideoModeCard, SellerUpdateVideoModeCard) is
// EQUALLY unreachable by the same resolution — unresolved by this wave's
// scope (only the RepurposeDestinationsCard prop pair was in scope here);
// flagged for the integrator rather than guessed at.

export { ListingVideoModeCard, LISTING_VIDEO_MODES } from "./listing-video-mode-card"
export type { ListingVideoMode } from "./listing-video-mode-card"

export { SellerUpdateVideoModeCard, SELLER_UPDATE_MODES } from "./seller-update-video-mode-card"
export type { SellerUpdateMode } from "./seller-update-video-mode-card"
