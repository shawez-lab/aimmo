-- F04 · Relance un an après la vente, sans jamais relancer une personne opposée (M11) [R65].
-- Le choix de chaque client, rangé par l'agent à l'acte avec sa preuve : `oui` (relances aux dates clés), `un_an`
-- (seulement à un an), `non`. Un choix dit plus tard s'ajoute, le dernier fait foi. Rien ne s'efface [R17].
CREATE TABLE IF NOT EXISTS after_sale_choices (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('oui', 'un_an', 'non')),
  proof TEXT NOT NULL CHECK (length(proof) BETWEEN 3 AND 300),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS after_sale_choices_person ON after_sale_choices (person_id, recorded_at);
CREATE TRIGGER IF NOT EXISTS after_sale_choices_garde BEFORE DELETE ON after_sale_choices BEGIN SELECT RAISE(ABORT, 'after_sale_choices : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS after_sale_choices_fige BEFORE UPDATE ON after_sale_choices BEGIN SELECT RAISE(ABORT, 'after_sale_choices : un choix rangé ne change plus, un nouveau s''ajoute'); END;

-- Une relance par client, par dossier et par date clé (`year` : 1 à 5 ans après l'acte), jamais deux [R05].
CREATE TABLE IF NOT EXISTS after_sale_reminders (
  file_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  year INTEGER NOT NULL CHECK (year BETWEEN 1 AND 5),
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  due_day TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'waiting', 'refused', 'failed', 'closed')),
  rule TEXT,
  message_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (file_id, person_id, year)
);
CREATE INDEX IF NOT EXISTS after_sale_reminders_agent ON after_sale_reminders (agent_id, due_day);
CREATE TRIGGER IF NOT EXISTS after_sale_reminders_garde BEFORE DELETE ON after_sale_reminders BEGIN SELECT RAISE(ABORT, 'after_sale_reminders : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS after_sale_reminders_fige BEFORE UPDATE ON after_sale_reminders WHEN OLD.status IN ('sent', 'refused', 'closed') BEGIN SELECT RAISE(ABORT, 'after_sale_reminders : une relance partie, refusée ou close ne change plus'); END;

-- Les liens de désinscription des relances après la vente, rangés par l'empreinte de leur jeton seulement [R65].
CREATE TABLE IF NOT EXISTS after_sale_unsubscribe_tokens (
  token_hash TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS after_sale_unsubscribe_tokens_person ON after_sale_unsubscribe_tokens (person_id);
CREATE TRIGGER IF NOT EXISTS after_sale_unsubscribe_tokens_garde BEFORE DELETE ON after_sale_unsubscribe_tokens BEGIN SELECT RAISE(ABORT, 'after_sale_unsubscribe_tokens : rien ne s''efface'); END;
