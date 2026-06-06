-- Google Business Profile is a real publish target (publishToGoogleBusiness +
-- the google_business OAuth path) and gbp-auto-posts queries social_posts WHERE
-- platform='google_business', but the platform CHECK on both tables omitted it.
ALTER TABLE public.social_posts DROP CONSTRAINT IF EXISTS social_posts_platform_check;
ALTER TABLE public.social_posts ADD CONSTRAINT social_posts_platform_check
  CHECK (platform = ANY (ARRAY['facebook','instagram','linkedin','twitter','tiktok','youtube','pinterest','google_business']));

ALTER TABLE public.social_media_accounts DROP CONSTRAINT IF EXISTS social_media_accounts_platform_check;
ALTER TABLE public.social_media_accounts ADD CONSTRAINT social_media_accounts_platform_check
  CHECK (platform = ANY (ARRAY['facebook','instagram','linkedin','twitter','tiktok','youtube','pinterest','google_business']));
