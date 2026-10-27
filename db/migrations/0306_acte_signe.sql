-- N06 · Acte signé (M10) : la vente close, une fois par dossier, avec la preuve du notaire ; la commission due au
-- montant du mandat en vigueur au compromis, jamais saisi [R63] ; l'après-vente à démarrer (M11). En ajout seul [R17].
CREATE TABLE IF NOT EXISTS sale_file_closings (
  file_id TEXT PRIMARY KEY REFERENCES sale_files (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  -- Le jour de l'acte, à Paris, et la référence de l'attestation du notaire.
  signed_on TEXT NOT NULL,
  proof_ref TEXT NOT NULL,
  -- L'après-vente que M11 démarrera.
  aftersale TEXT NOT NULL CHECK (aftersale IN ('a_demarrer')),
  at TEXT NOT NULL,
  by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sale_commissions (
  file_id TEXT PRIMARY KEY REFERENCES sale_files (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  mandate_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  -- Les honoraires du mandat signé, en euros, et qui les paie, tels qu'au document signé.
  fee_eur INTEGER NOT NULL CHECK (fee_eur >= 0),
  fee_charge TEXT CHECK (fee_charge IS NULL OR fee_charge IN ('vendeur', 'acquereur')),
  due_on TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('due')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sale_commissions_month ON sale_commissions (network_id, due_on);
CREATE TRIGGER IF NOT EXISTS sale_file_closings_fige BEFORE UPDATE ON sale_file_closings BEGIN SELECT RAISE(ABORT, 'sale_file_closings : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS sale_file_closings_sans_effacement BEFORE DELETE ON sale_file_closings BEGIN SELECT RAISE(ABORT, 'sale_file_closings : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS sale_commissions_fige BEFORE UPDATE ON sale_commissions BEGIN SELECT RAISE(ABORT, 'sale_commissions : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS sale_commissions_sans_effacement BEFORE DELETE ON sale_commissions BEGIN SELECT RAISE(ABORT, 'sale_commissions : rien ne s''efface'); END;
