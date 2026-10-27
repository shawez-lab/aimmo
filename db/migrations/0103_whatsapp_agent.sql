-- T09 · Alerte WhatsApp en un geste, par le téléphone de l'agent. Le lien est préparé après le contrôle central et
-- rendu à l'agent seulement : ni le lien, ni le numéro, ni le texte ne sont gardés ici [R13]. L'envoi est confirmé
-- par l'agent une seule fois [R18] ; rien ne s'efface [R17].
CREATE TABLE IF NOT EXISTS agent_whatsapp_alerts (
  message_id TEXT PRIMARY KEY REFERENCES messages (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL REFERENCES properties (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  confirmed_at TEXT,
  confirmed_by TEXT
);
CREATE INDEX IF NOT EXISTS agent_whatsapp_alerts_agent ON agent_whatsapp_alerts (network_id, agent_id, prepared_at);

CREATE TRIGGER IF NOT EXISTS agent_whatsapp_alerts_garde BEFORE DELETE ON agent_whatsapp_alerts
BEGIN
  SELECT RAISE(ABORT, 'agent_whatsapp_alerts : rien ne s''efface');
END;
