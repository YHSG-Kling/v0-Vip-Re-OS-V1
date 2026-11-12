-- m326: the agent's OWN opening line for the live conversational avatar.
--
-- The widget's speech is driven by chat() through our custom-LLM. speak()
-- bypasses that and makes the avatar say a literal string — and this avatar
-- wears a named real-estate agent's face and voice in front of their client, so
-- the only sentence it may speak that way is one the agent WROTE. This column
-- is that authored source; without it there is nothing legitimate to speak, and
-- a hardcoded default would be words the human never approved.
alter table agent_avatar_assets
  add column if not exists greeting text,
  add column if not exists greeting_sentiment text;

-- The sentiment vocabulary is CLOSED because D-ID's own behaviour makes a typo
-- invisible: "If the requested sentiment is not supported by the agent, the
-- default sentiment is used." A silently-ignored value would leave the avatar
-- sounding ordinary with nothing reporting why.
alter table agent_avatar_assets
  drop constraint if exists agent_avatar_assets_greeting_sentiment_check;
alter table agent_avatar_assets
  add constraint agent_avatar_assets_greeting_sentiment_check
  check (greeting_sentiment is null or greeting_sentiment in
    ('friendly','excited','professional','empathetic','frustrated'));

-- A greeting is a spoken sentence, not an essay: keep it to something an avatar
-- can deliver before the contact loses interest.
alter table agent_avatar_assets
  drop constraint if exists agent_avatar_assets_greeting_len_check;
alter table agent_avatar_assets
  add constraint agent_avatar_assets_greeting_len_check
  check (greeting is null or char_length(greeting) <= 300);
