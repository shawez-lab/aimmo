-- HX56 · Clé d'accès, double authentification et données en Europe (Sécurité et conformité) [R600, R601].

-- Une clé d'accès (WebAuthn, empreinte ou visage) par appareil d'un utilisateur du réseau. Seule la clé publique est
-- rangée : la clé privée ne quitte jamais l'appareil. La première clé d'un utilisateur est active d'emblée ; chaque
-- suivante attend l'accord de la direction, ou une preuve d'une clé déjà active [R600]. Une clé retirée l'est pour
-- toujours ; rien ne s'efface [R17].
CREATE TABLE IF NOT EXISTS security_devices (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  user_role TEXT NOT NULL CHECK (user_role IN ('agent', 'direction', 'compliance')),
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  -- ES256 seulement (COSE -7) : P-256 et SHA-256.
  alg INTEGER NOT NULL CHECK (alg = -7),
  sign_count INTEGER NOT NULL CHECK (sign_count >= 0),
  -- Un nom donné par l'utilisateur à son appareil (« téléphone »), jamais un nom de personne.
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  status TEXT NOT NULL CHECK (status IN ('en_attente', 'actif', 'retire')),
  created_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  CHECK ((status = 'retire') = (revoked_at IS NOT NULL)),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK ((approved_at IS NULL) = (approved_by IS NULL)),
  CHECK (status <> 'en_attente' OR approved_at IS NULL),
  CHECK (status <> 'actif' OR approved_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS security_devices_user ON security_devices (network_id, user_role, user_id);
CREATE TRIGGER IF NOT EXISTS security_devices_naissance BEFORE INSERT ON security_devices
WHEN NEW.status = 'retire' OR EXISTS (SELECT 1 FROM security_devices WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'security_devices : une clé naît en attente ou active, une seule fois [R600]'); END;
-- La première clé, active d'emblée, est la seule de son utilisateur [R600].
CREATE TRIGGER IF NOT EXISTS security_devices_premiere BEFORE INSERT ON security_devices
WHEN NEW.approved_by = 'premiere_cle' AND EXISTS (
  SELECT 1 FROM security_devices WHERE network_id = NEW.network_id AND user_role = NEW.user_role AND user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'security_devices : une seule première clé par utilisateur [R600]'); END;
CREATE TRIGGER IF NOT EXISTS security_devices_garde BEFORE DELETE ON security_devices
BEGIN SELECT RAISE(ABORT, 'security_devices : rien ne s''efface'); END;
-- La clé publique, son appareil et son utilisateur ne changent jamais ; une clé retirée ne revient pas ; le compteur
-- de signatures ne fait que monter (une clé copiée se trahit) [R600].
CREATE TRIGGER IF NOT EXISTS security_devices_fige BEFORE UPDATE ON security_devices
WHEN OLD.status = 'retire'
  OR (OLD.status = 'actif' AND NEW.status = 'en_attente')
  OR NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.user_role IS NOT OLD.user_role
  OR NEW.user_id IS NOT OLD.user_id OR NEW.credential_id IS NOT OLD.credential_id OR NEW.public_key IS NOT OLD.public_key
  OR NEW.alg IS NOT OLD.alg OR NEW.label IS NOT OLD.label OR NEW.created_at IS NOT OLD.created_at
  OR NEW.sign_count < OLD.sign_count
  OR (OLD.approved_at IS NOT NULL AND (NEW.approved_at IS NOT OLD.approved_at OR NEW.approved_by IS NOT OLD.approved_by))
BEGIN SELECT RAISE(ABORT, 'security_devices : une clé ne change pas, retirée elle le reste [R600]'); END;

-- Les défis envoyés à un appareil : chacun sert une fois, avant son échéance. Un défi d'action sensible porte son
-- action et son objet [R601].
CREATE TABLE IF NOT EXISTS security_challenges (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  user_role TEXT NOT NULL,
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login', 'step_up')),
  challenge TEXT NOT NULL UNIQUE,
  action TEXT,
  subject TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  CHECK ((purpose = 'step_up') = (action IS NOT NULL)),
  CHECK ((purpose = 'step_up') = (subject IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS security_challenges_garde BEFORE DELETE ON security_challenges
BEGIN SELECT RAISE(ABORT, 'security_challenges : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS security_challenges_fige BEFORE UPDATE ON security_challenges
WHEN OLD.used_at IS NOT NULL OR NEW.used_at IS NULL OR NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id
  OR NEW.user_role IS NOT OLD.user_role OR NEW.user_id IS NOT OLD.user_id OR NEW.purpose IS NOT OLD.purpose
  OR NEW.challenge IS NOT OLD.challenge OR NEW.action IS NOT OLD.action OR NEW.subject IS NOT OLD.subject
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT, 'security_challenges : un défi sert une fois [R600]'); END;

-- Les séances ouvertes par une clé d'appareil : seule l'empreinte du jeton est rangée. Une séance vaut tant que son
-- appareil est actif : retirer l'appareil la coupe à l'instant [R600].
CREATE TABLE IF NOT EXISTS security_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  user_role TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES security_devices (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS security_sessions_garde BEFORE DELETE ON security_sessions
BEGIN SELECT RAISE(ABORT, 'security_sessions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS security_sessions_fige BEFORE UPDATE ON security_sessions
BEGIN SELECT RAISE(ABORT, 'security_sessions : une séance ne change pas'); END;

-- La preuve du second facteur pour une action sensible : faite par une clé active de l'utilisateur, pour cette action
-- et cet objet seulement, une fois, dans les cinq minutes [R601].
CREATE TABLE IF NOT EXISTS security_step_ups (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  user_role TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES security_devices (id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TRIGGER IF NOT EXISTS security_step_ups_garde BEFORE DELETE ON security_step_ups
BEGIN SELECT RAISE(ABORT, 'security_step_ups : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS security_step_ups_fige BEFORE UPDATE ON security_step_ups
WHEN OLD.used_at IS NOT NULL OR NEW.used_at IS NULL OR NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id
  OR NEW.user_role IS NOT OLD.user_role OR NEW.user_id IS NOT OLD.user_id OR NEW.device_id IS NOT OLD.device_id
  OR NEW.action IS NOT OLD.action OR NEW.subject IS NOT OLD.subject OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT, 'security_step_ups : une preuve sert une fois [R601]'); END;
