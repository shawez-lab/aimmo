-- HX30 · Visibilité dans les moteurs d'IA. Table nouvelle, en ajout seul : rien ne s'efface [R17].
-- Le moteur d'IA par lequel un contact est arrivé, lu en liste fermée sur la page d'où il vient ou sur le paramètre
-- `utm_source` que le moteur ajoute à ses liens [R430]. Rien d'autre n'est gardé : ni adresse, ni question posée au
-- moteur, ni identifiant de navigateur [R156].
CREATE TABLE IF NOT EXISTS contact_ai_engines (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  inbound_id TEXT NOT NULL UNIQUE REFERENCES inbound_messages (id) ON DELETE RESTRICT,
  engine TEXT NOT NULL CHECK (engine IN ('chatgpt', 'perplexity', 'gemini', 'copilot', 'claude', 'mistral', 'deepseek')),
  method TEXT NOT NULL CHECK (method IN ('referent', 'utm')),
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contact_ai_engines_network ON contact_ai_engines (network_id, recorded_at);

CREATE TRIGGER IF NOT EXISTS contact_ai_engines_fige BEFORE UPDATE ON contact_ai_engines
BEGIN
  SELECT RAISE(ABORT, 'contact_ai_engines : un moteur rangé ne change pas');
END;
CREATE TRIGGER IF NOT EXISTS contact_ai_engines_sans_effacement BEFORE DELETE ON contact_ai_engines
BEGIN
  SELECT RAISE(ABORT, 'contact_ai_engines : rien ne s''efface');
END;
