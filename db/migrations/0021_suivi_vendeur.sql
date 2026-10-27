-- E06 · Suivi du vendeur : l'envoi d'un avis validé est noté, puis une relance au plus par avis si le vendeur ne
-- répond pas, par le planificateur et le contrôle central des envois. Rien ne s'efface.
CREATE TABLE IF NOT EXISTS valuation_deliveries (
  -- Un avis n'est noté envoyé qu'une fois.
  report_id TEXT PRIMARY KEY REFERENCES valuation_reports (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp')),
  conversation_id TEXT,
  sent_at TEXT NOT NULL,
  noted_by TEXT NOT NULL,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS valuation_deliveries_sent ON valuation_deliveries (network_id, sent_at);

-- La relance d'un avis : une ligne au plus par avis, donc une relance au plus [R05].
-- `pending` pendant le passage, `waiting` refusée pour l'heure [R01] et reprise au créneau suivant,
-- `answered` le vendeur a répondu avant, `sent` passée par le contrôle (en essai : rangée, jamais envoyée),
-- `refused` refusée par une règle, `failed` panne du canal.
CREATE TABLE IF NOT EXISTS valuation_follow_ups (
  report_id TEXT PRIMARY KEY REFERENCES valuation_deliveries (report_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'waiting', 'answered', 'sent', 'refused', 'failed')),
  rule TEXT,
  message_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('essai')),
  updated_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS valuation_deliveries_sans_effacement
BEFORE DELETE ON valuation_deliveries
BEGIN
  SELECT RAISE(ABORT, 'valuation_deliveries : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS valuation_follow_ups_sans_effacement
BEFORE DELETE ON valuation_follow_ups
BEGIN
  SELECT RAISE(ABORT, 'valuation_follow_ups : rien ne s''efface');
END;
