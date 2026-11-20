-- AU029 · La reprise d'un agent garde ses échanges, ses notes de suivi et ses prochains rappels (M14, J05)
-- [R84, R13, R16, R17, R18].
-- Un export d'historique (Hektor, Apimo, Excel, Google) est rapproché, ligne par ligne, de la fiche de l'agent qui
-- porte l'identifiant du contact de l'export, ou son mail, ou son téléphone. Une ligne sans fiche de l'agent n'est
-- jamais rangée : elle est comptée au bilan des éléments non repris, avec son numéro.
-- Rien ne s'efface ni ne change. Rien n'est envoyé : un rappel est une tâche de l'agent, jamais un message.

-- Les échanges passés et les notes de suivi : rangés tels quels sur la fiche, à leur date d'origine.
CREATE TABLE IF NOT EXISTS agent_import_history (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  origin_key TEXT NOT NULL CHECK (length(origin_key) BETWEEN 1 AND 200),
  agent_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('call', 'email', 'sms', 'whatsapp', 'meeting', 'visit', 'note')),
  happened_on TEXT NOT NULL CHECK (length(happened_on) = 10),
  body TEXT CHECK (body IS NULL OR length(body) <= 2000),
  source_format TEXT NOT NULL CHECK (source_format IN ('hektor', 'apimo', 'excel', 'google')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, origin_key),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agent_import_history_person ON agent_import_history (person_id, happened_on);
CREATE TRIGGER IF NOT EXISTS agent_import_history_garde BEFORE DELETE ON agent_import_history BEGIN SELECT RAISE(ABORT, 'agent_import_history : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_import_history_fige BEFORE UPDATE ON agent_import_history BEGIN SELECT RAISE(ABORT, 'agent_import_history : un échange repris ne change plus'); END;

-- Les prochains rappels (actions à faire, échéance passée comprise) : des tâches de l'agent sur la fiche.
CREATE TABLE IF NOT EXISTS agent_import_reminders (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  origin_key TEXT NOT NULL CHECK (length(origin_key) BETWEEN 1 AND 200),
  agent_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('call', 'email', 'sms', 'whatsapp', 'meeting', 'visit', 'task')),
  due_on TEXT NOT NULL CHECK (length(due_on) = 10),
  body TEXT CHECK (body IS NULL OR length(body) <= 2000),
  source_format TEXT NOT NULL CHECK (source_format IN ('hektor', 'apimo', 'excel', 'google')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, origin_key),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agent_import_reminders_agent ON agent_import_reminders (agent_id, due_on);
CREATE INDEX IF NOT EXISTS agent_import_reminders_person ON agent_import_reminders (person_id, due_on);
CREATE TRIGGER IF NOT EXISTS agent_import_reminders_garde BEFORE DELETE ON agent_import_reminders BEGIN SELECT RAISE(ABORT, 'agent_import_reminders : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_import_reminders_fige BEFORE UPDATE ON agent_import_reminders BEGIN SELECT RAISE(ABORT, 'agent_import_reminders : un rappel repris ne change plus'); END;

-- Un rappel repris, fait par l'agent : une seule fois, jamais défait.
CREATE TABLE IF NOT EXISTS agent_import_reminder_closures (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  origin_key TEXT NOT NULL,
  closed_by TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  PRIMARY KEY (network_id, origin_key),
  FOREIGN KEY (network_id, origin_key) REFERENCES agent_import_reminders (network_id, origin_key) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS agent_import_reminder_closures_garde BEFORE DELETE ON agent_import_reminder_closures BEGIN SELECT RAISE(ABORT, 'agent_import_reminder_closures : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_import_reminder_closures_fige BEFORE UPDATE ON agent_import_reminder_closures BEGIN SELECT RAISE(ABORT, 'agent_import_reminder_closures : un rappel fait le reste'); END;
