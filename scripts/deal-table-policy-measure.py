#!/usr/bin/env python3
"""Measure the two LIVE row-security policies of the five deal tables, and the PROPOSED ones (the ALTER POLICY block of
docs/operations/OWNER-SQL.md section R.6, applied unchanged), on a LOCAL PostgreSQL — 16 seats x 8 operations x 5 tables.

It never touches the live database: the live policy and helper-function text is embedded verbatim (pg_policies / pg_proc,
read 2026-11-20). Its output is the PG_MEASURED table in scripts/deal-desk-guard.ts (test:deal-desk, section F), which pins
the fingerprint of the measured block — edit the SQL, run this again, paste the table and the fingerprint.

Needs a throwaway PostgreSQL listening on 127.0.0.1:54329 with a trusted `postgres` superuser, for example:
    initdb -D /var/tmp/pgdesk/data -A trust -U postgres
    pg_ctl -D /var/tmp/pgdesk/data -o "-p 54329 -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" -w start
Usage: python3 scripts/deal-table-policy-measure.py <repo root> <out.json>
Blind spot: public.transactions and public.agents carry NO row security here (the policies' subqueries read them as the
caller); live they have their own policies, which can only refuse more."""
import json, re, subprocess, sys
ROOT, OUT = sys.argv[1], sys.argv[2]
PSQL = ["psql", "-h", "127.0.0.1", "-p", "54329", "-U", "postgres", "-X", "-At", "-v", "VERBOSITY=verbose"]
def psql(db, sql, check=True):
    r = subprocess.run(PSQL + ["-d", db, "-f", "-"], input=sql, capture_output=True, text=True)
    if check and r.returncode != 0: raise SystemExit(r.stderr[-2000:])
    return r.stdout + r.stderr
