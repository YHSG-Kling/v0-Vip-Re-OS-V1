/**
 * remotion/index.ts
 *
 * Entry point Remotion's bundler reads. Calls registerRoot with the
 * composition registry from Root.tsx.
 */
import { registerRoot } from "remotion"
import { RemotionRoot } from "./Root"

registerRoot(RemotionRoot)
