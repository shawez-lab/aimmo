-- SV09 · Un dossier de vente peut s'arrêter, et le bien peut en ouvrir un autre [R233].
-- `sale_files.property_id` portait UNIQUE, que SQLite ne sait pas retirer : la table est refaite, à l'identique, ligne à
-- ligne. Les lignes recopiées gardent leurs identifiants : les liens des autres tables restent justes. L'unicité devient « un
-- seul dossier ouvert par bien », tenue par un déclencheur dont le message contient UNIQUE, comme l'erreur d'avant.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE sale_files_refaite (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  offer_id TEXT NOT NULL UNIQUE REFERENCES offer_register (id) ON DELETE RESTRICT,
  buyer_person_id TEXT NOT NULL,
  -- Le montant convenu : celui de l'offre ou de la dernière proposition acceptée.
  amount_eur INTEGER NOT NULL CHECK (amount_eur > 0),
  opened_at TEXT NOT NULL,
  opened_by TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
INSERT INTO sale_files_refaite (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by)
  SELECT id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by FROM sale_files;
DROP TABLE sale_files;
ALTER TABLE sale_files_refaite RENAME TO sale_files;
CREATE INDEX IF NOT EXISTS sale_files_property ON sale_files (property_id);
CREATE TRIGGER IF NOT EXISTS sale_files_fige BEFORE UPDATE ON sale_files BEGIN SELECT RAISE(ABORT, 'sale_files : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS sale_files_sans_effacement BEFORE DELETE ON sale_files BEGIN SELECT RAISE(ABORT, 'sale_files : rien ne s''efface'); END;

-- L'arrêt : une ligne, jamais changée ni effacée [R17], avec sa raison dans une liste fermée et la preuve reçue.
CREATE TABLE IF NOT EXISTS sale_file_stops (
  file_id TEXT PRIMARY KEY REFERENCES sale_files (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason IN ('retractation_acquereur', 'pret_refuse', 'preemption', 'accord_des_parties', 'autre')),
  proof_ref TEXT NOT NULL,
  at TEXT NOT NULL,
  by TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS sale_file_stops_fige BEFORE UPDATE ON sale_file_stops BEGIN SELECT RAISE(ABORT, 'sale_file_stops : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS sale_file_stops_sans_effacement BEFORE DELETE ON sale_file_stops BEGIN SELECT RAISE(ABORT, 'sale_file_stops : rien ne s''efface'); END;

CREATE TRIGGER IF NOT EXISTS sale_files_un_seul_ouvert BEFORE INSERT ON sale_files
WHEN EXISTS (SELECT 1 FROM sale_files f WHERE f.property_id = NEW.property_id AND NOT EXISTS (SELECT 1 FROM sale_file_stops s WHERE s.file_id = f.id))
BEGIN SELECT RAISE(ABORT, 'UNIQUE : un seul dossier ouvert par bien'); END;

-- Un acte signé ne s'arrête pas, un dossier arrêté ne se signe pas, même par deux gestes simultanés.
CREATE TRIGGER IF NOT EXISTS sale_file_stops_pas_apres_acte BEFORE INSERT ON sale_file_stops
WHEN EXISTS (SELECT 1 FROM sale_file_closings c WHERE c.file_id = NEW.file_id)
BEGIN SELECT RAISE(ABORT, 'sale_file_stops : acte déjà signé'); END;
CREATE TRIGGER IF NOT EXISTS sale_file_closings_pas_apres_arret BEFORE INSERT ON sale_file_closings
WHEN EXISTS (SELECT 1 FROM sale_file_stops s WHERE s.file_id = NEW.file_id)
BEGIN SELECT RAISE(ABORT, 'sale_file_closings : dossier arrêté'); END;
PRAGMA defer_foreign_keys = OFF;
