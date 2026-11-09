-- HX58 · Réclamations des clients et médiateur (Sécurité et conformité) [R606, R607].

-- Le réglage du réseau, par versions qui s'ajoutent : le délai de réponse promis, et le médiateur de la consommation
-- auquel le réseau adhère (code de la consommation, articles L612-1 et L616-1). Rien ne change ni ne s'efface [R17].
CREATE TABLE IF NOT EXISTS complaint_settings (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  response_days INTEGER NOT NULL CHECK (response_days BETWEEN 1 AND 60),
  mediator_name TEXT NOT NULL CHECK (length(trim(mediator_name)) BETWEEN 1 AND 120),
  mediator_site TEXT NOT NULL CHECK (mediator_site LIKE 'https://%' AND length(mediator_site) <= 200),
  set_by TEXT NOT NULL CHECK (set_by LIKE 'direction:%'),
  set_at TEXT NOT NULL,
  PRIMARY KEY (network_id, version)
);
CREATE TRIGGER IF NOT EXISTS complaint_settings_suite BEFORE INSERT ON complaint_settings
WHEN NEW.version <> 1 + coalesce((SELECT max(version) FROM complaint_settings WHERE network_id = NEW.network_id), 0)
BEGIN SELECT RAISE(ABORT, 'complaint_settings : une version suit la précédente'); END;
CREATE TRIGGER IF NOT EXISTS complaint_settings_fige BEFORE UPDATE ON complaint_settings
BEGIN SELECT RAISE(ABORT, 'complaint_settings : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS complaint_settings_garde BEFORE DELETE ON complaint_settings
BEGIN SELECT RAISE(ABORT, 'complaint_settings : rien ne s''efface'); END;

-- Une réclamation d'un client : reçue tel jour (Paris), avec son échéance de réponse, écrite par la base [R606].
CREATE TABLE IF NOT EXISTS complaints (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  agent_id TEXT,
  received_on TEXT NOT NULL CHECK (length(received_on) = 10 AND date(received_on) = received_on),
  -- Comment elle est arrivée ; une réclamation écrite ouvre le médiateur (article L612-2).
  received_via TEXT NOT NULL CHECK (received_via IN ('mail', 'courrier', 'message', 'oral')),
  -- Le canal et la conversation où répondre, quand elle est arrivée par mail ou par message.
  reply_channel TEXT CHECK (reply_channel IS NULL OR reply_channel IN ('email', 'sms', 'whatsapp', 'instagram', 'facebook')),
  conversation_id TEXT,
  -- Le motif, dans les mots de l'agent ; jamais au journal.
  summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 2000),
  response_days INTEGER NOT NULL CHECK (response_days BETWEEN 1 AND 60),
  due_on TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  CHECK (due_on = date(received_on, '+' || response_days || ' days')),
  CHECK ((reply_channel IS NULL) = (conversation_id IS NULL)),
  CHECK (reply_channel IS NULL OR received_via IN ('mail', 'message')),
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS complaints_due ON complaints (network_id, due_on);
CREATE INDEX IF NOT EXISTS complaints_person ON complaints (person_id);
CREATE TRIGGER IF NOT EXISTS complaints_fige BEFORE UPDATE ON complaints
BEGIN SELECT RAISE(ABORT, 'complaints : une réclamation ne change plus'); END;
CREATE TRIGGER IF NOT EXISTS complaints_garde BEFORE DELETE ON complaints
BEGIN SELECT RAISE(ABORT, 'complaints : rien ne s''efface'); END;

-- La réponse, une fois : réglée (le client est d'accord), ou non réglée.
CREATE TABLE IF NOT EXISTS complaint_answers (
  complaint_id TEXT PRIMARY KEY REFERENCES complaints (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('reglee', 'non_reglee')),
  note TEXT NOT NULL CHECK (length(trim(note)) BETWEEN 1 AND 2000),
  answered_on TEXT NOT NULL CHECK (length(answered_on) = 10),
  late INTEGER NOT NULL CHECK (late IN (0, 1)),
  answered_by TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS complaint_answers_naissance BEFORE INSERT ON complaint_answers
WHEN NOT EXISTS (
  SELECT 1 FROM complaints c WHERE c.id = NEW.complaint_id AND c.network_id = NEW.network_id
    AND NEW.answered_on >= c.received_on AND NEW.late = (NEW.answered_on > c.due_on))
BEGIN SELECT RAISE(ABORT, 'complaint_answers : la réponse suit la réclamation, en retard si après l''échéance [R606]'); END;
CREATE TRIGGER IF NOT EXISTS complaint_answers_fige BEFORE UPDATE ON complaint_answers
BEGIN SELECT RAISE(ABORT, 'complaint_answers : une réponse ne change plus'); END;
CREATE TRIGGER IF NOT EXISTS complaint_answers_garde BEFORE DELETE ON complaint_answers
BEGIN SELECT RAISE(ABORT, 'complaint_answers : rien ne s''efface'); END;

-- Les alertes de l'échéance, une de chaque sorte par réclamation, rangées pour l'agent et la direction [R606].
CREATE TABLE IF NOT EXISTS complaint_alerts (
  complaint_id TEXT NOT NULL REFERENCES complaints (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('j7', 'j2', 'echeance', 'mediateur_manquant', 'a_remettre')),
  created_on TEXT NOT NULL CHECK (length(created_on) = 10),
  created_at TEXT NOT NULL,
  PRIMARY KEY (complaint_id, kind)
);
CREATE TRIGGER IF NOT EXISTS complaint_alerts_fige BEFORE UPDATE ON complaint_alerts
BEGIN SELECT RAISE(ABORT, 'complaint_alerts : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS complaint_alerts_garde BEFORE DELETE ON complaint_alerts
BEGIN SELECT RAISE(ABORT, 'complaint_alerts : rien ne s''efface'); END;

-- Le médiateur proposé au client, de lui-même, une fois par réclamation : à l'échéance sans réponse réglée, ou dès une
-- réponse « non réglée » [R607]. Le texte est écrit par le code, avec la version du réglage qui nomme le médiateur.
CREATE TABLE IF NOT EXISTS complaint_mediator_offers (
  complaint_id TEXT PRIMARY KEY REFERENCES complaints (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  cause TEXT NOT NULL CHECK (cause IN ('echeance', 'non_reglee')),
  settings_version INTEGER NOT NULL,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  -- Envoyé par le contrôle central, ou à remettre par l'agent (courrier, ou envoi refusé) ; remis ensuite, une fois.
  status TEXT NOT NULL CHECK (status IN ('envoye', 'a_remettre', 'remis')),
  send_rule TEXT,
  created_on TEXT NOT NULL CHECK (length(created_on) = 10),
  created_at TEXT NOT NULL,
  handed_at TEXT,
  handed_by TEXT,
  CHECK ((status = 'remis') = (handed_at IS NOT NULL)),
  CHECK ((handed_at IS NULL) = (handed_by IS NULL)),
  FOREIGN KEY (network_id, settings_version) REFERENCES complaint_settings (network_id, version) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS complaint_mediator_offers_naissance BEFORE INSERT ON complaint_mediator_offers
WHEN NEW.status <> 'a_remettre' OR NEW.send_rule IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM complaints c WHERE c.id = NEW.complaint_id AND c.network_id = NEW.network_id AND (
    (NEW.cause = 'echeance' AND NEW.created_on >= c.due_on
      AND NOT EXISTS (SELECT 1 FROM complaint_answers a WHERE a.complaint_id = c.id AND a.outcome = 'reglee' AND a.answered_on <= c.due_on))
    OR (NEW.cause = 'non_reglee' AND EXISTS (SELECT 1 FROM complaint_answers a WHERE a.complaint_id = c.id AND a.outcome = 'non_reglee'))))
BEGIN SELECT RAISE(ABORT, 'complaint_mediator_offers : le médiateur se propose à l''échéance sans réponse réglée, ou après une réponse non réglée [R607]'); END;
-- Une proposition naît « à remettre », réservée avant l'envoi ; l'issue de l'envoi s'écrit une fois (envoyée, ou
-- refusée avec sa règle et toujours à remettre) ; une proposition à remettre passe à « remise », une fois.
CREATE TRIGGER IF NOT EXISTS complaint_mediator_offers_fige BEFORE UPDATE ON complaint_mediator_offers
WHEN OLD.status <> 'a_remettre'
  OR NEW.complaint_id IS NOT OLD.complaint_id OR NEW.network_id IS NOT OLD.network_id OR NEW.cause IS NOT OLD.cause
  OR NEW.settings_version IS NOT OLD.settings_version OR NEW.text IS NOT OLD.text
  OR NEW.created_on IS NOT OLD.created_on OR NEW.created_at IS NOT OLD.created_at
  OR NOT (
    (OLD.send_rule IS NULL AND NEW.status = 'envoye' AND NEW.send_rule IS NOT NULL AND NEW.handed_at IS NULL)
    OR (OLD.send_rule IS NULL AND NEW.status = 'a_remettre' AND NEW.send_rule IS NOT NULL AND NEW.handed_at IS NULL)
    OR (NEW.status = 'remis' AND NEW.send_rule IS OLD.send_rule))
BEGIN SELECT RAISE(ABORT, 'complaint_mediator_offers : l''issue de l''envoi s''écrit une fois, une proposition à remettre se remet une fois [R607]'); END;
CREATE TRIGGER IF NOT EXISTS complaint_mediator_offers_garde BEFORE DELETE ON complaint_mediator_offers
BEGIN SELECT RAISE(ABORT, 'complaint_mediator_offers : rien ne s''efface'); END;
