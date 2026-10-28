-- U05 · Pièces déposées par les partenaires, rangées d'elles-mêmes (M18) [R78, R77, R17].
-- Une pièce est une référence de stockage avec son empreinte, jamais son contenu ; une nouvelle version s'ajoute.
CREATE TABLE IF NOT EXISTS partner_documents (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  referral_id TEXT NOT NULL REFERENCES partner_referrals (id) ON DELETE RESTRICT,
  partner_id TEXT NOT NULL REFERENCES partners (id) ON DELETE RESTRICT,
  sort TEXT NOT NULL CHECK (length(sort) BETWEEN 2 AND 40 AND sort NOT GLOB '*[^a-z_]*'),
  version INTEGER NOT NULL CHECK (version >= 1),
  ref TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  issued_on TEXT NOT NULL,
  deposited_at TEXT NOT NULL,
  -- Où la pièce a été rangée, par une règle écrite, dans la même écriture que le dépôt : fiche du bien, dossier de
  -- vente, financement du dossier, mise en relation, ou file de l'agent quand la règle ne sait pas la ranger.
  destination TEXT NOT NULL CHECK (destination IN ('property', 'sale_file', 'financing', 'referral', 'agent_queue')),
  target_id TEXT NOT NULL,
  piece TEXT,
  reason TEXT NOT NULL,
  UNIQUE (referral_id, sort, version)
);
CREATE INDEX IF NOT EXISTS partner_documents_target ON partner_documents (destination, target_id);
CREATE INDEX IF NOT EXISTS partner_documents_referral ON partner_documents (referral_id, sort, version);
CREATE TRIGGER IF NOT EXISTS partner_documents_garde BEFORE DELETE ON partner_documents BEGIN SELECT RAISE(ABORT, 'partner_documents : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS partner_documents_fige BEFORE UPDATE ON partner_documents BEGIN SELECT RAISE(ABORT, 'partner_documents : une pièce déposée ne change plus'); END;


-- Une pièce ne s'ajoute qu'à une mise en relation confiée et encore ouverte, vérifié au moment même de l'écriture :
-- une clôture passée entre le contrôle d'accès et le dépôt l'emporte [R77].
CREATE TRIGGER IF NOT EXISTS partner_documents_ouverte BEFORE INSERT ON partner_documents
WHEN COALESCE((SELECT state FROM partner_referral_steps WHERE referral_id = NEW.referral_id ORDER BY seq DESC LIMIT 1), '') NOT IN ('confiee', 'en_cours')
BEGIN SELECT RAISE(ABORT, 'partner_documents : mise en relation close'); END;
