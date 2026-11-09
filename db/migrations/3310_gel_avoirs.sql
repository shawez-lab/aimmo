-- HX57 · Contrôle du gel des avoirs (Sécurité et conformité) [R603, R604, R605].

-- Une version du registre national des gels, importée par le responsable de la conformité. Elle naît ouverte, reçoit
-- ses entrées, puis se scelle avec leur nombre et leur empreinte : seule une version scellée sert à un contrôle. Une
-- version est toujours plus récente que la précédente du réseau. Rien ne change ni ne s'efface [R17].
CREATE TABLE IF NOT EXISTS freeze_registry_versions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  -- Le jour et l'heure de publication du registre, en UTC (AAAA-MM-JJTHH:MM:SS.sssZ).
  published_at TEXT NOT NULL CHECK (length(published_at) = 24),
  -- L'empreinte SHA-256 de l'écriture canonique des entrées et de la date de publication.
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  entries INTEGER NOT NULL CHECK (entries >= 1),
  imported_by TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  sealed_at TEXT,
  UNIQUE (network_id, sha256),
  UNIQUE (network_id, published_at)
);
CREATE INDEX IF NOT EXISTS freeze_registry_versions_network ON freeze_registry_versions (network_id, published_at);
CREATE TRIGGER IF NOT EXISTS freeze_registry_versions_naissance BEFORE INSERT ON freeze_registry_versions
WHEN NEW.sealed_at IS NOT NULL OR EXISTS (
  SELECT 1 FROM freeze_registry_versions WHERE network_id = NEW.network_id AND published_at >= NEW.published_at)
BEGIN SELECT RAISE(ABORT, 'freeze_registry_versions : une version naît ouverte et plus récente que la précédente [R605]'); END;
-- Seul changement permis : le scellement, une fois, quand toutes les entrées annoncées sont rangées.
CREATE TRIGGER IF NOT EXISTS freeze_registry_versions_sceau BEFORE UPDATE ON freeze_registry_versions
WHEN OLD.sealed_at IS NOT NULL OR NEW.sealed_at IS NULL
  OR NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.published_at IS NOT OLD.published_at
  OR NEW.sha256 IS NOT OLD.sha256 OR NEW.entries IS NOT OLD.entries OR NEW.imported_by IS NOT OLD.imported_by
  OR NEW.imported_at IS NOT OLD.imported_at
  OR (SELECT count(*) FROM freeze_registry_entries WHERE version_id = OLD.id) <> OLD.entries
BEGIN SELECT RAISE(ABORT, 'freeze_registry_versions : une version se scelle une fois, complète, puis ne change plus [R605]'); END;
CREATE TRIGGER IF NOT EXISTS freeze_registry_versions_garde BEFORE DELETE ON freeze_registry_versions
BEGIN SELECT RAISE(ABORT, 'freeze_registry_versions : rien ne s''efface'); END;

