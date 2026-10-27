-- O02 · Le contrôle écrit d'une offre, ligne par ligne : un constat, jamais une note [R14]. Gardé en ajout seul [R17].
CREATE TABLE IF NOT EXISTS offer_checks (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES offer_register (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  -- Les lignes du contrôle, en JSON.
  lines TEXT NOT NULL CHECK (json_valid(lines)),
  checked_by TEXT NOT NULL,
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS offer_checks_offer ON offer_checks (offer_id, checked_at);

CREATE TRIGGER IF NOT EXISTS offer_checks_sans_effacement
BEFORE DELETE ON offer_checks
BEGIN
  SELECT RAISE(ABORT, 'offer_checks : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS offer_checks_fige
BEFORE UPDATE ON offer_checks
BEGIN
  SELECT RAISE(ABORT, 'offer_checks : un contrôle rangé ne change plus');
END;
