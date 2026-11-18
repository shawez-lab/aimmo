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

-- La garde du bon de la visite à distance (RC25), pour chaque coacquéreur comme pour l'acquéreur en tête : écrite dans
-- le même lot que l'offre, la ligne du coacquéreur refuse l'offre entière tant que son bon n'est pas signé [R505].
CREATE TRIGGER IF NOT EXISTS offer_co_buyers_bon_distance_signe
BEFORE INSERT ON offer_co_buyers
WHEN EXISTS (
  SELECT 1 FROM remote_visits rv
   WHERE rv.property_id = (SELECT o.property_id FROM offer_register o WHERE o.id = NEW.offer_id)
     AND NOT EXISTS (SELECT 1 FROM remote_slip_signatures s WHERE s.appointment_id = rv.appointment_id AND s.status = 'signee')
     AND EXISTS (
       WITH RECURSIVE
         acheteur(id) AS (SELECT NEW.person_id UNION SELECT pm.survivor_id FROM person_merges pm JOIN acheteur ON pm.merged_id = acheteur.id WHERE pm.undone_at IS NULL),
         visiteur(id) AS (SELECT rv.person_id UNION SELECT pm.survivor_id FROM person_merges pm JOIN visiteur ON pm.merged_id = visiteur.id WHERE pm.undone_at IS NULL)
       SELECT 1 FROM acheteur JOIN visiteur ON acheteur.id = visiteur.id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'offre refusée : bon de la visite à distance non signé');
END;
