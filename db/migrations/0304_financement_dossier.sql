-- N04 · Suivi du financement déclaré (M10). Les étapes du prêt telles que déclarées par l'acquéreur ou son courtier,
-- dans une liste fermée, sans montant, sans note ni score [R14]. Les alertes de l'agent, une par sorte et par date.
-- En ajout seul [R17].
CREATE TABLE IF NOT EXISTS sale_file_financing (
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  step TEXT NOT NULL CHECK (step IN ('demande_deposee', 'accord_principe', 'offre_pret_emise', 'offre_pret_acceptee', 'refus')),
  day TEXT NOT NULL,
  declared_by TEXT NOT NULL CHECK (declared_by IN ('acquereur', 'courtier')),
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  PRIMARY KEY (file_id, seq)
);
CREATE TABLE IF NOT EXISTS sale_file_financing_alerts (
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sans_offre_de_pret', 'refus_declare')),
  -- La date limite du prêt visée, ou le jour du refus déclaré.
  due_day TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (file_id, kind, due_day, agent_id)
);
CREATE TRIGGER IF NOT EXISTS sale_file_financing_fige BEFORE UPDATE ON sale_file_financing BEGIN SELECT RAISE(ABORT, 'sale_file_financing : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS sale_file_financing_sans_effacement BEFORE DELETE ON sale_file_financing BEGIN SELECT RAISE(ABORT, 'sale_file_financing : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS sale_file_financing_alerts_fige BEFORE UPDATE ON sale_file_financing_alerts BEGIN SELECT RAISE(ABORT, 'sale_file_financing_alerts : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS sale_file_financing_alerts_sans_effacement BEFORE DELETE ON sale_file_financing_alerts BEGIN SELECT RAISE(ABORT, 'sale_file_financing_alerts : rien ne s''efface'); END;
