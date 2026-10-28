-- F07 · Clé d'idempotence de la route de recommandation (reste de F01) : deux envois de la même saisie, même en même
-- temps, ne rangent qu'une recommandation ; le second reçoit la réponse du premier. La clé est rangée par son
-- empreinte, jamais en clair ; aucune donnée du proche ici [R13]. Rien ne s'efface [R17].
CREATE TABLE IF NOT EXISTS referral_requests (
  key_hash TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  -- Le lecteur qui a envoyé la clé, `role:id` : une clé ne sert qu'à lui.
  actor TEXT NOT NULL,
  -- La réponse rangée, une fois la saisie traitée ; NULL tant qu'elle est en cours.
  status INTEGER CHECK (status IS NULL OR status BETWEEN 200 AND 599),
  body TEXT CHECK (body IS NULL OR json_valid(body)),
  created_at TEXT NOT NULL,
  answered_at TEXT,
  CHECK ((status IS NULL) = (body IS NULL))
);
CREATE TRIGGER IF NOT EXISTS referral_requests_garde BEFORE DELETE ON referral_requests BEGIN SELECT RAISE(ABORT, 'clé gardée'); END;
CREATE TRIGGER IF NOT EXISTS referral_requests_fige
BEFORE UPDATE ON referral_requests
WHEN NEW.key_hash IS NOT OLD.key_hash OR NEW.network_id IS NOT OLD.network_id OR NEW.actor IS NOT OLD.actor OR NEW.created_at IS NOT OLD.created_at OR OLD.status IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'clé figée une fois répondue'); END;
