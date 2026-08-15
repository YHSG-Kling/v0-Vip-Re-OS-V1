# Remotion Lambda Deployment (Wave 19 — parked, documented path)

Wave 14's render endpoint is **synchronous** — Vercel function spins up
Chromium, renders one MP4 per invocation, max 300s. Fine for current
volume (~few renders per brokerage per week). Breaks when:

- a brokerage has 50+ listings publish in a day (Just Listed reel queue)
- newsletter video render concurrency > 1 per Vercel instance
- response time matters (renders take 30-90s; the kickoff cron blocks
  during that window)

Remotion Lambda solves all three by running each render in an isolated
AWS Lambda invocation, with unlimited concurrency and per-render billing.

## Why it's parked

Lambda deployment requires:

1. **AWS account** — Remotion Lambda runs in your AWS, not ours/Vercel's
2. **IAM role** — `RemotionLambdaRole` with S3 + Lambda + CloudWatch perms
3. **Region selection** — pick the closest to your Vercel deploy region
4. **`npx remotion lambda functions deploy`** — deploys the renderer
5. **`npx remotion lambda sites create`** — uploads the composition bundle
6. **Env vars** — `REMOTION_AWS_ACCESS_KEY_ID`, `REMOTION_AWS_SECRET_ACCESS_KEY`,
   `AWS_REGION`, `REMOTION_LAMBDA_FUNCTION_NAME`, `REMOTION_LAMBDA_SITE_NAME`

None of these can be set autonomously — they require human decisions on
AWS account ownership + billing.

## Migration path when ready

1. Run the AWS setup above (one-time per env).
2. Replace `lib/video/listing-promo-reactor` and the newsletter render
   endpoint's `renderMedia(...)` call with `renderMediaOnLambda(...)`:

```ts
import { renderMediaOnLambda, getRenderProgress } from "@remotion/lambda"

const { renderId, bucketName } = await renderMediaOnLambda({
  region:           process.env.AWS_REGION!,
  functionName:     process.env.REMOTION_LAMBDA_FUNCTION_NAME!,
  serveUrl:         process.env.REMOTION_LAMBDA_SITE_NAME!,
  composition:      "JustListedReel",
  inputProps,
  codec:            "h264",
})
```

3. Add a `lambda_render_id` column to `listing_promo_videos` +
   `newsletter_video_renders` to track the in-flight render.
4. Replace the synchronous wait with a poller cron that calls
   `getRenderProgress()` and flips status when done.
5. Drop the `includeFiles: @sparticuz/chromium-min` from `vercel.json` —
   Vercel no longer needs Chromium since Lambda renders.

## Cost comparison

| Pattern | Per render | Concurrency |
|---|---|---|
| Vercel sync (current) | ~free (counts against Vercel compute) | 1 per Vercel instance |
| Remotion Lambda | ~$0.02-0.05 per 25s reel | Unlimited |

For a brokerage rendering 100 reels/month, Lambda costs ~$3-5/month vs
Vercel's bundled compute. Worth it once volume justifies.
