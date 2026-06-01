// Loads .env into process.env if present. Side-effect import: put it FIRST in every
// entrypoint, before modules that read process.env at import time.
// Uses Node's built-in loader (>= 20.12) so we add no dependency. Missing file is fine —
// in CI / GitHub Actions the vars come from secrets, not a .env file.
try {
  process.loadEnvFile(); // defaults to ./.env relative to cwd (repo root)
} catch {
  /* no .env file (e.g. CI) — rely on real environment variables */
}
