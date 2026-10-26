-- C07 · Réponses écrites par un humain, reçues en écho avant que leur conversation soit connue (l'agent a écrit
-- le premier, ou l'écho précède le message du client). Gardées jusqu'à ce que la conversation existe, puis
-- appliquées avant toute réponse automatique [R21]. Rien n'est jamais effacé : `applied_at` est rempli.
CREATE TABLE IF NOT EXISTS pending_human_replies (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('instagram', 'facebook', 'whatsapp')),
  external_id TEXT NOT NULL,
  conversation_ref TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  PRIMARY KEY (network_id, channel, external_id)
);
CREATE INDEX IF NOT EXISTS pending_human_replies_open ON pending_human_replies (network_id, applied_at);

CREATE TRIGGER IF NOT EXISTS pending_human_replies_sans_effacement
BEFORE DELETE ON pending_human_replies
BEGIN
  SELECT RAISE(ABORT, 'pending_human_replies : rien ne s''efface');
END;
