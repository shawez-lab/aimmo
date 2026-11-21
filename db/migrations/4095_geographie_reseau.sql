-- AU039 · Le paramétrage géographique du réseau : les communes que la qualification et la recherche reconnaissent,
-- chacune avec son code INSEE, rangées par la direction et non écrites dans le code (M03 ; audit A039) [R679].
-- Table nouvelle, en ajout seul : rien ne change ni ne s'efface [R17].

-- Une commune entre dans la liste du réseau ou en sort, par versions : la plus haute vaut. La première version
-- l'inscrit ; chaque version suivante dit le contraire de la précédente. Aucune personne n'y figure.
CREATE TABLE IF NOT EXISTS network_communes (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  insee_code TEXT NOT NULL CHECK (length(insee_code) = 5 AND (insee_code GLOB '[0-9][0-9][0-9][0-9][0-9]' OR insee_code GLOB '2[AB][0-9][0-9][0-9]')),
  version INTEGER NOT NULL CHECK (version >= 1),
  commune TEXT NOT NULL CHECK (length(trim(commune)) BETWEEN 1 AND 80),
  -- Le nom sans accent, en minuscules, mots séparés d'une espace : « fontaine les dijon ». Deux communes inscrites
  -- n'ont jamais la même clé ; la base le vérifie à l'écriture, deux décisions en même temps comprises.
  commune_key TEXT NOT NULL CHECK (length(commune_key) BETWEEN 1 AND 80 AND commune_key = lower(commune_key) AND commune_key = trim(commune_key)),
  is_listed INTEGER NOT NULL CHECK (is_listed IN (0, 1)),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 200),
  decided_by TEXT NOT NULL CHECK (decided_by LIKE 'direction:%'),
  decided_at TEXT NOT NULL,
  PRIMARY KEY (network_id, insee_code, version)
);
CREATE TRIGGER IF NOT EXISTS network_communes_suite BEFORE INSERT ON network_communes
WHEN NEW.version <> 1 + COALESCE((SELECT MAX(c.version) FROM network_communes c WHERE c.network_id = NEW.network_id AND c.insee_code = NEW.insee_code), 0)
  OR NEW.is_listed = COALESCE((SELECT c.is_listed FROM network_communes c WHERE c.network_id = NEW.network_id AND c.insee_code = NEW.insee_code ORDER BY c.version DESC LIMIT 1), 0)
BEGIN SELECT RAISE(ABORT, 'network_communes : version hors suite ou état inchangé'); END;
CREATE TRIGGER IF NOT EXISTS network_communes_nom_unique BEFORE INSERT ON network_communes
WHEN NEW.is_listed = 1 AND EXISTS (
  SELECT 1 FROM network_communes c
   WHERE c.network_id = NEW.network_id AND c.insee_code <> NEW.insee_code AND c.commune_key = NEW.commune_key AND c.is_listed = 1
     AND c.version = (SELECT MAX(d.version) FROM network_communes d WHERE d.network_id = c.network_id AND d.insee_code = c.insee_code)
)
BEGIN SELECT RAISE(ABORT, 'network_communes : nom déjà inscrit'); END;
-- Un retrait garde le nom et la clé de la version d'avant.
CREATE TRIGGER IF NOT EXISTS network_communes_retrait BEFORE INSERT ON network_communes
WHEN NEW.is_listed = 0 AND NOT EXISTS (
  SELECT 1 FROM network_communes c WHERE c.network_id = NEW.network_id AND c.insee_code = NEW.insee_code AND c.version = NEW.version - 1
     AND c.commune = NEW.commune AND c.commune_key = NEW.commune_key
)
BEGIN SELECT RAISE(ABORT, 'network_communes : un retrait garde le nom inscrit'); END;
CREATE TRIGGER IF NOT EXISTS network_communes_garde BEFORE DELETE ON network_communes BEGIN SELECT RAISE(ABORT, 'network_communes : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS network_communes_fige BEFORE UPDATE ON network_communes BEGIN SELECT RAISE(ABORT, 'network_communes : une version ne change plus, une autre s''ajoute'); END;
