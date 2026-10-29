-- Forms: bookkeeping kept out of every entity, so no API, export or audit trail shows it.

-- The per-workspace key that signs form sessions and quiz result links and keys the IP and
-- address hashes. Created on first use.
create table forms_secret (
  tenant_id uuid primary key references tenant(id) on delete cascade,
  secret bytea not null check (length(secret) = 32),
  created_at timestamptz not null default now()
);

-- "One response per email / per user": the first response claims the key; a concurrent or later
-- one finds it taken. Anonymous forms keep only that a user took part, never which answers were
-- theirs (no response id, no time).
create table forms_claim (
  tenant_id uuid not null,
  form_id uuid not null,
  claim text not null check (length(claim) <= 300),
  primary key (tenant_id, form_id, claim),
  foreign key (tenant_id, form_id) references e_form (tenant_id, id) on delete cascade
);

-- Form views per day (the public definition was fetched), for completion rates.
create table forms_view (
  tenant_id uuid not null,
  form_id uuid not null,
  day date not null,
  views bigint not null default 0 check (views >= 0),
  primary key (tenant_id, form_id, day),
  foreign key (tenant_id, form_id) references e_form (tenant_id, id) on delete cascade
);

-- Autoresponses sent per (form, keyed hash of the address): at most one a day each, so a public
-- form cannot be used to flood someone's mailbox.
create table forms_autoresponse (
  tenant_id uuid not null,
  form_id uuid not null,
  address_hash text not null,
  sent_at timestamptz not null default now(),
  primary key (tenant_id, form_id, address_hash),
  foreign key (tenant_id, form_id) references e_form (tenant_id, id) on delete cascade
);

do $$
declare t text;
begin
  foreach t in array array['forms_secret', 'forms_claim', 'forms_view', 'forms_autoresponse'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system())) '
      'with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))', t);
  end loop;
end $$;

-- Spam purges and the per-form spam cap look responses up by status and age.
create index if not exists forms_response_spam on e_form_response (tenant_id, form, created_at) where status = 'Spam';
