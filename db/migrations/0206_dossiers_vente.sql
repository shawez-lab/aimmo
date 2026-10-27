-- O07 · Dossier de vente ouvert par une offre acceptée, que M10 complétera. Un seul dossier ouvert par bien ; les étapes
-- s'ajoutent, rien ne change ni ne s'efface [R17]. Le compromis ne se prépare qu'avec l'identité vérifiée [R58].
CREATE TABLE IF NOT EXISTS sale_files (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL UNIQUE,
  offer_id TEXT NOT NULL UNIQUE REFERENCES offer_register (id) ON DELETE RESTRICT,
  buyer_person_id TEXT NOT NULL,
  -- Le montant convenu : celui de l'offre ou de la dernière proposition acceptée.
  amount_eur INTEGER NOT NULL CHECK (amount_eur > 0),
  opened_at TEXT NOT NULL,
  opened_by TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS sale_file_steps (
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  step TEXT NOT NULL CHECK (step IN ('compromis_en_preparation')),
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  PRIMARY KEY (file_id, step)
);
CREATE TRIGGER IF NOT EXISTS sale_files_fige BEFORE UPDATE ON sale_files BEGIN SELECT RAISE(ABORT, 'sale_files : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS sale_files_sans_effacement BEFORE DELETE ON sale_files BEGIN SELECT RAISE(ABORT, 'sale_files : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS sale_file_steps_fige BEFORE UPDATE ON sale_file_steps BEGIN SELECT RAISE(ABORT, 'sale_file_steps : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS sale_file_steps_sans_effacement BEFORE DELETE ON sale_file_steps BEGIN SELECT RAISE(ABORT, 'sale_file_steps : rien ne s''efface'); END;