-- Les entrées d'une version : personne physique ou morale, ses noms normalisés (nom, prénoms, alias). Données
-- publiques du registre, aucun client.
CREATE TABLE IF NOT EXISTS freeze_registry_entries (
  version_id TEXT NOT NULL REFERENCES freeze_registry_versions (id) ON DELETE RESTRICT,
  entry_id TEXT NOT NULL CHECK (length(entry_id) BETWEEN 1 AND 64),
  nature TEXT NOT NULL CHECK (nature IN ('personne_physique', 'personne_morale')),
  names TEXT NOT NULL CHECK (json_valid(names) AND json_type(names) = 'array' AND json_array_length(names) >= 1),
  PRIMARY KEY (version_id, entry_id)
);
CREATE TRIGGER IF NOT EXISTS freeze_registry_entries_ouverte BEFORE INSERT ON freeze_registry_entries
WHEN (SELECT sealed_at FROM freeze_registry_versions WHERE id = NEW.version_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'freeze_registry_entries : une version scellée ne reçoit plus rien [R605]'); END;
CREATE TRIGGER IF NOT EXISTS freeze_registry_entries_fige BEFORE UPDATE ON freeze_registry_entries
BEGIN SELECT RAISE(ABORT, 'freeze_registry_entries : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS freeze_registry_entries_garde BEFORE DELETE ON freeze_registry_entries
BEGIN SELECT RAISE(ABORT, 'freeze_registry_entries : rien ne s''efface'); END;

-- Chaque contrôle d'un dossier : sa date, la version scellée du registre, le périmètre contrôlé (par son empreinte), le
-- résultat. Un même dossier, sur le même périmètre, ne se contrôle qu'une fois par version [R605].
CREATE TABLE IF NOT EXISTS freeze_checks (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  case_ref TEXT NOT NULL,
  version_id TEXT NOT NULL REFERENCES freeze_registry_versions (id) ON DELETE RESTRICT,
  scope_sha256 TEXT NOT NULL CHECK (length(scope_sha256) = 64),
  persons INTEGER NOT NULL CHECK (persons >= 1),
  result TEXT NOT NULL CHECK (result IN ('aucune', 'correspondance', 'nom_manquant')),
  -- Les correspondances : [{ "personId", "entryId" }] ; vide sauf pour une correspondance.
  matches TEXT NOT NULL CHECK (json_valid(matches) AND json_type(matches) = 'array'),
  -- Les fiches sans nom, qu'aucun contrôle ne peut juger : à vérifier à la main par le responsable.
  unnamed TEXT NOT NULL CHECK (json_valid(unnamed) AND json_type(unnamed) = 'array'),
  reason TEXT NOT NULL CHECK (reason IN ('demande', 'mise_a_jour', 'passage')),
  requested_by TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  UNIQUE (case_ref, version_id, scope_sha256),
  CHECK ((result = 'correspondance') = (json_array_length(matches) > 0)),
  CHECK (result <> 'nom_manquant' OR json_array_length(unnamed) > 0)
);
CREATE INDEX IF NOT EXISTS freeze_checks_case ON freeze_checks (network_id, case_ref, checked_at);
CREATE TRIGGER IF NOT EXISTS freeze_checks_version BEFORE INSERT ON freeze_checks
WHEN NOT EXISTS (
  SELECT 1 FROM freeze_registry_versions WHERE id = NEW.version_id AND network_id = NEW.network_id AND sealed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'freeze_checks : un contrôle se fait sur une version scellée du registre du réseau [R605]'); END;
CREATE TRIGGER IF NOT EXISTS freeze_checks_fige BEFORE UPDATE ON freeze_checks
BEGIN SELECT RAISE(ABORT, 'freeze_checks : un contrôle ne change plus'); END;
CREATE TRIGGER IF NOT EXISTS freeze_checks_garde BEFORE DELETE ON freeze_checks
BEGIN SELECT RAISE(ABORT, 'freeze_checks : rien ne s''efface'); END;

-- Une correspondance : l'alerte au seul responsable, avec la copie figée du dossier à cet instant [R603].
CREATE TABLE IF NOT EXISTS freeze_matches (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  check_id TEXT NOT NULL UNIQUE REFERENCES freeze_checks (id) ON DELETE RESTRICT,
  case_ref TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS freeze_matches_network ON freeze_matches (network_id, created_at);
CREATE TRIGGER IF NOT EXISTS freeze_matches_naissance BEFORE INSERT ON freeze_matches
WHEN NOT EXISTS (
  SELECT 1 FROM freeze_checks WHERE id = NEW.check_id AND network_id = NEW.network_id AND case_ref = NEW.case_ref AND result = 'correspondance')
BEGIN SELECT RAISE(ABORT, 'freeze_matches : seulement pour un contrôle qui a trouvé une correspondance [R603]'); END;
CREATE TRIGGER IF NOT EXISTS freeze_matches_fige BEFORE UPDATE ON freeze_matches
BEGIN SELECT RAISE(ABORT, 'freeze_matches : une correspondance ne change plus'); END;
CREATE TRIGGER IF NOT EXISTS freeze_matches_garde BEFORE DELETE ON freeze_matches
BEGIN SELECT RAISE(ABORT, 'freeze_matches : rien ne s''efface'); END;

-- La décision du responsable, seul et une seule fois : fausse correspondance, ou correspondance confirmée.
CREATE TABLE IF NOT EXISTS freeze_match_decisions (
  match_id TEXT PRIMARY KEY REFERENCES freeze_matches (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('fausse_correspondance', 'correspondance_confirmee')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  validator_name TEXT NOT NULL CHECK (length(trim(validator_name)) > 0),
  decided_by TEXT NOT NULL CHECK (decided_by LIKE 'compliance:%'),
  decided_on TEXT NOT NULL CHECK (length(decided_on) = 10),
  at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS freeze_match_decisions_reseau BEFORE INSERT ON freeze_match_decisions
WHEN NOT EXISTS (SELECT 1 FROM freeze_matches WHERE id = NEW.match_id AND network_id = NEW.network_id)
BEGIN SELECT RAISE(ABORT, 'freeze_match_decisions : la correspondance d''un autre réseau'); END;
CREATE TRIGGER IF NOT EXISTS freeze_match_decisions_fige BEFORE UPDATE ON freeze_match_decisions
BEGIN SELECT RAISE(ABORT, 'freeze_match_decisions : une décision ne change plus'); END;
CREATE TRIGGER IF NOT EXISTS freeze_match_decisions_garde BEFORE DELETE ON freeze_match_decisions
BEGIN SELECT RAISE(ABORT, 'freeze_match_decisions : rien ne s''efface'); END;
