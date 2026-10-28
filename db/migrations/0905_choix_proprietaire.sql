-- W05 · Dossiers montrés au propriétaire dans leur ordre d'arrivée, reçu d'équité (M15) [R105, R104, R14, R17].
-- Une présentation est un instantané : les seuls dossiers complets, dans leur ordre d'arrivée, sans nom, sans note,
-- sans rang ; son empreinte est écrite au journal pour être rejouée à l'identique.
CREATE TABLE IF NOT EXISTS rental_presentations (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES rental_listings (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (listing_id, version)
);
CREATE TRIGGER IF NOT EXISTS rental_presentations_garde BEFORE DELETE ON rental_presentations BEGIN SELECT RAISE(ABORT, 'rental_presentations : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_presentations_fige BEFORE UPDATE ON rental_presentations BEGIN SELECT RAISE(ABORT, 'rental_presentations : une présentation rangée ne change plus'); END;

-- Le choix du propriétaire, un seul par mise en location : sa date, son canal et sa preuve ; jamais fait par le code.
CREATE TABLE IF NOT EXISTS rental_choices (
  listing_id TEXT PRIMARY KEY REFERENCES rental_listings (id) ON DELETE RESTRICT,
  presentation_id TEXT NOT NULL REFERENCES rental_presentations (id) ON DELETE RESTRICT,
  application_id TEXT NOT NULL REFERENCES rental_applications (id) ON DELETE RESTRICT,
  decided_at TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('oral', 'ecrit', 'mail', 'sms', 'whatsapp')),
  proof_ref TEXT NOT NULL UNIQUE,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS rental_choices_garde BEFORE DELETE ON rental_choices BEGIN SELECT RAISE(ABORT, 'rental_choices : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_choices_fige BEFORE UPDATE ON rental_choices BEGIN SELECT RAISE(ABORT, 'rental_choices : un choix rangé ne change plus'); END;

-- Les reçus d'équité : au candidat, les seules pièces demandées, son arrivée et la règle ; au propriétaire, la preuve
-- que l'ordre montré est celui des arrivées. Préparés une seule fois, jamais envoyés d'ici (W10).
CREATE TABLE IF NOT EXISTS rental_fairness_receipts (
  id TEXT PRIMARY KEY,
  presentation_id TEXT NOT NULL REFERENCES rental_presentations (id) ON DELETE RESTRICT,
  recipient TEXT NOT NULL CHECK (recipient IN ('candidat', 'proprietaire')),
  application_id TEXT,
  person_id TEXT NOT NULL,
  text TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  CHECK ((recipient = 'candidat') = (application_id IS NOT NULL)),
  UNIQUE (presentation_id, recipient, person_id)
);
CREATE TRIGGER IF NOT EXISTS rental_fairness_receipts_garde BEFORE DELETE ON rental_fairness_receipts BEGIN SELECT RAISE(ABORT, 'rental_fairness_receipts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_fairness_receipts_fige BEFORE UPDATE ON rental_fairness_receipts BEGIN SELECT RAISE(ABORT, 'rental_fairness_receipts : un reçu préparé ne change plus'); END;
