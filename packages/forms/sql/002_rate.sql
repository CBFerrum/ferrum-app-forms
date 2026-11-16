-- Public responses per form, network address (its keyed hash) and hour: one address sends at most Forms Settings'
-- responses_per_hour to one form. Upkeep deletes past hours.
create table forms_rate (
  tenant_id uuid not null,
  form_id uuid not null,
  ip_hash text not null,
  hour timestamptz not null,
  sent int not null default 0 check (sent >= 0),
  primary key (tenant_id, form_id, ip_hash, hour),
  foreign key (tenant_id, form_id) references e_form (tenant_id, id) on delete cascade
);
alter table forms_rate enable row level security;
alter table forms_rate force row level security;
create policy tenant_isolation on forms_rate
  using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))
  with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()));
