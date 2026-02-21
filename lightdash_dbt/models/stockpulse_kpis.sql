select * from {{ source(''stockpulse_raw'', ''vw_stockpulse_kpis'') }}
