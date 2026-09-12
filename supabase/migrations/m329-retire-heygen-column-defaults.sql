-- m329: two column DEFAULTS still stamped rows with a decommissioned vendor.
--
-- (Applied live under the name m328b_retire_heygen_column_defaults before the
-- migration-filename guard pointed out that mNNN- takes no letter suffix. The
-- file is the numbered record; the applied name is noted here so the two can be
-- reconciled rather than looking like two different migrations.)
--
-- Found by the m328 live test: inserting an ai_video_projects row without an
-- explicit video_provider produced a row recording `heygen`. The CODE has been
-- right for a while — DECOMMISSIONED_PROVIDERS contains heygen, and
-- video-provider-resolver forces 'did' "so the engine can never render via
-- HeyGen" — but Postgres does not read comments. Any writer that omitted the
-- column got a false provenance record for a vendor this OS does not call, and
-- provenance is what the approval queue and the vendor-cost rollups read.
--
-- The owner's stack is Remotion + D-ID + ElevenLabs clones, no HeyGen. So the
-- defaults become the vendors that actually do the work: D-ID renders the
-- avatar video, ElevenLabs trains the voice clone.
--
-- Both tables are empty live, so there is no backfill to do and no row whose
-- history this rewrites.
alter table ai_video_projects  alter column video_provider set default 'did';
alter table voice_clone_training alter column provider     set default 'elevenlabs';

comment on column ai_video_projects.video_provider is
  'Vendor that rendered this video. Defaults to did — heygen is decommissioned (m329).';
comment on column voice_clone_training.provider is
  'Vendor that trained this clone. Defaults to elevenlabs — heygen is decommissioned (m329).';
