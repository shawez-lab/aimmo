-- V04 · Rappels des rendez-vous : la confirmation reprise, un rappel la veille et un le jour même, par le
-- planificateur et le contrôle central des envois, en mode essai. Rien ne s'efface.

-- Le canal de la confirmation, choisi à la réservation : les rappels passent par lui. NULL : aucun message.
ALTER TABLE appointments ADD COLUMN confirmation_channel TEXT CHECK (confirmation_channel IS NULL OR confirmation_channel IN ('email', 'phone', 'sms', 'instagram', 'facebook', 'whatsapp', 'site'));

-- Les messages d'un rendez-vous partis par le planificateur : une ligne au plus par rendez-vous et par sorte, donc
-- un rappel de chaque sorte au plus [R05].
--   `confirmation` : une confirmation refusée pour l'heure à la réservation [R01], reprise dans les heures d'envoi ;
--   `veille` : la veille du rendez-vous ; `jour` : le jour même.
-- `pending` pendant le passage, `waiting` refusé pour l'heure [R01] et repris au passage suivant, `sent` passé par le
-- contrôle (en essai : rangé, jamais envoyé), `refused` refusé par une règle, `failed` panne du canal, `skipped` sans
-- objet (un autre message du rendez-vous est déjà parti ce jour-là).
CREATE TABLE IF NOT EXISTS appointment_reminders (
  appointment_id TEXT NOT NULL REFERENCES appointments (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('confirmation', 'veille', 'jour')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'waiting', 'sent', 'refused', 'failed', 'skipped')),
  rule TEXT,
  message_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('essai')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (appointment_id, kind)
);

-- Les liens pour décaler ou annuler donnés par un rappel : chacun a son jeton, dont seule l'empreinte est gardée ; il
-- ne sert qu'à son rendez-vous, comme celui de la confirmation.
CREATE TABLE IF NOT EXISTS appointment_links (
  token_hash TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL REFERENCES appointments (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS appointment_links_rdv ON appointment_links (appointment_id);

CREATE TRIGGER IF NOT EXISTS appointment_reminders_sans_effacement
BEFORE DELETE ON appointment_reminders
BEGIN
  SELECT RAISE(ABORT, 'appointment_reminders : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS appointment_links_sans_effacement
BEFORE DELETE ON appointment_links
BEGIN
  SELECT RAISE(ABORT, 'appointment_links : rien ne s''efface');
END;
