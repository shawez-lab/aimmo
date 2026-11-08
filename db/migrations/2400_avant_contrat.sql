-- HX45 · Avant-contrat préparé, et projet du notaire comparé à l'offre. Tables nouvelles, en ajout seul : rien ne
-- s'efface ni ne se réécrit [R17]. AIMMO ne rédige pas l'avant-contrat : l'agent du bien prépare pour le notaire la
-- note des conditions convenues (prix du dossier, conditions de l'offre acceptée) [R510] ; il range le projet reçu du
-- notaire avec ce qu'il y lit, page par page, et le code en tire chaque différence [R511] ; le dépôt de garantie est
-- suivi comme reçu par le notaire, jamais par AIMMO [R512].
CREATE TABLE IF NOT EXISTS pre_contract_briefs (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  -- Les conditions convenues, en chiffres et en sortes de listes fermées : aucun nom, aucune coordonnée.
  terms TEXT NOT NULL CHECK (json_valid(terms)),
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  prepared_by TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  UNIQUE (file_id, version)
);
CREATE TABLE IF NOT EXISTS notary_drafts (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  -- Le projet du notaire, rangé au stockage des pièces : une référence, jamais son contenu.
  document_ref TEXT NOT NULL CHECK (length(document_ref) BETWEEN 10 AND 300),
  -- Ce que l'agent lit dans le projet, chaque terme avec sa page.
  terms TEXT NOT NULL CHECK (json_valid(terms)),
  -- La note à laquelle le projet est comparé.
  brief_id TEXT NOT NULL REFERENCES pre_contract_briefs (id) ON DELETE RESTRICT,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (file_id, version)
);
-- Chaque différence signalée, une ligne, rangée une fois avec son projet [R511].
CREATE TABLE IF NOT EXISTS notary_draft_differences (
  draft_id TEXT NOT NULL REFERENCES notary_drafts (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  field TEXT NOT NULL CHECK (length(field) BETWEEN 1 AND 60),
  expected TEXT,
  found TEXT,
  page INTEGER CHECK (page IS NULL OR page BETWEEN 1 AND 999),
  blocking INTEGER NOT NULL CHECK (blocking IN (0, 1)),
  PRIMARY KEY (draft_id, seq)
);
-- Le dépôt de garantie : reçu par le notaire, et par personne d'autre ; la base le garde [R512].
CREATE TABLE IF NOT EXISTS pre_contract_deposits (
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  amount_eur INTEGER NOT NULL CHECK (amount_eur > 0),
  received_by TEXT NOT NULL CHECK (received_by = 'notaire'),
  received_on TEXT NOT NULL CHECK (length(received_on) = 10),
  -- L'attestation du notaire, rangée au stockage des pièces.
  proof_ref TEXT NOT NULL CHECK (length(proof_ref) BETWEEN 10 AND 300),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (file_id, version)
);
CREATE TRIGGER IF NOT EXISTS pre_contract_briefs_garde BEFORE DELETE ON pre_contract_briefs BEGIN SELECT RAISE(ABORT, 'pre_contract_briefs : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS pre_contract_briefs_fige BEFORE UPDATE ON pre_contract_briefs BEGIN SELECT RAISE(ABORT, 'pre_contract_briefs : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS notary_drafts_garde BEFORE DELETE ON notary_drafts BEGIN SELECT RAISE(ABORT, 'notary_drafts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS notary_drafts_fige BEFORE UPDATE ON notary_drafts BEGIN SELECT RAISE(ABORT, 'notary_drafts : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS notary_draft_differences_garde BEFORE DELETE ON notary_draft_differences BEGIN SELECT RAISE(ABORT, 'notary_draft_differences : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS notary_draft_differences_fige BEFORE UPDATE ON notary_draft_differences BEGIN SELECT RAISE(ABORT, 'notary_draft_differences : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS pre_contract_deposits_garde BEFORE DELETE ON pre_contract_deposits BEGIN SELECT RAISE(ABORT, 'pre_contract_deposits : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS pre_contract_deposits_fige BEFORE UPDATE ON pre_contract_deposits BEGIN SELECT RAISE(ABORT, 'pre_contract_deposits : rien ne se réécrit'); END;
