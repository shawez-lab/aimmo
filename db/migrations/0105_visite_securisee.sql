-- T05 · Visite sécurisée. Le visiteur confirme son téléphone (code à usage unique) et son identité (son nom, égal à
-- celui de sa fiche) avant la visite [R54] ; seules l'empreinte du code et les dates sont gardées, aucune pièce
-- d'identité [R15]. L'alerte en un geste de l'agent est rangée d'abord, puis la direction prévenue ; rien ne s'efface.

CREATE TABLE IF NOT EXISTS visit_safety (
  appointment_id TEXT PRIMARY KEY REFERENCES visits (appointment_id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  code_hash TEXT,
  code_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  requested_at TEXT,
  phone_confirmed_at TEXT,
  identity_confirmed_at TEXT
);
CREATE TRIGGER IF NOT EXISTS visit_safety_garde BEFORE DELETE ON visit_safety BEGIN SELECT RAISE(ABORT, 'visite sécurisée gardée'); END;
-- Une confirmation faite ne se défait pas.
CREATE TRIGGER IF NOT EXISTS visit_safety_confirmee
BEFORE UPDATE ON visit_safety
WHEN (OLD.phone_confirmed_at IS NOT NULL AND NEW.phone_confirmed_at IS NOT OLD.phone_confirmed_at)
  OR (OLD.identity_confirmed_at IS NOT NULL AND NEW.identity_confirmed_at IS NOT OLD.identity_confirmed_at)
BEGIN
  SELECT RAISE(ABORT, 'confirmation gardée');
END;

CREATE TABLE IF NOT EXISTS safety_alerts (
  -- Choisi par l'application de l'agent : un même geste envoyé deux fois ne fait qu'une alerte.
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 64),
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  appointment_id TEXT REFERENCES appointments (id) ON DELETE RESTRICT,
  -- L'heure du geste, et la commune et l'heure de la visite en cours : jamais une adresse ni un nom.
  raised_at TEXT NOT NULL,
  town TEXT,
  visit_start_at TEXT,
  notified_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  -- Pendant l'envoi à la direction, la prise : aucune autre reprise ne l'envoie en même temps.
  claimed_until TEXT
);
CREATE INDEX IF NOT EXISTS safety_alerts_open ON safety_alerts (network_id, notified_at, raised_at);
CREATE TRIGGER IF NOT EXISTS safety_alerts_garde BEFORE DELETE ON safety_alerts BEGIN SELECT RAISE(ABORT, 'alerte gardée'); END;
