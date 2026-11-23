-- AU044 · La reprise d'une note vocale que le transcripteur n'a pas pu lire (HX23, M03) [R696, R241, R13, R16].
-- Une note rangée « impossible » (service absent, en panne, trop lent, vide ou incertain) ouvre une seule tâche de
-- reprise, liée au message illisible où son contenu brut est gardé : l'agent y retrouve la référence de l'audio chez le
-- canal pour l'écouter, puis dit la reprise faite. La tâche s'efface avec le message reçu, comme la note (droit à
-- l'effacement). La référence de l'audio n'est lue que par la route d'écoute, jamais
-- par le journal ni par une sortie publique [R13]. Seule la fin de la reprise
-- s'écrit, une fois.
CREATE TABLE IF NOT EXISTS voice_note_recoveries (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  voice_note_id TEXT NOT NULL UNIQUE REFERENCES voice_notes (id) ON DELETE RESTRICT,
  inbound_id TEXT NOT NULL REFERENCES inbound_messages (id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'instagram', 'facebook')),
  failure TEXT NOT NULL CHECK (failure IN ('indisponible', 'echec', 'vide', 'incertaine')),
  media_ref TEXT NOT NULL CHECK (length(media_ref) BETWEEN 1 AND 2048),
  mime TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT,
  done_by TEXT,
  CHECK ((done_at IS NULL) = (done_by IS NULL))
);
CREATE INDEX IF NOT EXISTS voice_note_recoveries_file ON voice_note_recoveries (network_id, done_at, created_at);
CREATE TRIGGER IF NOT EXISTS voice_note_recoveries_fige BEFORE UPDATE ON voice_note_recoveries
WHEN OLD.done_at IS NOT NULL
  OR NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.voice_note_id IS NOT OLD.voice_note_id
  OR NEW.inbound_id IS NOT OLD.inbound_id OR NEW.channel IS NOT OLD.channel OR NEW.failure IS NOT OLD.failure
  OR NEW.media_ref IS NOT OLD.media_ref OR NEW.mime IS NOT OLD.mime OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'voice_note_recoveries : seule la fin de la reprise s''écrit, une fois'); END;
