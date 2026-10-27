-- N03 · Relances des pièces manquantes, en mode essai (M10). Une ligne par pièce, par dossier et par jour : le passage
-- la remplit une fois ; une relance en attente des heures d'envoi est reprise au passage suivant. Rien ne s'efface [R17].
CREATE TABLE IF NOT EXISTS sale_file_reminders (
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  piece TEXT NOT NULL,
  day TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('vendeur', 'acquereur')),
  -- `closed` : une relance en attente dont le jour est passé ou la pièce reçue, close avec sa raison dans `rule`.
  status TEXT NOT NULL CHECK (status IN ('sent', 'waiting', 'refused', 'failed', 'closed')),
  rule TEXT,
  message_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (file_id, piece, day)
);
CREATE TRIGGER IF NOT EXISTS sale_file_reminders_sans_effacement BEFORE DELETE ON sale_file_reminders BEGIN SELECT RAISE(ABORT, 'sale_file_reminders : rien ne s''efface'); END;
-- Une relance partie, refusée ou close ne change plus.
CREATE TRIGGER IF NOT EXISTS sale_file_reminders_fige BEFORE UPDATE ON sale_file_reminders WHEN OLD.status IN ('sent', 'refused', 'closed') BEGIN SELECT RAISE(ABORT, 'sale_file_reminders : une relance partie ou refusée ne change plus'); END;
