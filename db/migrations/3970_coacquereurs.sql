-- AU009 · Coacquéreurs. Une offre porte, en plus de son acquéreur, ses coacquéreurs : chacun sa fiche, jamais fusionnée.
-- L'empreinte de l'offre les couvre dès qu'il y en a un ; une offre d'avant garde la sienne [R56].
ALTER TABLE offer_register ADD COLUMN co_buyers TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(co_buyers) AND json_type(co_buyers) = 'array');

-- La première présentation de la notification à chaque coacquéreur : sa date, sa preuve, ses versions. Celle de
-- l'acquéreur en tête reste dans `sale_file_dates`. En ajout seul [R17].
CREATE TABLE IF NOT EXISTS sale_file_buyer_notices (
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  day TEXT NOT NULL CHECK (length(day) = 10),
  proof_ref TEXT NOT NULL,
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  PRIMARY KEY (file_id, person_id, version)
);
CREATE TRIGGER IF NOT EXISTS sale_file_buyer_notices_fige BEFORE UPDATE ON sale_file_buyer_notices BEGIN SELECT RAISE(ABORT, 'sale_file_buyer_notices : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS sale_file_buyer_notices_sans_effacement BEFORE DELETE ON sale_file_buyer_notices BEGIN SELECT RAISE(ABORT, 'sale_file_buyer_notices : rien ne s''efface'); END;
