-- AU009 · Coacquéreurs. Une offre porte, en plus de son acquéreur, ses coacquéreurs : chacun sa fiche, jamais fusionnée.
-- L'empreinte de l'offre les couvre dès qu'il y en a un ; une offre d'avant garde la sienne [R56].
ALTER TABLE offer_register ADD COLUMN co_buyers TEXT NOT NULL DEFAULT '[]';

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

-- Le lien de chaque coacquéreur à son offre, écrit avec l'offre dans le même lot : sa fiche y est trouvée quand il
-- demande ses données (R96). En ajout seul.
CREATE TABLE IF NOT EXISTS offer_co_buyers (
  offer_id TEXT NOT NULL REFERENCES offer_register (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 1),
  PRIMARY KEY (offer_id, person_id),
  UNIQUE (offer_id, position),
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS offer_co_buyers_person ON offer_co_buyers (network_id, person_id);
CREATE TRIGGER IF NOT EXISTS offer_co_buyers_fige BEFORE UPDATE ON offer_co_buyers BEGIN SELECT RAISE(ABORT, 'offer_co_buyers : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS offer_co_buyers_sans_effacement BEFORE DELETE ON offer_co_buyers BEGIN SELECT RAISE(ABORT, 'offer_co_buyers : rien ne s''efface'); END;
