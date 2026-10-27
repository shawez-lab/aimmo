-- T03 · Alertes aux acquéreurs, en mode essai. Une ligne par bien et par personne : jamais deux alertes du même bien à
-- la même personne [R05], la réservation du contrôle central restant la garde finale. Ni texte ni coordonnée ici [R13].
CREATE TABLE IF NOT EXISTS property_alerts (
  property_id TEXT NOT NULL REFERENCES properties (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  project_id TEXT,
  channel TEXT,
  -- `pending` : en cours ; `waiting` : refusée pour l'heure seulement [R01], reprise au passage suivant ;
  -- `failed` : canal en panne, reprise ; `sent` : rangée dans la boîte d'essai ; `refused` : refus définitif.
  status TEXT NOT NULL CHECK (status IN ('pending', 'waiting', 'failed', 'sent', 'refused')),
  rule TEXT,
  message_id TEXT REFERENCES messages (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (property_id, person_id)
);
CREATE INDEX IF NOT EXISTS property_alerts_person ON property_alerts (network_id, person_id, created_at);

CREATE TRIGGER IF NOT EXISTS property_alerts_garde BEFORE DELETE ON property_alerts
BEGIN
  SELECT RAISE(ABORT, 'property_alerts : rien ne s''efface');
END;

-- Le lien de désinscription : seule l'empreinte du jeton est gardée. Un jeton sert autant de fois qu'on veut, le
-- retrait de l'accord ne se fait qu'une fois [R49].
CREATE TABLE IF NOT EXISTS alert_unsubscribe_tokens (
  token_hash TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS alert_unsubscribe_tokens_person ON alert_unsubscribe_tokens (person_id);

CREATE TRIGGER IF NOT EXISTS alert_unsubscribe_tokens_garde BEFORE DELETE ON alert_unsubscribe_tokens
BEGIN
  SELECT RAISE(ABORT, 'alert_unsubscribe_tokens : rien ne s''efface');
END;