TABLES = ["transaction_participants", "transaction_deadlines", "transaction_title_escrow", "transaction_repair_negotiations", "transaction_timeline"]
u = lambda p, n: f"{p}{n:07d}-0000-4000-8000-000000000155"
B1, B2 = u("b", 1), u("b", 2)
SEATS = [  # name, user id, tenant, user_type, role
    ("broker", u("a", 1), B1, "broker"), ("broker_owner", u("a", 13), B1, "broker_owner"), ("broker_admin", u("a", 14), B1, "broker_admin"),
    ("admin", u("a", 15), B1, "admin"), ("compliance_officer", u("a", 3), B1, "compliance_officer"), ("tc", u("a", 2), B1, "tc"),
    ("agent_on_deal", u("a", 4), B1, "agent"), ("buyer_side_agent", u("a", 6), B1, "agent"), ("team_lead_not_on_deal", u("a", 7), B1, "team_lead"),
    ("agent_off_deal", u("a", 5), B1, "agent"), ("vendor", u("a", 9), B1, "vendor"), ("contact", u("a", 10), B1, "contact"), ("isa", u("a", 11), B1, "isa"),
    ("no_user_type", u("a", 12), B1, None), ("other_tenant_broker", u("a", 20), B2, "broker"), ("anon", None, None, None),
]
AG_A, AG_BUY, AG_OFF, AG_LEAD, AG_X = u("e", 4), u("e", 6), u("e", 5), u("e", 7), u("e", 20)
TX1, TX_X = u("d", 1), u("d", 9)
R1, RNULL, RX = u("c", 1), u("c", 2), u("c", 3)
q = lambda v: "null" if v is None else f"'{v}'"
# ── the LIVE text, verbatim from pg_policies / pg_proc (project hrvaqgvukzxfskkcrwbt, read 2026-11-20) ──
AGENT_USING = "(transaction_id IN ( SELECT transactions.id FROM transactions WHERE ((transactions.agent_id IN ( SELECT agents.id FROM agents WHERE (agents.user_id = auth.uid()))) OR (transactions.buyer_agent_id IN ( SELECT agents.id FROM agents WHERE (agents.user_id = auth.uid()))) OR (transactions.seller_agent_id IN ( SELECT agents.id FROM agents WHERE (agents.user_id = auth.uid()))))))"
AGENT_CHECK = "(brokerage_id = current_user_brokerage_id())"
BROKER = "((brokerage_id = current_user_brokerage_id()) AND (current_user_type() = ANY (ARRAY['broker'::text, 'admin'::text, 'super_admin'::text, 'tc'::text])))"
def build():
    s = ["create schema auth;", "create role anon nologin;", "create role authenticated nologin;",
         "create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;",
         "create table public.brokerages (id uuid primary key);",
         "create table public.users (id uuid primary key, brokerage_id uuid references public.brokerages(id), user_type text);",
         "create table public.agents (id uuid primary key, user_id uuid, brokerage_id uuid);",
         "create table public.transactions (id uuid primary key, brokerage_id uuid, agent_id uuid, buyer_agent_id uuid, seller_agent_id uuid);",
         "create function public.current_user_brokerage_id() returns uuid language sql stable security definer as $$ SELECT brokerage_id FROM public.users WHERE id = auth.uid() LIMIT 1; $$;",
         "create function public.current_user_type() returns text language sql stable security definer as $$ SELECT user_type FROM public.users WHERE id = auth.uid() LIMIT 1; $$;",
         # the outcome of ONE statement as text, run as the CALLER (security invoker): 'rows n' or 'err <sqlstate>'
         "create function public.try_case(stmt text) returns text language plpgsql as $f$ declare n bigint; begin execute stmt; get diagnostics n = row_count; return 'rows ' || n; exception when others then return 'err ' || sqlstate; end $f$;",
         "create function public.try_count(stmt text) returns text language plpgsql as $f$ declare n bigint; begin execute stmt into n; return 'rows ' || n; exception when others then return 'err ' || sqlstate; end $f$;",
         f"insert into public.brokerages values ('{B1}'), ('{B2}');"]
    for name, uid, tenant, typ in SEATS:
        if uid: s.append(f"insert into public.users values ('{uid}', '{tenant}', {q(typ)});")
    s.append(f"insert into public.users values ('{u('a', 21)}', '{B2}', 'agent');")
    s.append(f"insert into public.agents values ('{AG_A}', '{u('a', 4)}', '{B1}'), ('{AG_BUY}', '{u('a', 6)}', '{B1}'), ('{AG_OFF}', '{u('a', 5)}', '{B1}'), ('{AG_LEAD}', '{u('a', 7)}', '{B1}'), ('{AG_X}', '{u('a', 21)}', '{B2}');")
    s.append(f"insert into public.transactions values ('{TX1}', '{B1}', '{AG_A}', '{AG_BUY}', null), ('{TX_X}', '{B2}', '{AG_X}', null, null);")
    for t in TABLES:
        s += [f"create table public.{t} (id uuid primary key default gen_random_uuid(), transaction_id uuid not null references public.transactions(id), brokerage_id uuid references public.brokerages(id), note text);",
              f"insert into public.{t} (id, transaction_id, brokerage_id) values ('{R1}', '{TX1}', '{B1}'), ('{RNULL}', '{TX1}', null), ('{RX}', '{TX_X}', '{B2}');",
              f"alter table public.{t} enable row level security;",
              f"create policy trx_agent_{t} on public.{t} for all to public using {AGENT_USING} with check {AGENT_CHECK};",
              f"create policy trx_broker_{t} on public.{t} for all to public using {BROKER} with check {BROKER};"]
    s += ["grant usage on schema public, auth to anon, authenticated;", "grant all on all tables in schema public to anon, authenticated;",
          "grant execute on all functions in schema public to anon, authenticated;", "grant execute on all functions in schema auth to anon, authenticated;"]
    return "\n".join(s)
