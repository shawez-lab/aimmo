-- HX37 · Ordre des signataires, annexes groupées et rappels. Tables nouvelles, en ajout seul : rien ne s'efface ni ne
-- se réécrit [R17]. Un circuit réunit un document du dossier et ses annexes sous une seule empreinte [R465], ses
-- signataires rangés par groupes dans l'ordre [R464] ; chaque lecture d'annexe, signature et rappel est une ligne.
CREATE TABLE IF NOT EXISTS signature_circuits (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  -- Le document à signer : une référence du stockage des pièces, jamais son contenu, et l'empreinte de son contenu.
  document_ref TEXT NOT NULL CHECK (length(document_ref) BETWEEN 10 AND 300),
  document_hash TEXT NOT NULL CHECK (length(document_hash) = 64),
  -- L'empreinte unique du document et de toutes ses annexes, dans leur ordre [R465].
  envelope_hash TEXT NOT NULL UNIQUE CHECK (length(envelope_hash) = 64),
  prepared_by TEXT NOT NULL,
  prepared_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signature_circuits_file ON signature_circuits (file_id, prepared_at);
CREATE TABLE IF NOT EXISTS signature_circuit_annexes (
  circuit_id TEXT NOT NULL REFERENCES signature_circuits (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('diagnostics', 'etat_risques', 'copropriete', 'mesurage', 'mobilier')),
  ref TEXT NOT NULL CHECK (length(ref) BETWEEN 10 AND 300),
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  PRIMARY KEY (circuit_id, position),
  UNIQUE (circuit_id, ref)
);
CREATE TABLE IF NOT EXISTS signature_circuit_signers (
  circuit_id TEXT NOT NULL REFERENCES signature_circuits (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('vendeur', 'acquereur')),
  grp INTEGER NOT NULL CHECK (grp >= 1),
  PRIMARY KEY (circuit_id, person_id)
);
CREATE TABLE IF NOT EXISTS signature_circuit_events (
  circuit_id TEXT NOT NULL REFERENCES signature_circuits (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('lecture', 'signature', 'rappel', 'rappel_refuse')),
  person_id TEXT NOT NULL,
  -- Lecture : l'annexe lue et l'empreinte du texte en mots simples montré [R466].
  annex_position INTEGER,
  text_hash TEXT CHECK (text_hash IS NULL OR length(text_hash) = 64),
  -- Signature : l'empreinte du circuit signée, et la preuve rangée au stockage [R465].
  envelope_hash TEXT CHECK (envelope_hash IS NULL OR length(envelope_hash) = 64),
  proof_ref TEXT,
  -- Rappel : son rang pour ce signataire, le message rangé par le contrôle central, la règle d'un refus [R467].
  n INTEGER CHECK (n IS NULL OR n >= 1),
  message_id TEXT,
  rule TEXT,
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  PRIMARY KEY (circuit_id, seq),
  CHECK (kind <> 'lecture' OR (annex_position IS NOT NULL AND text_hash IS NOT NULL)),
  CHECK (kind <> 'signature' OR (envelope_hash IS NOT NULL AND proof_ref IS NOT NULL)),
  CHECK (kind NOT IN ('rappel', 'rappel_refuse') OR n IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS signature_circuit_events_person ON signature_circuit_events (circuit_id, person_id, kind);
-- Une signature par signataire, un rappel de chaque rang, une preuve pour un seul fait.
CREATE UNIQUE INDEX IF NOT EXISTS signature_circuit_events_signe ON signature_circuit_events (circuit_id, person_id) WHERE kind = 'signature';
CREATE UNIQUE INDEX IF NOT EXISTS signature_circuit_events_rappel ON signature_circuit_events (circuit_id, person_id, n) WHERE kind IN ('rappel', 'rappel_refuse');
CREATE UNIQUE INDEX IF NOT EXISTS signature_circuit_events_preuve ON signature_circuit_events (proof_ref) WHERE proof_ref IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS signature_circuits_garde BEFORE DELETE ON signature_circuits BEGIN SELECT RAISE(ABORT, 'signature_circuits : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS signature_circuits_fige BEFORE UPDATE ON signature_circuits BEGIN SELECT RAISE(ABORT, 'signature_circuits : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS signature_circuit_annexes_garde BEFORE DELETE ON signature_circuit_annexes BEGIN SELECT RAISE(ABORT, 'signature_circuit_annexes : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS signature_circuit_annexes_fige BEFORE UPDATE ON signature_circuit_annexes BEGIN SELECT RAISE(ABORT, 'signature_circuit_annexes : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS signature_circuit_signers_garde BEFORE DELETE ON signature_circuit_signers BEGIN SELECT RAISE(ABORT, 'signature_circuit_signers : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS signature_circuit_signers_fige BEFORE UPDATE ON signature_circuit_signers BEGIN SELECT RAISE(ABORT, 'signature_circuit_signers : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS signature_circuit_events_garde BEFORE DELETE ON signature_circuit_events BEGIN SELECT RAISE(ABORT, 'signature_circuit_events : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS signature_circuit_events_fige BEFORE UPDATE ON signature_circuit_events BEGIN SELECT RAISE(ABORT, 'signature_circuit_events : rien ne se réécrit'); END;
