-- L01 · Coffre de la conformité, réservé au responsable [R15, R17, R90].

-- Chaque pièce d'identité ou document anti-blanchiment déposé : sa référence de stockage et son empreinte, jamais son
-- contenu, ni numéro de pièce. Hors de la fiche client. Une pièce remplacée reste : la nouvelle porte `replaces_id`.
CREATE TABLE IF NOT EXISTS compliance_vault_pieces (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('carte_identite', 'passeport', 'permis_conduire', 'extrait_kbis', 'registre_beneficiaires', 'origine_fonds', 'autre_lcb')),
  -- Le dossier de vente ou le mandat concerné, facultatif.
  case_ref TEXT,
  storage_ref TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  content_type TEXT NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  verified_on TEXT NOT NULL,
  valid_until TEXT,
  replaces_id TEXT REFERENCES compliance_vault_pieces (id) ON DELETE RESTRICT,
  deposited_by TEXT NOT NULL,
  deposited_at TEXT NOT NULL,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS compliance_vault_pieces_person ON compliance_vault_pieces (network_id, person_id, deposited_at);
CREATE UNIQUE INDEX IF NOT EXISTS compliance_vault_pieces_replaces ON compliance_vault_pieces (replaces_id) WHERE replaces_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS compliance_vault_pieces_sans_changement BEFORE UPDATE ON compliance_vault_pieces BEGIN SELECT RAISE(ABORT, 'pièce gardée au coffre'); END;
CREATE TRIGGER IF NOT EXISTS compliance_vault_pieces_sans_effacement BEFORE DELETE ON compliance_vault_pieces BEGIN SELECT RAISE(ABORT, 'pièce gardée au coffre'); END;
