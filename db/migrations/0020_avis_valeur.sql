-- E04 · Avis de valeur : un brouillon préparé par le code (et rédigé par l'IA s'il le faut), ajusté puis validé par
-- l'agent qui suit le bien. Aucun avis ne part sans validation [R30]. Rien ne s'efface : un avis validé ne change plus.
CREATE TABLE IF NOT EXISTS valuation_reports (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  -- L'agent qui suit le bien quand le brouillon est fait.
  agent_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'validated')),
  -- Le calcul du code, tel quel : fourchette, comparables sans nom, ajustements, date des données [R27, R28].
  computed TEXT NOT NULL,
  computed_low INTEGER NOT NULL CHECK (computed_low > 0),
  computed_high INTEGER NOT NULL CHECK (computed_high >= computed_low),
  -- La fourchette de l'agent, gardée à côté du calcul ; NULL tant qu'il ne l'a pas changée.
  agent_low INTEGER CHECK (agent_low IS NULL OR agent_low > 0),
  agent_high INTEGER CHECK (agent_high IS NULL OR agent_high >= agent_low),
  text TEXT NOT NULL,
  -- `ai`, `fallback` ou `agent` : qui a écrit le texte en dernier.
  text_by TEXT NOT NULL CHECK (text_by IN ('ai', 'fallback', 'agent')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  validated_by TEXT,
  validated_at TEXT,
  CHECK ((status = 'validated') = (validated_by IS NOT NULL AND validated_at IS NOT NULL)),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS valuation_reports_property ON valuation_reports (property_id, created_at);

CREATE TRIGGER IF NOT EXISTS valuation_reports_sans_effacement
BEFORE DELETE ON valuation_reports
BEGIN
  SELECT RAISE(ABORT, 'valuation_reports : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS valuation_reports_valide_fige
BEFORE UPDATE ON valuation_reports
WHEN OLD.status = 'validated'
BEGIN
  SELECT RAISE(ABORT, 'valuation_reports : un avis validé ne change plus');
END;
