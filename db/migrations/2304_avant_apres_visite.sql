-- HX44 · Avant et après la visite : dossier envoyé, visite à distance et son bon (M08, M19). En ajout seul : rien ne
-- s'efface ; seuls l'issue d'un envoi, la fin d'une visite à distance et l'état d'une signature avancent, une fois [R17].

-- Le dossier du bien envoyé avant la visite : la dernière version publiée du jour, rendue par le code, relue, figée.
-- Le lien porte un jeton tiré au hasard dont seule l'empreinte est gardée [R502, R503].
CREATE TABLE IF NOT EXISTS visit_dossiers (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  appointment_id TEXT NOT NULL REFERENCES visits (appointment_id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  version_id TEXT NOT NULL REFERENCES listing_versions (id) ON DELETE RESTRICT,
  payload_hash TEXT NOT NULL,
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 200000),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('a_envoyer', 'envoye', 'refuse')),
  message_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((status = 'envoye') = (message_id IS NOT NULL)),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS visit_dossiers_visit ON visit_dossiers (appointment_id, created_at);
CREATE INDEX IF NOT EXISTS visit_dossiers_person ON visit_dossiers (person_id);
CREATE TRIGGER IF NOT EXISTS visit_dossiers_garde BEFORE DELETE ON visit_dossiers BEGIN SELECT RAISE(ABORT, 'visit_dossiers : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS visit_dossiers_fige
BEFORE UPDATE ON visit_dossiers
WHEN NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.appointment_id IS NOT OLD.appointment_id
  OR NEW.property_id IS NOT OLD.property_id OR NEW.person_id IS NOT OLD.person_id OR NEW.version_id IS NOT OLD.version_id
  OR NEW.payload_hash IS NOT OLD.payload_hash OR NEW.content IS NOT OLD.content OR NEW.content_hash IS NOT OLD.content_hash
  OR NEW.token_hash IS NOT OLD.token_hash OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at OR OLD.status <> 'a_envoyer' OR NEW.status = 'a_envoyer'
BEGIN
  SELECT RAISE(ABORT, 'visit_dossiers : un dossier envoyé ne change plus');
END;

-- Une visite faite à distance : son début et sa fin, une fois. Son bon se signe en ligne juste après [R504].
CREATE TABLE IF NOT EXISTS remote_visits (
  appointment_id TEXT PRIMARY KEY REFERENCES visits (appointment_id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS remote_visits_property ON remote_visits (property_id, person_id);
CREATE TRIGGER IF NOT EXISTS remote_visits_garde BEFORE DELETE ON remote_visits BEGIN SELECT RAISE(ABORT, 'remote_visits : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS remote_visits_fige
BEFORE UPDATE ON remote_visits
WHEN NEW.appointment_id IS NOT OLD.appointment_id OR NEW.network_id IS NOT OLD.network_id OR NEW.property_id IS NOT OLD.property_id
  OR NEW.person_id IS NOT OLD.person_id OR NEW.started_by IS NOT OLD.started_by OR NEW.started_at IS NOT OLD.started_at
  OR OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'remote_visits : une visite finie ne change plus');
END;

-- La signature en ligne du bon d'une visite à distance, comme D08 : un lien au visiteur, un code à usage unique par
-- le contrôle central ; seules les empreintes du jeton, du code et du tracé sont gardées [R504].
CREATE TABLE IF NOT EXISTS remote_slip_signatures (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  appointment_id TEXT NOT NULL REFERENCES remote_visits (appointment_id) ON DELETE RESTRICT,
  slip_id TEXT NOT NULL REFERENCES visit_slips (id) ON DELETE RESTRICT,
  slip_hash TEXT NOT NULL CHECK (length(slip_hash) = 64),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
  code_expires_at TEXT NOT NULL,
  link_expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  status TEXT NOT NULL CHECK (status IN ('ouverte', 'signee', 'bloquee', 'remplacee')),
  signed_at TEXT,
  drawing_hash TEXT,
  proof TEXT CHECK (proof IS NULL OR json_valid(proof)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((status = 'signee') = (signed_at IS NOT NULL AND proof IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS remote_slip_signatures_visit ON remote_slip_signatures (appointment_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS remote_slip_signatures_une_signee ON remote_slip_signatures (appointment_id) WHERE status = 'signee';
CREATE UNIQUE INDEX IF NOT EXISTS remote_slip_signatures_une_ouverte ON remote_slip_signatures (appointment_id) WHERE status = 'ouverte';
CREATE TRIGGER IF NOT EXISTS remote_slip_signatures_garde BEFORE DELETE ON remote_slip_signatures BEGIN SELECT RAISE(ABORT, 'remote_slip_signatures : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS remote_slip_signatures_fige
BEFORE UPDATE ON remote_slip_signatures
WHEN NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.appointment_id IS NOT OLD.appointment_id
  OR NEW.slip_id IS NOT OLD.slip_id OR NEW.slip_hash IS NOT OLD.slip_hash OR NEW.token_hash IS NOT OLD.token_hash
  OR NEW.code_hash IS NOT OLD.code_hash OR NEW.code_expires_at IS NOT OLD.code_expires_at OR NEW.link_expires_at IS NOT OLD.link_expires_at
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at OR OLD.status <> 'ouverte'
  OR NEW.attempts < OLD.attempts
BEGIN
  SELECT RAISE(ABORT, 'remote_slip_signatures : une signature close ne change plus');
END;
-- Le bon signé est celui de la visite, tel qu'il est rangé : le contenu ne peut avoir changé (visit_slips est figé).
CREATE TRIGGER IF NOT EXISTS remote_slip_signatures_bon_de_la_visite
BEFORE INSERT ON remote_slip_signatures
WHEN NOT EXISTS (SELECT 1 FROM visit_slips s WHERE s.id = NEW.slip_id AND s.appointment_id = NEW.appointment_id AND s.status = 'complet')
  OR NOT EXISTS (SELECT 1 FROM remote_visits r WHERE r.appointment_id = NEW.appointment_id AND r.ended_at IS NOT NULL AND r.network_id = NEW.network_id)
BEGIN
  SELECT RAISE(ABORT, 'remote_slip_signatures : bon complet d''une visite à distance finie seulement');
END;

-- Aucune offre d'un acquéreur sur un bien qu'il a visité à distance tant que le bon de cette visite n'est pas signé
-- en ligne. Les fiches réunies comptent pour une seule personne, sur quatre réunions de suite [R505].
CREATE TRIGGER IF NOT EXISTS offer_register_bon_distance_signe
BEFORE INSERT ON offer_register
WHEN EXISTS (
  SELECT 1 FROM remote_visits rv
   WHERE rv.property_id = NEW.property_id
     AND COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = rv.person_id AND pm.undone_at IS NULL), rv.person_id) AND pm.undone_at IS NULL), COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = rv.person_id AND pm.undone_at IS NULL), rv.person_id)) AND pm.undone_at IS NULL), COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = rv.person_id AND pm.undone_at IS NULL), rv.person_id) AND pm.undone_at IS NULL), COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = rv.person_id AND pm.undone_at IS NULL), rv.person_id))) AND pm.undone_at IS NULL), COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = rv.person_id AND pm.undone_at IS NULL), rv.person_id) AND pm.undone_at IS NULL), COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = rv.person_id AND pm.undone_at IS NULL), rv.person_id)) AND pm.undone_at IS NULL), COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = rv.person_id AND pm.undone_at IS NULL), rv.person_id) AND pm.undone_at IS NULL), COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = rv.person_id AND pm.undone_at IS NULL), rv.person_id)))) = COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = NEW.buyer_person_id AND pm.undone_at IS NULL), NEW.buyer_person_id) AND pm.undone_at IS NULL), COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = NEW.buyer_person_id AND pm.undone_at IS NULL), NEW.buyer_person_id)) AND pm.undone_at IS NULL), COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = NEW.buyer_person_id AND pm.undone_at IS NULL), NEW.buyer_person_id) AND pm.undone_at IS NULL), COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = NEW.buyer_person_id AND pm.undone_at IS NULL), NEW.buyer_person_id))) AND pm.undone_at IS NULL), COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = NEW.buyer_person_id AND pm.undone_at IS NULL), NEW.buyer_person_id) AND pm.undone_at IS NULL), COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = NEW.buyer_person_id AND pm.undone_at IS NULL), NEW.buyer_person_id)) AND pm.undone_at IS NULL), COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = NEW.buyer_person_id AND pm.undone_at IS NULL), NEW.buyer_person_id) AND pm.undone_at IS NULL), COALESCE((SELECT pm.survivor_id FROM person_merges pm WHERE pm.merged_id = NEW.buyer_person_id AND pm.undone_at IS NULL), NEW.buyer_person_id))))
     AND NOT EXISTS (SELECT 1 FROM remote_slip_signatures s WHERE s.appointment_id = rv.appointment_id AND s.status = 'signee')
)
BEGIN
  SELECT RAISE(ABORT, 'offre refusée : bon de la visite à distance non signé');
END;
