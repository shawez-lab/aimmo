-- Y06 · Alertes aux investisseurs. La commune (code INSEE) et le type de logement d'un bien en vente, dits par son agent
-- ou la direction, pour lire le loyer de marché et les règles de la commune : jamais devinés. Une commune rangée ne
-- change plus [R17].
CREATE TABLE IF NOT EXISTS property_communes (
  property_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL,
  insee_code TEXT NOT NULL CHECK (length(insee_code) = 5),
  rent_kind TEXT NOT NULL CHECK (rent_kind IN ('apartment', 'apartment_t1_t2', 'apartment_t3_plus', 'house')),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS property_communes_garde BEFORE DELETE ON property_communes
BEGIN
  SELECT RAISE(ABORT, 'property_communes : rien ne s''efface');
END;
CREATE TRIGGER IF NOT EXISTS property_communes_fige BEFORE UPDATE ON property_communes
BEGIN
  SELECT RAISE(ABORT, 'property_communes : la commune d''un bien ne change plus');
END;

-- Une alerte par bien et par investisseur : jamais deux fois le même bien à la même personne [R05]. Le texte part par
-- le contrôle central des envois, en mode essai [R26].
CREATE TABLE IF NOT EXISTS investor_alerts (
  property_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  network_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  channel TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'refused', 'waiting', 'failed')),
  rule TEXT,
  message_id TEXT,
  gross_yield_bp INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (property_id, person_id)
);
CREATE INDEX IF NOT EXISTS investor_alerts_network ON investor_alerts (network_id, status);
CREATE TRIGGER IF NOT EXISTS investor_alerts_garde BEFORE DELETE ON investor_alerts
BEGIN
  SELECT RAISE(ABORT, 'investor_alerts : rien ne s''efface');
END;
