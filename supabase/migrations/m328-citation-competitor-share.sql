-- m328: record WHO ELSE the AI named in the same answer.
--
-- The citation monitor already reads an AI answer and decides whether it names
-- US. It threw away the rest of the sentence. So the OS could report a hit rate
-- ("we were cited in 20% of answers") but never the question a broker actually
-- asks: of every brokerage the machine named, how many were me?
--
-- That is share of voice, and it is the number that can move the OPPOSITE way
-- from the hit rate — a broker whose rate doubled while a rival's went up six
-- times is losing, and a dashboard reporting only the rate says "you doubled".
--
-- Captured from the SAME fetched answer text, so it costs no extra provider
-- call: the answer is already in memory when we decide about ourselves.
-- Nullable, because every row written before this column existed genuinely has
-- no competitor evidence — and an empty array would claim we looked and found
-- nobody, which is a different and false statement.
alter table ai_search_citation_observations
  add column if not exists competitors_cited text[];

alter table ai_search_landing_citation_observations
  add column if not exists competitors_cited text[];

comment on column ai_search_citation_observations.competitors_cited is
  'Competitor brokerage names detected in the same AI answer. NULL = not examined (pre-m328 row); empty array = examined, nobody else named.';
comment on column ai_search_landing_citation_observations.competitors_cited is
  'Competitor brokerage names detected in the same AI answer. NULL = not examined (pre-m328 row); empty array = examined, nobody else named.';
