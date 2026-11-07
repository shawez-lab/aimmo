-- HX12 · L'appli utilisable sans réseau, et la photo HDR. Tables nouvelles, en ajout seul : rien ne change ni ne
-- s'efface [R17].

-- Une saisie faite hors ligne par un agent, reçue une seule fois : la clé est l'identifiant tiré par son téléphone
-- [R276]. Rejouée, elle est reconnue et rien n'est refait ; un autre contenu sous le même identifiant est refusé, jamais
-- écrit par-dessus. Le refus est gardé aussi, pour rendre la même réponse au même envoi.
CREATE TABLE IF NOT EXISTS offline_ops (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 8 AND 64),
  op_id TEXT NOT NULL CHECK (length(op_id) BETWEEN 8 AND 64),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('visite.note', 'visite.photo', 'visite.sans_objet')),
  appointment_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  outcome TEXT NOT NULL CHECK (outcome IN ('applique', 'refuse')),
  rule TEXT,
  code TEXT,
  written_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  CHECK ((outcome = 'refuse') = (code IS NOT NULL)),
  PRIMARY KEY (network_id, agent_id, device_id, op_id),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS offline_ops_appointment ON offline_ops (network_id, appointment_id);
CREATE TRIGGER IF NOT EXISTS offline_ops_fige BEFORE UPDATE ON offline_ops BEGIN SELECT RAISE(ABORT, 'offline_ops : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS offline_ops_garde BEFORE DELETE ON offline_ops BEGIN SELECT RAISE(ABORT, 'offline_ops : rien ne s''efface'); END;

-- Une note prise par l'agent pendant une visite ou une estimation, peut-être hors ligne. Son identifiant vient de celui
-- de la saisie : la même saisie reçue deux fois ne fait qu'une note [R276].
CREATE TABLE IF NOT EXISTS visit_field_notes (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  appointment_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  shot TEXT,
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
  written_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  FOREIGN KEY (appointment_id, network_id) REFERENCES appointments (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS visit_field_notes_appointment ON visit_field_notes (network_id, appointment_id, written_at);
CREATE TRIGGER IF NOT EXISTS visit_field_notes_fige BEFORE UPDATE ON visit_field_notes BEGIN SELECT RAISE(ABORT, 'visit_field_notes : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS visit_field_notes_garde BEFORE DELETE ON visit_field_notes BEGIN SELECT RAISE(ABORT, 'visit_field_notes : rien ne s''efface'); END;

-- Une photo acceptée d'une pièce de la liste de cadrage : faite d'au moins deux prises fondues (HDR), jugée de nouveau
-- par le serveur sur l'image réduite [R277]. Seuls ses chiffres sont gardés ici ; aucun visage, aucun nom.
CREATE TABLE IF NOT EXISTS visit_photos (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  appointment_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  shot TEXT NOT NULL CHECK (length(shot) BETWEEN 1 AND 40),
  exposures INTEGER NOT NULL CHECK (exposures >= 2),
  brightness REAL NOT NULL,
  clipped REAL NOT NULL,
  sharpness REAL NOT NULL,
  taken_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  FOREIGN KEY (appointment_id, network_id) REFERENCES appointments (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS visit_photos_appointment ON visit_photos (network_id, appointment_id, shot);
CREATE TRIGGER IF NOT EXISTS visit_photos_fige BEFORE UPDATE ON visit_photos BEGIN SELECT RAISE(ABORT, 'visit_photos : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS visit_photos_garde BEFORE DELETE ON visit_photos BEGIN SELECT RAISE(ABORT, 'visit_photos : rien ne s''efface'); END;

-- Une photo de la liste dite sans objet par l'agent, avec une raison d'une liste fermée [R277].
CREATE TABLE IF NOT EXISTS visit_shot_skips (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  appointment_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  shot TEXT NOT NULL CHECK (length(shot) BETWEEN 1 AND 40),
  reason TEXT NOT NULL CHECK (reason IN ('piece_absente', 'acces_refuse')),
  written_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  FOREIGN KEY (appointment_id, network_id) REFERENCES appointments (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS visit_shot_skips_appointment ON visit_shot_skips (network_id, appointment_id, shot);
CREATE TRIGGER IF NOT EXISTS visit_shot_skips_fige BEFORE UPDATE ON visit_shot_skips BEGIN SELECT RAISE(ABORT, 'visit_shot_skips : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS visit_shot_skips_garde BEFORE DELETE ON visit_shot_skips BEGIN SELECT RAISE(ABORT, 'visit_shot_skips : rien ne s''efface'); END;
