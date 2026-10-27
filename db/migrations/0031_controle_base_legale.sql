-- G05 · Contrôle de la base légale sur 30 jours : chaque passage relit les plans du jour figés des 30 derniers jours
-- et range son rapport, sans donnée personnelle [R13]. Un rapport avec un écart est une alerte pour la direction.
-- Rien ne s'efface, rien ne change [R17].
CREATE TABLE IF NOT EXISTS legal_basis_checks (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  ran_at TEXT NOT NULL,
  from_day TEXT NOT NULL,
  to_day TEXT NOT NULL,
  plans INTEGER NOT NULL CHECK (plans >= 0),
  items INTEGER NOT NULL CHECK (items >= 0),
  gaps INTEGER NOT NULL CHECK (gaps >= 0),
  -- Les écarts par raison et par jour, comptés : jamais une fiche, un nom ni une coordonnée.
  report TEXT NOT NULL,
  seen_at TEXT
);
CREATE INDEX IF NOT EXISTS legal_basis_checks_network ON legal_basis_checks (network_id, ran_at);

CREATE TRIGGER IF NOT EXISTS legal_basis_checks_sans_effacement
BEFORE DELETE ON legal_basis_checks
BEGIN
  SELECT RAISE(ABORT, 'legal_basis_checks : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS legal_basis_checks_fige
BEFORE UPDATE OF id, network_id, ran_at, from_day, to_day, plans, items, gaps, report ON legal_basis_checks
BEGIN
  SELECT RAISE(ABORT, 'legal_basis_checks : un rapport ne change plus');
END;
