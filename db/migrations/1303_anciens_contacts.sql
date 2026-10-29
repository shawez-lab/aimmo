-- G09 · Anciens contacts relancés quand la loi le permet (M20) [R143, R03, R05, R35, R26, R17].
-- Un moment connu de l'agent : la fin d'un bail dont la personne lui a parlé. Daté, jamais une note sur la personne.
CREATE TABLE IF NOT EXISTS old_contact_moments (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fin_de_bail')),
  on_day TEXT NOT NULL CHECK (on_day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  noted_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS old_contact_moments_person ON old_contact_moments (network_id, person_id, on_day);
CREATE TRIGGER IF NOT EXISTS old_contact_moments_garde BEFORE DELETE ON old_contact_moments BEGIN SELECT RAISE(ABORT, 'old_contact_moments : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS old_contact_moments_fige BEFORE UPDATE ON old_contact_moments BEGIN SELECT RAISE(ABORT, 'old_contact_moments : un moment rangé ne change plus'); END;

-- Une relance préparée pour un ancien contact : une par personne et par mois au plus, et une par période réglée [R143].
-- Le texte est proposé par l'IA ou le code, validé par l'agent, puis passé au contrôle central, en mode essai [R26].
CREATE TABLE IF NOT EXISTS old_contact_followups (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  reason TEXT NOT NULL CHECK (reason IN ('fin_de_bail', 'estimation_ancienne')),
  reason_day TEXT NOT NULL,
  draft TEXT NOT NULL CHECK (length(draft) BETWEEN 1 AND 600),
  draft_by TEXT NOT NULL CHECK (draft_by IN ('ia', 'secours')),
  status TEXT NOT NULL CHECK (status IN ('a_valider', 'en_envoi', 'essai', 'refusee', 'sans_base', 'expiree')),
  channel TEXT CHECK (channel IS NULL OR channel IN ('email', 'sms', 'whatsapp')),
  rule TEXT,
  message_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  UNIQUE (person_id, month),
  CHECK ((status IN ('a_valider', 'en_envoi')) = (decided_at IS NULL))
);
CREATE INDEX IF NOT EXISTS old_contact_followups_agent ON old_contact_followups (network_id, agent_id, status, month);
CREATE INDEX IF NOT EXISTS old_contact_followups_person ON old_contact_followups (person_id, created_at);
CREATE TRIGGER IF NOT EXISTS old_contact_followups_garde BEFORE DELETE ON old_contact_followups BEGIN SELECT RAISE(ABORT, 'old_contact_followups : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS old_contact_followups_fige
BEFORE UPDATE ON old_contact_followups
WHEN OLD.status NOT IN ('a_valider', 'en_envoi') OR NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.person_id IS NOT OLD.person_id OR NEW.month IS NOT OLD.month OR NEW.reason IS NOT OLD.reason OR NEW.reason_day IS NOT OLD.reason_day
  OR NEW.draft IS NOT OLD.draft OR NEW.draft_by IS NOT OLD.draft_by OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'old_contact_followups : une relance décidée ne change plus');
END;
