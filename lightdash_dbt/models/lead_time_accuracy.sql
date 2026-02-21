select * from {{ source(''stockpulse_raw'', ''vw_lead_time_accuracy'') }}
