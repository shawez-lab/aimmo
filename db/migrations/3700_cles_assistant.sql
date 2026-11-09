-- BR09 · L'agent crée et retire lui-même la clé de son assistant (HX55) [R590, R601, R82, R17, R13].
--
-- Une clé de portée « mcp », créée par l'agent depuis l'application, sur la preuve de sa clé d'appareil. Seule son
-- empreinte SHA-256 est rangée : la clé n'existe que dans la réponse qui la remet, une fois. Elle n'ouvre que
-- `POST /v1/mcp`. Elle se retire en datant `revoked_at`, une fois, jamais en l'effaçant.
CREATE TABLE IF NOT EXISTS assistant_keys (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL CHECK (length(user_id) > 0),
  sha256 TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64),
  -- Le nom que l'agent donne à son assistant (« ChatGPT », « Claude »), pour le reconnaître et le retirer.
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  -- La clé d'appareil qui a prouvé la création [R601].
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (user_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS assistant_keys_agent ON assistant_keys (network_id, user_id, revoked_at);

CREATE TRIGGER IF NOT EXISTS assistant_keys_retrait_seul BEFORE UPDATE ON assistant_keys
WHEN OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id
  OR NEW.user_id IS NOT OLD.user_id OR NEW.sha256 IS NOT OLD.sha256 OR NEW.label IS NOT OLD.label
  OR NEW.device_id IS NOT OLD.device_id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'clé d''assistant figée'); END;
CREATE TRIGGER IF NOT EXISTS assistant_keys_sans_effacement BEFORE DELETE ON assistant_keys BEGIN SELECT RAISE(ABORT, 'clé d''assistant gardée'); END;
