-- HX36 · Lettre recommandée électronique et notification de l'avant-contrat. Tables nouvelles, en ajout seul : rien
-- ne s'efface ni ne se réécrit [R17, R462]. Une lettre préparée par l'agent du bien ; chacun de ses faits (envoi par le
-- contrôle central, dépôt, première présentation, acceptation, refus, non réclamée) est une ligne, avec sa preuve.
CREATE TABLE IF NOT EXISTS registered_letters (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (purpose IN ('notification_avant_contrat')),
  person_id TEXT NOT NULL,
  -- Le compromis signé, joint à la lettre : une référence du stockage des pièces, jamais son contenu.
  document_ref TEXT NOT NULL CHECK (length(document_ref) BETWEEN 10 AND 300),
  -- L'empreinte du texte de la lettre, écrit par le code : le texte part par le contrôle central, qui le range.
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  prepared_by TEXT NOT NULL,
  prepared_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS registered_letters_file ON registered_letters (file_id, prepared_at);
CREATE TABLE IF NOT EXISTS registered_letter_events (
  letter_id TEXT NOT NULL REFERENCES registered_letters (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('envoi', 'envoi_refuse', 'depot', 'premiere_presentation', 'acceptation', 'refus', 'non_reclamee')),
  -- L'heure du fait, telle que la preuve la donne (ou l'heure de l'envoi), et son jour à Paris.
  occurred_at TEXT NOT NULL,
  day TEXT NOT NULL CHECK (length(day) = 10),
  -- La preuve du prestataire, rangée au stockage des pièces ; null pour un envoi, qui n'en a pas encore.
  proof_ref TEXT,
  message_id TEXT,
  -- Envoi seulement : 1 s'il est resté dans la boîte d'essai, rien n'est parti.
  trial INTEGER CHECK (trial IS NULL OR trial IN (0, 1)),
  rule TEXT,
  recorded_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  PRIMARY KEY (letter_id, seq),
  CHECK (kind IN ('envoi', 'envoi_refuse') OR proof_ref IS NOT NULL)
);
-- Un seul fait de chaque sorte par lettre, sauf les envois refusés, qui peuvent se répéter.
CREATE UNIQUE INDEX IF NOT EXISTS registered_letter_events_once ON registered_letter_events (letter_id, kind) WHERE kind <> 'envoi_refuse';
-- Une preuve ne sert qu'à un seul fait.
CREATE UNIQUE INDEX IF NOT EXISTS registered_letter_events_proof ON registered_letter_events (proof_ref) WHERE proof_ref IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS registered_letters_garde BEFORE DELETE ON registered_letters BEGIN SELECT RAISE(ABORT, 'registered_letters : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS registered_letters_fige BEFORE UPDATE ON registered_letters BEGIN SELECT RAISE(ABORT, 'registered_letters : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS registered_letter_events_garde BEFORE DELETE ON registered_letter_events BEGIN SELECT RAISE(ABORT, 'registered_letter_events : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS registered_letter_events_fige BEFORE UPDATE ON registered_letter_events BEGIN SELECT RAISE(ABORT, 'registered_letter_events : rien ne se réécrit'); END;
