## Connect Supabase to Lightdash

### 1) Ensure read-only DB user exists in Supabase

Run this in Supabase SQL Editor (set your own password):

```sql
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'lightdash_reader') then
    create role lightdash_reader login password 'CHANGE_THIS_PASSWORD';
  else
    alter role lightdash_reader with password 'CHANGE_THIS_PASSWORD';
  end if;
end $$;

grant usage on schema public to lightdash_reader;
grant select on all tables in schema public to lightdash_reader;
grant select on all sequences in schema public to lightdash_reader;
alter default privileges in schema public grant select on tables to lightdash_reader;
```

### 2) Push this `lightdash_dbt` folder to GitHub

Lightdash needs a Git-backed dbt project.

### 3) In Lightdash, create a new project

- Connect your Git repo and select `lightdash_dbt` as project path.
- Set warehouse to Postgres.
- Use Supabase Postgres credentials (DB password, not service role key).

Use connection details from Supabase **Connect** page:

- `host`: copy from Supabase (prefer Session Pooler host if direct host fails)
- `port`: `5432` (direct) or `6543` (pooler)
- `database`: `postgres`
- `user`: `lightdash_reader` (or pooler-form username if Supabase requires it)
- `password`: the DB password you set above
- `ssl mode`: `require`
- `schema`: `public`

### 4) Validate tables in Lightdash

After sync, you should see:

- `stock_health`
- `po_timeline`
- `lead_time_accuracy`
- `stockpulse_kpis`

### 5) Build dashboard tiles

- Stock levels: from `stock_health`
- PO timeline: from `po_timeline`
- Lead-time accuracy: from `lead_time_accuracy`
- Outcome counters: from `stockpulse_kpis`
