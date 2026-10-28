-- K01 · Cycle de la commission (M13) : prévue au compromis, due à l'acte, facturée, payée [R63, R67]. Les montants
-- sont calculés par le code depuis le mandat en vigueur et la grille du réseau, jamais saisis ; en centimes. Rien ne
-- change ni ne s'efface [R17] : la grille se versionne, les étapes s'ajoutent.
CREATE TABLE IF NOT EXISTS commission_grids (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  -- Le premier jour de compromis auquel la grille s'applique, à Paris.
  valid_from TEXT NOT NULL,
  -- La part de l'agent, en points de base des honoraires (7 000 = 70 %).
  default_rate_bp INTEGER NOT NULL CHECK (default_rate_bp BETWEEN 0 AND 10000),
  -- Les taux propres à certains agents, `{"<agent>": <points de base>}`, rangés avec la grille en une seule écriture.
  agent_rates TEXT NOT NULL CHECK (json_valid(agent_rates)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (network_id, version)
);
CREATE TABLE IF NOT EXISTS commissions (
  file_id TEXT PRIMARY KEY REFERENCES sale_files (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  -- L'agent du bien au compromis, à qui la vente revient.
  agent_id TEXT NOT NULL,
  mandate_id TEXT NOT NULL,
  compromis_on TEXT NOT NULL,
  fee_cents INTEGER NOT NULL CHECK (fee_cents >= 0),
  fee_charge TEXT CHECK (fee_charge IS NULL OR fee_charge IN ('vendeur', 'acquereur')),
  grid_id TEXT NOT NULL REFERENCES commission_grids (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS commissions_agent ON commissions (network_id, agent_id);
-- Les parts : réseau, agent, agents qui partagent, parrain ; leur somme est toujours les honoraires.
CREATE TABLE IF NOT EXISTS commission_shares (
  file_id TEXT NOT NULL REFERENCES commissions (file_id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('reseau', 'agent', 'partage', 'parrainage')),
  beneficiary_id TEXT,
  reason TEXT CHECK (reason IS NULL OR reason IN ('fichier_commun', 'binome')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  PRIMARY KEY (file_id, seq),
  CHECK ((kind = 'reseau') = (beneficiary_id IS NULL)),
  CHECK ((kind = 'partage') = (reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS commission_shares_beneficiary ON commission_shares (beneficiary_id);
CREATE TABLE IF NOT EXISTS commission_steps (
  file_id TEXT NOT NULL REFERENCES commissions (file_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('prevue', 'due', 'facturee', 'payee')),
  proof_ref TEXT NOT NULL,
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  PRIMARY KEY (file_id, status)
);
CREATE TRIGGER IF NOT EXISTS commission_grids_fige BEFORE UPDATE ON commission_grids BEGIN SELECT RAISE(ABORT, 'commission_grids : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS commission_grids_garde BEFORE DELETE ON commission_grids BEGIN SELECT RAISE(ABORT, 'commission_grids : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS commissions_fige BEFORE UPDATE ON commissions BEGIN SELECT RAISE(ABORT, 'commissions : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS commissions_garde BEFORE DELETE ON commissions BEGIN SELECT RAISE(ABORT, 'commissions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS commission_shares_fige BEFORE UPDATE ON commission_shares BEGIN SELECT RAISE(ABORT, 'commission_shares : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS commission_shares_garde BEFORE DELETE ON commission_shares BEGIN SELECT RAISE(ABORT, 'commission_shares : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS commission_steps_fige BEFORE UPDATE ON commission_steps BEGIN SELECT RAISE(ABORT, 'commission_steps : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS commission_steps_garde BEFORE DELETE ON commission_steps BEGIN SELECT RAISE(ABORT, 'commission_steps : rien ne s''efface'); END;
-- Les étapes dans l'ordre : chacune exige la précédente [R67].
CREATE TRIGGER IF NOT EXISTS commission_steps_ordre
BEFORE INSERT ON commission_steps
WHEN (NEW.status = 'due' AND NOT EXISTS (SELECT 1 FROM commission_steps WHERE file_id = NEW.file_id AND status = 'prevue'))
  OR (NEW.status = 'facturee' AND NOT EXISTS (SELECT 1 FROM commission_steps WHERE file_id = NEW.file_id AND status = 'due'))
  OR (NEW.status = 'payee' AND NOT EXISTS (SELECT 1 FROM commission_steps WHERE file_id = NEW.file_id AND status = 'facturee'))
BEGIN SELECT RAISE(ABORT, 'commission_steps : étape hors d''ordre'); END;
