-- Dune label lookup for the attribution pipeline.
--
-- Setup:
--   1. Create a new query at https://dune.com/queries (DuneSQL / Trino engine).
--   2. Add two TEXT parameters: `address` (default 0x0000000000000000000000000000000000000000)
--      and `blockchain` (default ethereum).
--   3. Paste this SQL, save, and note the query id from the URL (.../queries/<ID>).
--   4. Set DUNE_LABEL_QUERY_ID=<ID> and DUNE_API_KEY=<key> in .env.
--
-- Addresses in Dune are varbinary, so we hex-decode the text param to compare.
-- labels.all is Dune's crowdsourced label table (name/category/source per address).

SELECT
    name,
    category,
    source,
    label_type
FROM labels.all
WHERE blockchain = {{blockchain}}
  AND address = from_hex(replace(lower({{address}}), '0x', ''))
ORDER BY created_at DESC
LIMIT 25
