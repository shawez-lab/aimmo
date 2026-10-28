-- J10 · Parrainage dans les règles (M14) [R83, R80, R17].
-- Aucun frais d'entrée, nulle part. Une prime n'existe que sur une commission réellement encaissée par le filleul.

-- Le parrain d'un agent, rangé à son entrée, une seule fois.
CREATE TABLE IF NOT EXISTS sponsorships (
  agent_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  sponsor_id TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (agent_id <> sponsor_id),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (sponsor_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS sponsorships_sponsor ON sponsorships (network_id, sponsor_id);
CREATE TRIGGER IF NOT EXISTS sponsorships_garde BEFORE DELETE ON sponsorships BEGIN SELECT RAISE(ABORT, 'sponsorships : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS sponsorships_fige BEFORE UPDATE ON sponsorships BEGIN SELECT RAISE(ABORT, 'sponsorships : un parrain rangé ne change plus'); END;

-- Le taux de la prime (sur la part du réseau) et le nombre de niveaux, réglés par la direction ; la dernière version
-- compte, aucune ne s'efface.
CREATE TABLE IF NOT EXISTS referral_settings (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  rate_bp INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 5000),
  levels INTEGER NOT NULL CHECK (levels = 1),
  written_by TEXT NOT NULL,
  written_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS referral_settings_latest ON referral_settings (network_id, written_at);
CREATE TRIGGER IF NOT EXISTS referral_settings_garde BEFORE DELETE ON referral_settings BEGIN SELECT RAISE(ABORT, 'referral_settings : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS referral_settings_fige BEFORE UPDATE ON referral_settings BEGIN SELECT RAISE(ABORT, 'referral_settings : un réglage écrit ne change plus'); END;