CASES = [  # name, statement template ({t} table, {ten} the seat's tenant literal)
    ("insert_b1_deal", "insert into public.{t} (transaction_id, brokerage_id) values ('" + TX1 + "', {ten})"),
    ("insert_b1_deal_returning", "insert into public.{t} (transaction_id, brokerage_id) values ('" + TX1 + "', {ten}) returning id"),
    ("insert_b1_deal_no_tenant", "insert into public.{t} (transaction_id, brokerage_id) values ('" + TX1 + "', null)"),
    ("insert_b2_deal", "insert into public.{t} (transaction_id, brokerage_id) values ('" + TX_X + "', {ten})"),
    ("update_row", "update public.{t} set note = 'u' where id = '" + R1 + "'"),
    ("update_never_stamped_row", "update public.{t} set note = 'u' where id = '" + RNULL + "'"),
    ("delete_row", "delete from public.{t} where id = '" + R1 + "'"),
    ("rows_visible_on_b1_deal", "select count(*) from public.{t} where transaction_id = '" + TX1 + "'"),
]
def measure(db):
    sql, order = [], []
    for t in TABLES:
        for name, uid, tenant, typ in SEATS:
            for case, tpl in CASES:
                order.append((t, name, case))
                sql += [f"\\echo CASE {t}|{name}|{case}", "begin;", f"set local role {'authenticated' if uid else 'anon'};",
                        f"select set_config('request.jwt.claim.sub', '{uid or ''}', true) \\g /dev/null",
                        f"select 'RESULT ' || public.{'try_count' if case == 'rows_visible_on_b1_deal' else 'try_case'}($q${tpl.format(t=t, ten=q(tenant))}$q$);", "rollback;"]
    out = psql(db, "\n".join(sql), check=False)
    res, cur = {}, None
    for line in out.split("\n"):
        m = re.match(r"CASE (.+)$", line)
        if m: cur = m.group(1); continue
        if cur is None or cur in res: continue
        m = re.match(r"RESULT (rows|err) (\w+)$", line)
        if m: res[cur] = m.group(2) if m.group(1) == "err" else m.group(2)
    missing = [f"{t}|{n}|{c}" for t, n, c in order if f"{t}|{n}|{c}" not in res]
    if missing: raise SystemExit(f"unparsed cases: {missing[:5]} … of {len(missing)}\n{out[-1500:]}")
    per = {t: {n: [res[f"{t}|{n}|{c}"] for c, _ in CASES] for n, *_ in SEATS} for t in TABLES}
    same = all(per[t] == per[TABLES[0]] for t in TABLES)
    return per[TABLES[0]], same
def proposed_sql():
    doc = open(ROOT + "/docs/operations/OWNER-SQL.md").read()
    sec = doc[doc.index("### R.6 "):]
    block = sec[sec.index("```sql") + 6: sec.index("```", sec.index("```sql") + 6)]
    do = block[block.index("begin;"): block.index("commit;") + len("commit;")]
    return do
psql("postgres", "drop database if exists deskpol; drop role if exists anon; drop role if exists authenticated; create database deskpol;")
psql("deskpol", build())
live, live_same = measure("deskpol")
prop = proposed_sql()
applied = psql("deskpol", "\\set ON_ERROR_STOP on\n" + prop)
proposed, prop_same = measure("deskpol")
ver = psql("deskpol", "select version();").strip().split(" on ")[0]
import hashlib
sha = hashlib.sha256(re.sub(r"\s+", " ", prop).strip().encode()).hexdigest()
json.dump({"engine": ver, "proposed_sql_sha256": sha, "tables": TABLES, "all_five_tables_identical": {"live": live_same, "proposed": prop_same}, "cases": [c for c, _ in CASES],
           "seats": [n for n, *_ in SEATS], "live": live, "proposed": proposed, "proposed_statements": prop.count("alter policy")}, open(OUT, "w"), indent=1)
print(ver, "| five tables identical:", live_same, prop_same, "| alter policy statements applied:", prop.count("alter policy"))
