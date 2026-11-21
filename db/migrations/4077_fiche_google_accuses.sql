-- AU037 : l'accusé réel de chaque envoi à la fiche Google, et l'échec dit avec ce qu'il faut faire. Ajout seul : rien
-- ne change ni ne s'efface [R17]. Seuls les envois réels en ont un : un essai n'appelle jamais Google [R26]. Un envoi
-- réussi garde la référence que Google a rendue (réponse, publication ou fiche) et, pour une publication, son lien
-- public ; un échec garde son code fermé et le geste qui le règle, jamais le texte de Google [R13, R154].
CREATE TABLE IF NOT EXISTS gbp_receipts (
  send_id TEXT PRIMARY KEY REFERENCES gbp_sends (id) ON DELETE RESTRICT,
  ack_ref TEXT CHECK (ack_ref IS NULL OR length(ack_ref) BETWEEN 3 AND 300),
  url TEXT CHECK (url IS NULL OR (url LIKE 'https://%' AND length(url) <= 500)),
  error_code TEXT CHECK (error_code IS NULL OR error_code IN ('connexion', 'droits', 'fiche_introuvable', 'refuse_google', 'limite', 'panne', 'accuse_absent')),
  action TEXT CHECK (action IS NULL OR action IN ('reconnecter', 'relier', 'corriger', 'reessayer', 'verifier')),
  done_at TEXT NOT NULL,
  CHECK ((ack_ref IS NOT NULL AND error_code IS NULL AND action IS NULL)
      OR (ack_ref IS NULL AND url IS NULL AND error_code IS NOT NULL AND action IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS gbp_receipts_garde BEFORE DELETE ON gbp_receipts BEGIN SELECT RAISE(ABORT, 'gbp_receipts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS gbp_receipts_fige BEFORE UPDATE ON gbp_receipts BEGIN SELECT RAISE(ABORT, 'gbp_receipts : un accusé ne change plus'); END;
