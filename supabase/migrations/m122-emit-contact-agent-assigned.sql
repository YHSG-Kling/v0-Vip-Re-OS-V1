-- m122 — emit CONTACT_AGENT_ASSIGNED at the DB layer.
-- contacts.agent_id is written from ~6 different code paths. A column-level
-- trigger catches every path, including future ones.

create or replace function public.emit_contact_agent_assigned()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (TG_OP = 'INSERT' and NEW.agent_id is not null) or
     (TG_OP = 'UPDATE' and NEW.agent_id is distinct from OLD.agent_id and NEW.agent_id is not null)
  then
    insert into public.lifecycle_events (
      brokerage_id, event_type, metadata,
      entity_id, entity_type, source, processed
    ) values (
      NEW.brokerage_id,
      'contact_agent_assigned',
      jsonb_build_object(
        'contact_id', NEW.id,
        'agent_id',   NEW.agent_id,
        'previous_agent_id', case when TG_OP = 'UPDATE' then OLD.agent_id else null end
      ),
      NEW.id,
      'contact',
      'system',
      false
    );
  end if;
  return NEW;
end $$;

drop trigger if exists trg_contacts_emit_agent_assigned on public.contacts;

create trigger trg_contacts_emit_agent_assigned
  after insert or update of agent_id on public.contacts
  for each row execute function public.emit_contact_agent_assigned();

comment on function public.emit_contact_agent_assigned is
  'm122 — auto-emit CONTACT_AGENT_ASSIGNED on contacts.agent_id (NULL→set or change). Triggers the intro-video reactor in lib/kernel/event-reactor.ts.';
