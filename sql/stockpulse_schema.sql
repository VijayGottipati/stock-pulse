-- StockPulse core schema for Supabase Postgres
-- Run this in Supabase SQL Editor.

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'po_status') then
    create type po_status as enum ('draft','placed','in_transit','delivered','cancelled');
  end if;

  if not exists (select 1 from pg_type where typname = 'decision_type') then
    create type decision_type as enum ('order','no_action');
  end if;

  if not exists (select 1 from pg_type where typname = 'outcome_type') then
    create type outcome_type as enum ('pass','partial','fail');
  end if;
end $$;

create table if not exists skus (
  id uuid primary key default gen_random_uuid(),
  sku_code text not null unique,
  name text not null,
  category text,
  unit_cost numeric(12,2) default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists suppliers (
  id uuid primary key default gen_random_uuid(),
  supplier_code text not null unique,
  name text not null,
  predicted_lead_days int not null default 7 check (predicted_lead_days >= 0),
  reliability_score numeric(5,2) not null default 1.00 check (reliability_score >= 0 and reliability_score <= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists supplier_skus (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id) on delete cascade,
  sku_id uuid not null references skus(id) on delete cascade,
  unit_price numeric(12,2) not null default 0,
  min_order_qty int not null default 1 check (min_order_qty > 0),
  is_active boolean not null default true,
  unique (supplier_id, sku_id)
);

create table if not exists inventory_levels (
  sku_id uuid primary key references skus(id) on delete cascade,
  current_stock int not null default 0 check (current_stock >= 0),
  incoming_stock int not null default 0 check (incoming_stock >= 0),
  safety_buffer_days int not null default 2 check (safety_buffer_days >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists sales_daily (
  id uuid primary key default gen_random_uuid(),
  sku_id uuid not null references skus(id) on delete cascade,
  sales_date date not null,
  units_sold int not null check (units_sold >= 0),
  created_at timestamptz not null default now(),
  unique (sku_id, sales_date)
);

create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  po_number text not null unique,
  sku_id uuid not null references skus(id),
  supplier_id uuid not null references suppliers(id),
  qty_ordered int not null check (qty_ordered > 0),
  qty_received int not null default 0 check (qty_received >= 0),
  status po_status not null default 'placed',
  ordered_at timestamptz not null default now(),
  predicted_arrival_date date,
  actual_arrival_date date,
  seasonal_buffer_pct numeric(5,2) not null default 0,
  reasoning text not null,
  webhook_fired boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists stockpulse_runs (
  id uuid primary key default gen_random_uuid(),
  run_started_at timestamptz not null default now(),
  run_completed_at timestamptz,
  run_status text not null default 'running',
  notes text
);

create table if not exists stockpulse_decisions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references stockpulse_runs(id) on delete cascade,
  sku_id uuid not null references skus(id),
  velocity_7day numeric(12,2) not null default 0,
  velocity_same_week_last_year numeric(12,2) not null default 0,
  anomaly_ratio numeric(12,2),
  seasonal_detected boolean not null default false,
  days_remaining numeric(12,2),
  lead_time_days int not null default 0,
  safety_buffer_days int not null default 0,
  recommended_qty int not null default 0,
  selected_supplier_id uuid references suppliers(id),
  decision decision_type not null,
  reasoning text not null,
  created_at timestamptz not null default now()
);

create table if not exists delivery_outcomes (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null unique references purchase_orders(id) on delete cascade,
  stockout_days int not null default 0 check (stockout_days >= 0),
  waste_units int not null default 0 check (waste_units >= 0),
  arrival_delta_days int not null default 0,
  outcome outcome_type not null,
  scored_at timestamptz not null default now()
);

create table if not exists seasonal_pattern_logs (
  id uuid primary key default gen_random_uuid(),
  sku_id uuid not null references skus(id) on delete cascade,
  year_num int not null,
  week_num int not null check (week_num between 1 and 53),
  anomaly_ratio numeric(12,2) not null,
  suggested_buffer_pct numeric(5,2) not null,
  note text,
  created_at timestamptz not null default now(),
  unique (sku_id, year_num, week_num)
);

create index if not exists idx_sales_daily_sku_date on sales_daily(sku_id, sales_date);
create index if not exists idx_purchase_orders_status on purchase_orders(status);
create index if not exists idx_purchase_orders_sku on purchase_orders(sku_id);
create index if not exists idx_stockpulse_decisions_run on stockpulse_decisions(run_id);
create index if not exists idx_delivery_outcomes_outcome on delivery_outcomes(outcome);

create or replace view vw_stock_health as
with v7 as (
  select
    sd.sku_id,
    coalesce(sum(sd.units_sold)::numeric / 7.0, 0) as velocity_7day
  from sales_daily sd
  where sd.sales_date >= current_date - interval '7 day'
  group by sd.sku_id
),
vly as (
  select
    sd.sku_id,
    coalesce(sum(sd.units_sold)::numeric / 7.0, 0) as velocity_same_week_last_year
  from sales_daily sd
  where sd.sales_date >= (current_date - interval '52 week' - interval '7 day')
    and sd.sales_date <  (current_date - interval '52 week')
  group by sd.sku_id
),
in_transit as (
  select
    po.sku_id,
    coalesce(sum(po.qty_ordered - po.qty_received), 0) as qty_in_transit
  from purchase_orders po
  where po.status in ('placed','in_transit')
  group by po.sku_id
),
best_supplier as (
  select distinct on (ss.sku_id)
    ss.sku_id,
    ss.supplier_id,
    s.predicted_lead_days,
    s.reliability_score
  from supplier_skus ss
  join suppliers s on s.id = ss.supplier_id
  where ss.is_active = true
  order by ss.sku_id, s.reliability_score desc, s.predicted_lead_days asc
)
select
  sku.id as sku_id,
  sku.sku_code,
  sku.name as sku_name,
  coalesce(inv.current_stock, 0) as current_stock,
  coalesce(inv.incoming_stock, 0) as incoming_stock,
  coalesce(it.qty_in_transit, 0) as po_in_transit_qty,
  coalesce(v7.velocity_7day, 0) as velocity_7day,
  coalesce(vly.velocity_same_week_last_year, 0) as velocity_same_week_last_year,
  case
    when coalesce(v7.velocity_7day, 0) = 0 then null
    else round(coalesce(inv.current_stock, 0)::numeric / v7.velocity_7day, 2)
  end as days_remaining,
  bs.supplier_id as best_supplier_id,
  bs.predicted_lead_days,
  coalesce(inv.safety_buffer_days, 2) as safety_buffer_days,
  case
    when coalesce(vly.velocity_same_week_last_year, 0) = 0 then null
    else round(coalesce(v7.velocity_7day, 0) / nullif(vly.velocity_same_week_last_year, 0), 2)
  end as anomaly_ratio
from skus sku
left join inventory_levels inv on inv.sku_id = sku.id
left join v7 on v7.sku_id = sku.id
left join vly on vly.sku_id = sku.id
left join in_transit it on it.sku_id = sku.id
left join best_supplier bs on bs.sku_id = sku.id
where sku.active = true;

create or replace function fn_stockpulse_candidates()
returns table (
  sku_id uuid,
  sku_code text,
  days_remaining numeric,
  lead_time_days int,
  safety_buffer_days int,
  velocity_7day numeric,
  velocity_same_week_last_year numeric,
  anomaly_ratio numeric,
  seasonal_detected boolean,
  suggested_buffer_pct numeric,
  suggested_qty int,
  best_supplier_id uuid
)
language sql
as $$
select
  v.sku_id,
  v.sku_code,
  v.days_remaining,
  coalesce(v.predicted_lead_days, 7) as lead_time_days,
  coalesce(v.safety_buffer_days, 2) as safety_buffer_days,
  v.velocity_7day,
  v.velocity_same_week_last_year,
  v.anomaly_ratio,
  (coalesce(v.anomaly_ratio, 1) > 1.5) as seasonal_detected,
  case when coalesce(v.anomaly_ratio, 1) > 1.5 then 0.30 else 0.00 end as suggested_buffer_pct,
  greatest(
    0,
    ceil(
      (coalesce(v.velocity_7day,0) * coalesce(v.predicted_lead_days,7))
      + (coalesce(v.velocity_7day,0) * coalesce(v.safety_buffer_days,2))
      + (
          (coalesce(v.velocity_7day,0) * coalesce(v.predicted_lead_days,7))
          * case when coalesce(v.anomaly_ratio,1) > 1.5 then 0.30 else 0 end
        )
      - coalesce(v.current_stock,0)
      - coalesce(v.incoming_stock,0)
      - coalesce(v.po_in_transit_qty,0)
    )::int
  ) as suggested_qty,
  v.best_supplier_id
from vw_stock_health v
where coalesce(v.days_remaining, 999999) < (coalesce(v.predicted_lead_days,7) + coalesce(v.safety_buffer_days,2));
$$;

create or replace function fn_score_delivery(
  p_po_id uuid,
  p_stockout_days int,
  p_waste_units int
) returns outcome_type
language plpgsql
as $$
declare
  v_po purchase_orders%rowtype;
  v_arrival_delta int := 0;
  v_outcome outcome_type;
  v_supplier_id uuid;
begin
  select * into v_po from purchase_orders where id = p_po_id;
  if not found then
    raise exception 'PO not found: %', p_po_id;
  end if;

  if v_po.actual_arrival_date is not null and v_po.predicted_arrival_date is not null then
    v_arrival_delta := (v_po.actual_arrival_date - v_po.predicted_arrival_date);
  end if;

  if p_stockout_days > 0 then
    v_outcome := 'fail';
  elsif p_waste_units > ceil(v_po.qty_ordered * 0.10) then
    v_outcome := 'fail';
  elsif abs(v_arrival_delta) > 1 then
    v_outcome := 'partial';
  else
    v_outcome := 'pass';
  end if;

  insert into delivery_outcomes (po_id, stockout_days, waste_units, arrival_delta_days, outcome)
  values (p_po_id, p_stockout_days, p_waste_units, v_arrival_delta, v_outcome)
  on conflict (po_id) do update
    set stockout_days = excluded.stockout_days,
        waste_units = excluded.waste_units,
        arrival_delta_days = excluded.arrival_delta_days,
        outcome = excluded.outcome,
        scored_at = now();

  v_supplier_id := v_po.supplier_id;

  update suppliers s
  set
    predicted_lead_days = coalesce((
      select round(avg((po.actual_arrival_date - po.ordered_at::date))::numeric)::int
      from purchase_orders po
      where po.supplier_id = s.id
        and po.actual_arrival_date is not null
    ), s.predicted_lead_days),
    reliability_score = coalesce((
      select avg(case when abs((po.actual_arrival_date - po.predicted_arrival_date)) <= 1 then 1 else 0 end)::numeric
      from purchase_orders po
      where po.supplier_id = s.id
        and po.actual_arrival_date is not null
        and po.predicted_arrival_date is not null
    ), s.reliability_score),
    updated_at = now()
  where s.id = v_supplier_id;

  return v_outcome;
end;
$$;

create or replace view vw_po_timeline as
select
  po.id,
  po.po_number,
  s.sku_code,
  sup.name as supplier_name,
  po.qty_ordered,
  po.qty_received,
  po.status,
  po.ordered_at,
  po.predicted_arrival_date,
  po.actual_arrival_date,
  po.seasonal_buffer_pct,
  po.reasoning
from purchase_orders po
join skus s on s.id = po.sku_id
join suppliers sup on sup.id = po.supplier_id;

create or replace view vw_lead_time_accuracy as
select
  sup.id as supplier_id,
  sup.name as supplier_name,
  count(*) filter (where po.actual_arrival_date is not null and po.predicted_arrival_date is not null) as deliveries_scored,
  avg(abs((po.actual_arrival_date - po.predicted_arrival_date)))::numeric(10,2) as avg_abs_arrival_error_days,
  avg(case when abs((po.actual_arrival_date - po.predicted_arrival_date)) <= 1 then 1 else 0 end)::numeric(10,2) as on_time_rate
from suppliers sup
left join purchase_orders po on po.supplier_id = sup.id
group by sup.id, sup.name;

create or replace view vw_stockpulse_kpis as
select
  current_date as as_of_date,
  count(*) filter (where outcome = 'pass') as pass_count,
  count(*) filter (where outcome = 'partial') as partial_count,
  count(*) filter (where outcome = 'fail') as fail_count,
  sum(stockout_days) as total_stockout_days,
  sum(waste_units) as total_waste_units
from delivery_outcomes;
