## Data files

These files drive bulk loading for supermarket-scale catalogs.

- `skus.json` (required): list of products. Minimum field: `sku_code`.
  - `name` is optional. If missing, script uses `Product <sku_code>`.
- `suppliers.json` (optional): supplier list. If missing, defaults are used.
- `supplier_skus.json` (optional): SKU-supplier mapping by code.
  - If empty/missing, all SKUs map to the first supplier.
- `inventory_levels.json` (optional): stock by `sku_code`.
  - If empty/missing, defaults are applied for all SKUs.
- `sales_daily.json` (optional): historical sales rows with
  - `sku_code`, `sales_date` (`YYYY-MM-DD`), `units_sold`
  - If empty/missing, script auto-generates 7 days of seed sales.
