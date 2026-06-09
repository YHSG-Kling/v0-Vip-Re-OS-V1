-- m191: client messages carry a delivery CHANNEL. The deal-critical managers can
-- propose a seller/buyer update over portal, push, email, SMS, or a voice drop —
-- and on approval it delivers via that channel. SMS/voice are TCPA-gated at send.
alter table public.agent_client_messages
  add column if not exists channel text not null default 'portal'
    check (channel in ('portal','portal_push','email','sms','voice_drop'));

comment on column public.agent_client_messages.channel is
  'Delivery channel chosen by the manager; SMS/voice_drop require contact TCPA consent at approval-send.';
