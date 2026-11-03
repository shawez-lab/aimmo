-- RS05 · Les mentions légales du site, réglées par la direction [R221, R17] : en ajout seul, la dernière de chaque champ vaut.
CREATE TABLE IF NOT EXISTS site_legal_mentions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS site_legal_mentions_field ON site_legal_mentions (network_id, field, set_at);
