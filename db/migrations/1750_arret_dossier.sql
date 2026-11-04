-- SV09 · Un dossier de vente peut s'arrêter [R233]. Rien n'est refait ni effacé : `sale_files.property_id` reste UNIQUE,
-- donc un bien n'a qu'un dossier ; rouvrir après un arrêt attend la décision H51.
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

-- Un acte signé ne s'arrête pas, un dossier arrêté ne se signe pas, même par deux gestes simultanés.
CREATE TRIGGER IF NOT EXISTS sale_file_stops_pas_apres_acte BEFORE INSERT ON sale_file_stops
WHEN EXISTS (SELECT 1 FROM sale_file_closings c WHERE c.file_id = NEW.file_id)
BEGIN SELECT RAISE(ABORT, 'sale_file_stops : acte déjà signé'); END;
CREATE TRIGGER IF NOT EXISTS sale_file_closings_pas_apres_arret BEFORE INSERT ON sale_file_closings
WHEN EXISTS (SELECT 1 FROM sale_file_stops s WHERE s.file_id = NEW.file_id)
BEGIN SELECT RAISE(ABORT, 'sale_file_closings : dossier arrêté'); END;
