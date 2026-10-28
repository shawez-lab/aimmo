-- L06 · Registre des traitements vérifié contre la base [R17, R95].

-- Chaque relecture trimestrielle du registre, par le responsable de la conformité, avec son nom et sa date, et
-- l'empreinte du registre relu. En ajout seul : la dernière relecture fixe la prochaine échéance.
CREATE TABLE IF NOT EXISTS registry_reviews (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  reviewed_on TEXT NOT NULL CHECK (length(reviewed_on) = 10),
  validator_name TEXT NOT NULL CHECK (length(trim(validator_name)) > 0),
  registry_hash TEXT NOT NULL CHECK (length(registry_hash) = 64),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS registry_reviews_network ON registry_reviews (network_id, reviewed_on);

-- L'alerte de relecture au responsable, une seule par échéance.
CREATE TABLE IF NOT EXISTS registry_review_alerts (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  due_on TEXT NOT NULL CHECK (length(due_on) = 10),
  last_review_on TEXT NOT NULL CHECK (length(last_review_on) = 10),
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, due_on)
);

CREATE TRIGGER IF NOT EXISTS registry_reviews_sans_changement BEFORE UPDATE ON registry_reviews BEGIN SELECT RAISE(ABORT, 'relecture gardée'); END;
CREATE TRIGGER IF NOT EXISTS registry_reviews_sans_effacement BEFORE DELETE ON registry_reviews BEGIN SELECT RAISE(ABORT, 'relecture gardée'); END;
CREATE TRIGGER IF NOT EXISTS registry_review_alerts_sans_changement BEFORE UPDATE ON registry_review_alerts BEGIN SELECT RAISE(ABORT, 'alerte gardée'); END;
CREATE TRIGGER IF NOT EXISTS registry_review_alerts_sans_effacement BEFORE DELETE ON registry_review_alerts BEGIN SELECT RAISE(ABORT, 'alerte gardée'); END;
