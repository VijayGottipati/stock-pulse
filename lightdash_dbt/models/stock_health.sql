select * from {{ source(''stockpulse_raw'', ''vw_stock_health'') }}
