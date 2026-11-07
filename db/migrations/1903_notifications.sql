-- HX27 · Notifications sur le téléphone, réglables. Tables nouvelles, en ajout seul : rien ne s'efface [R17].
-- Ni nom, ni coordonnée, ni texte d'un client dans une notification ni au journal [R13, R415].

-- Les réglages de l'agent, une ligne par changement : le dernier vaut. Heures calmes en minutes depuis minuit, heure
-- de Paris ; début et fin égaux : pas d'heures calmes. `levels` : JSON { sorte: 'haute' | 'normale' | 'basse' | 'coupee' },
-- jamais pour un contact chaud, toujours immédiat [R412].
CREATE TABLE IF NOT EXISTS agent_notification_settings (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  quiet_start INTEGER NOT NULL CHECK (quiet_start BETWEEN 0 AND 1439),
  quiet_end INTEGER NOT NULL CHECK (quiet_end BETWEEN 0 AND 1439),
  levels TEXT NOT NULL,
  set_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agent_notification_settings_agent ON agent_notification_settings (agent_id, set_at);

CREATE TRIGGER IF NOT EXISTS agent_notification_settings_fige BEFORE UPDATE ON agent_notification_settings
BEGIN
  SELECT RAISE(ABORT, 'agent_notification_settings : un réglage ne change pas, un nouveau s''ajoute');
END;
CREATE TRIGGER IF NOT EXISTS agent_notification_settings_sans_effacement BEFORE DELETE ON agent_notification_settings
BEGIN
  SELECT RAISE(ABORT, 'agent_notification_settings : rien ne s''efface');
END;

-- Un envoi au téléphone de l'agent : une notification seule (contact chaud) ou un groupe d'une même urgence. Réservé en
-- base avant l'appel au service de notification : deux passages n'envoient jamais le même groupe [R18].
-- `lock_title` et `lock_body` : le texte visible écran verrouillé, des phrases fixes et des nombres seulement [R415].
CREATE TABLE IF NOT EXISTS agent_pushes (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  urgency TEXT NOT NULL CHECK (urgency IN ('immediate', 'haute', 'normale', 'basse')),
  count INTEGER NOT NULL CHECK (count > 0),
  lock_title TEXT NOT NULL,
  lock_body TEXT NOT NULL,
  -- `reservee` : pris par un passage ; `partie` : remise au service ; `aucun_appareil` : l'agent n'a pas de téléphone
  -- relié ; `echec` : refusée par le service, ses notifications sont reprises ; `incertaine` : passage coupé avant la
  -- réponse du service, ses notifications sont reprises ; `abandonnee` : un autre passage avait pris ses notifications,
  -- rien n'est parti.
  status TEXT NOT NULL CHECK (status IN ('reservee', 'partie', 'aucun_appareil', 'echec', 'incertaine', 'abandonnee')),
  reserved_at TEXT NOT NULL,
  done_at TEXT,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agent_pushes_agent ON agent_pushes (agent_id, reserved_at);

CREATE TRIGGER IF NOT EXISTS agent_pushes_texte_fige BEFORE UPDATE OF lock_title, lock_body, count, urgency, agent_id ON agent_pushes
BEGIN
  SELECT RAISE(ABORT, 'agent_pushes : le texte envoyé est celui réservé');
END;
CREATE TRIGGER IF NOT EXISTS agent_pushes_sans_effacement BEFORE DELETE ON agent_pushes
BEGIN
  SELECT RAISE(ABORT, 'agent_pushes : rien ne s''efface');
END;

-- Une notification pour un agent, une seule par fait qui la cause (`dedup_key`) [R18]. Le détail se lit dans
-- l'application, sous les droits de l'agent, jamais sur l'écran verrouillé [R16, R415].
CREATE TABLE IF NOT EXISTS agent_notifications (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('contact_chaud', 'client_ecrit', 'rendez_vous', 'piece_recue', 'tache', 'info')),
  urgency TEXT NOT NULL CHECK (urgency IN ('immediate', 'haute', 'normale', 'basse')),
  dedup_key TEXT NOT NULL UNIQUE,
  -- `a_envoyer` ; `en_envoi` : dans un envoi réservé ; `envoyee` ; `sans_appareil` : aucun téléphone relié, elle reste
  -- à lire dans l'application ; `remplacee` : le contact chaud de la même personne l'a dite avant elle.
  status TEXT NOT NULL CHECK (status IN ('a_envoyer', 'en_envoi', 'envoyee', 'sans_appareil', 'remplacee')),
  push_id TEXT REFERENCES agent_pushes (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agent_notifications_waiting ON agent_notifications (agent_id, status, created_at);

CREATE TRIGGER IF NOT EXISTS agent_notifications_fige BEFORE UPDATE OF agent_id, person_id, kind, urgency, dedup_key, created_at ON agent_notifications
BEGIN
  SELECT RAISE(ABORT, 'agent_notifications : la notification ne change pas de sujet');
END;
CREATE TRIGGER IF NOT EXISTS agent_notifications_sans_effacement BEFORE DELETE ON agent_notifications
BEGIN
  SELECT RAISE(ABORT, 'agent_notifications : rien ne s''efface');
END;
