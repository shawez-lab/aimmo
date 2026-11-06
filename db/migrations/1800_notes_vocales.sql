-- HX23 · Messages vocaux transcrits et traités. Une note vocale reçue sur WhatsApp, Instagram ou Messenger est transcrite
-- une seule fois [R18, R240] : la ligne dit qu'il s'agit d'une transcription et la lie à son audio d'origine chez le canal [R240].
-- Une transcription impossible ne garde ni texte ni lien : le message est rangé illisible et passé à l'agent, son audio
-- reste dans le contenu brut de la réception [R241]. Une ligne ne change jamais ; elle s'efface avec le message reçu.
CREATE TABLE IF NOT EXISTS voice_notes (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'instagram', 'facebook')),
  external_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('en_cours', 'transcrite', 'impossible')),
  reason TEXT CHECK (reason IN ('indisponible', 'echec', 'vide', 'incertaine')),
  media_ref TEXT,
  mime TEXT,
  transcript TEXT,
  language TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_at TEXT NOT NULL,
  UNIQUE (network_id, channel, external_id),
  CHECK (
    (status = 'transcrite' AND reason IS NULL AND transcript IS NOT NULL AND media_ref IS NOT NULL)
    OR (status = 'en_cours' AND reason IS NULL AND transcript IS NULL AND media_ref IS NULL AND language IS NULL AND confidence IS NULL)
    OR (status = 'impossible' AND reason IS NOT NULL AND transcript IS NULL AND media_ref IS NULL AND language IS NULL)
  )
);
-- Une note est réservée (`en_cours`) avant d'aller au transcripteur : deux livraisons simultanées ne la transcrivent qu'une
-- fois. Seule une réservation change, pour devenir transcrite ou impossible, ou être reprise après une coupure ; ensuite,
-- rien ne change.
CREATE TRIGGER IF NOT EXISTS voice_notes_fige BEFORE UPDATE ON voice_notes WHEN OLD.status <> 'en_cours' BEGIN SELECT RAISE(ABORT, 'voice_notes : rien ne change'); END;
