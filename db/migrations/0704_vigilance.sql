-- L04 · Vigilance renforcée et origine des fonds [R10, R14, R17, R93].

-- Les seuils réglés par le responsable de la conformité, en ajout seul : le dernier réglage compte, les alertes déjà
-- levées gardent le leur. Sans réglage, la grille d'essai du code s'applique.
CREATE TABLE IF NOT EXISTS vigilance_settings (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  -- Écart toléré autour de la fourchette d'estimation, en pour cent entier.
  price_gap_percent INTEGER NOT NULL CHECK (price_gap_percent BETWEEN 1 AND 100),
  -- Montant à partir duquel une offre ou un mandat est inhabituel, en euros.
  amount_threshold_eur INTEGER NOT NULL CHECK (amount_threshold_eur > 0),
  validator_name TEXT NOT NULL CHECK (length(trim(validator_name)) > 0),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  UNIQUE (network_id, version)
);

-- Une alerte par règle, par dossier et par jeu de chiffres : les mêmes données donnent la même empreinte, donc la même
-- alerte, jamais un doublon. Les chiffres lus dans la base sont gardés tels quels, en JSON.
CREATE TABLE IF NOT EXISTS vigilance_alerts (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  case_ref TEXT NOT NULL,
  person_id TEXT NOT NULL,
  rule_key TEXT NOT NULL CHECK (rule_key IN ('prix_ecarte_valeur', 'montant_inhabituel', 'personne_politiquement_exposee', 'paiement_comptant')),
  settings_version TEXT NOT NULL,
  figures TEXT NOT NULL CHECK (json_valid(figures)),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  raised_by TEXT NOT NULL,
  raised_at TEXT NOT NULL,
  UNIQUE (network_id, fingerprint),
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS vigilance_alerts_case ON vigilance_alerts (network_id, case_ref, raised_at);

-- La décision du responsable, une seule par alerte, avec son nom et sa date.
CREATE TABLE IF NOT EXISTS vigilance_decisions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  alert_id TEXT NOT NULL UNIQUE REFERENCES vigilance_alerts (id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('classee', 'origine_des_fonds_demandee', 'vigilance_maintenue')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  validator_name TEXT NOT NULL CHECK (length(trim(validator_name)) > 0),
  decided_by TEXT NOT NULL,
  decided_on TEXT NOT NULL CHECK (length(decided_on) = 10),
  at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS vigilance_settings_sans_changement BEFORE UPDATE ON vigilance_settings BEGIN SELECT RAISE(ABORT, 'réglage gardé'); END;
CREATE TRIGGER IF NOT EXISTS vigilance_settings_sans_effacement BEFORE DELETE ON vigilance_settings BEGIN SELECT RAISE(ABORT, 'réglage gardé'); END;
CREATE TRIGGER IF NOT EXISTS vigilance_alerts_sans_changement BEFORE UPDATE ON vigilance_alerts BEGIN SELECT RAISE(ABORT, 'alerte gardée'); END;
CREATE TRIGGER IF NOT EXISTS vigilance_alerts_sans_effacement BEFORE DELETE ON vigilance_alerts BEGIN SELECT RAISE(ABORT, 'alerte gardée'); END;
CREATE TRIGGER IF NOT EXISTS vigilance_decisions_sans_changement BEFORE UPDATE ON vigilance_decisions BEGIN SELECT RAISE(ABORT, 'décision gardée'); END;
CREATE TRIGGER IF NOT EXISTS vigilance_decisions_sans_effacement BEFORE DELETE ON vigilance_decisions BEGIN SELECT RAISE(ABORT, 'décision gardée'); END;
