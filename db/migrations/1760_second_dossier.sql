-- SV14 · Un second dossier sur un bien, après l'arrêt du premier [R233]. Décidé par Shawez (H51, 2026-11-06).
-- `sale_files.property_id` portait UNIQUE, que SQLite ne sait pas retirer : la table est refaite, à l'identique, ligne à
-- ligne. C'est la seule exception à la garde [R17] sur les migrations, écrite dans son test : rien n'est effacé, la
-- recopie est vérifiée complète, colonne par colonne, avant que l'ancienne table ne parte. Si une seule ligne manque ou
-- diffère, la vérification échoue et la migration s'arrête sans rien changer.
-- Les liens des autres tables vers `sale_files` sont vérifiés à la fin de la transaction de la migration.
-- L'unicité devient « un seul dossier ouvert par bien », tenue par un déclencheur dont le message contient UNIQUE.
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

-- La preuve de la recopie, gardée : même nombre de lignes, et aucune ligne d'un côté qui manque de l'autre.
CREATE TABLE IF NOT EXISTS sale_files_recopie (
  done_at TEXT NOT NULL,
  rows_copied INTEGER NOT NULL,
  complete INTEGER NOT NULL CHECK (complete = 1)
);
INSERT INTO sale_files_recopie (done_at, rows_copied, complete)
  SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), (SELECT COUNT(*) FROM sale_files_refaite),
    (SELECT COUNT(*) FROM sale_files) = (SELECT COUNT(*) FROM sale_files_refaite)
    AND NOT EXISTS (
      SELECT id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by FROM sale_files
      EXCEPT SELECT id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by FROM sale_files_refaite)
    AND NOT EXISTS (
      SELECT id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by FROM sale_files_refaite
      EXCEPT SELECT id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by FROM sale_files);
CREATE TRIGGER IF NOT EXISTS sale_files_recopie_fige BEFORE UPDATE ON sale_files_recopie BEGIN SELECT RAISE(ABORT, 'sale_files_recopie : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS sale_files_recopie_sans_effacement BEFORE DELETE ON sale_files_recopie BEGIN SELECT RAISE(ABORT, 'sale_files_recopie : rien ne s''efface'); END;

-- R17-EXCEPTION-H51 : l'ancienne table, recopiée et vérifiée juste au-dessus.
DROP TABLE sale_files;
ALTER TABLE sale_files_refaite RENAME TO sale_files;
CREATE INDEX IF NOT EXISTS sale_files_property ON sale_files (property_id);
CREATE TRIGGER IF NOT EXISTS sale_files_fige BEFORE UPDATE ON sale_files BEGIN SELECT RAISE(ABORT, 'sale_files : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS sale_files_sans_effacement BEFORE DELETE ON sale_files BEGIN SELECT RAISE(ABORT, 'sale_files : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS sale_files_un_seul_ouvert BEFORE INSERT ON sale_files
WHEN EXISTS (SELECT 1 FROM sale_files f WHERE f.property_id = NEW.property_id AND NOT EXISTS (SELECT 1 FROM sale_file_stops s WHERE s.file_id = f.id))
BEGIN SELECT RAISE(ABORT, 'UNIQUE : un seul dossier ouvert par bien'); END;
PRAGMA defer_foreign_keys = OFF;
