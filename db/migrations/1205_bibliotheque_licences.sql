-- X07 · Bibliothèque de musiques et d'images sous licence (M19) [R133]. Chaque entrée avec sa source, sa licence,
-- sa date de fin (ou aucune pour une licence sans fin) et la preuve rangée par la direction, par sa référence de
-- stockage. Un retrait s'ajoute ; rien ne s'efface ni ne se réécrit [R17].
CREATE TABLE IF NOT EXISTS licensed_assets (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('musique', 'image')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  source TEXT NOT NULL CHECK (source IN ('banque_sous_licence', 'achat_unitaire', 'creation_commandee', 'domaine_public')),
  licence TEXT NOT NULL CHECK (licence IN ('cc0', 'cc_by', 'licence_achetee', 'abonnement', 'cession_de_droits')),
  attribution TEXT CHECK (attribution IS NULL OR length(attribution) BETWEEN 2 AND 200),
  valid_until TEXT CHECK (valid_until IS NULL OR valid_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  proof_ref TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS licensed_assets_network ON licensed_assets (network_id, kind);
CREATE TRIGGER IF NOT EXISTS licensed_assets_garde BEFORE DELETE ON licensed_assets BEGIN SELECT RAISE(ABORT, 'licensed_assets : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS licensed_assets_fige BEFORE UPDATE ON licensed_assets BEGIN SELECT RAISE(ABORT, 'licensed_assets : une entrée ne change plus'); END;

CREATE TABLE IF NOT EXISTS licensed_asset_withdrawals (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL UNIQUE REFERENCES licensed_assets (id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason IN ('licence_retiree', 'preuve_invalide', 'choix_de_la_direction')),
  withdrawn_by TEXT NOT NULL,
  withdrawn_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS licensed_asset_withdrawals_garde BEFORE DELETE ON licensed_asset_withdrawals BEGIN SELECT RAISE(ABORT, 'licensed_asset_withdrawals : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS licensed_asset_withdrawals_fige BEFORE UPDATE ON licensed_asset_withdrawals BEGIN SELECT RAISE(ABORT, 'licensed_asset_withdrawals : un retrait ne change plus'); END;
