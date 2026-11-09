-- HX72 · Les régions s'ouvrent une par une, chacune sur la preuve de la phase 5 (Feuille de route, phase 5, « Ouverture
-- région par région ») [R650, R651, R652, R653]. Table nouvelle, en ajout seul : rien ne change ni ne s'efface [R17].

-- Chaque décision de la direction sur une région, ouverte ou fermée, par versions du réseau qui se suivent sans trou ;
-- la plus haute version d'une région vaut. Chaque ligne porte l'empreinte de la précédente et la sienne : la carte des
-- régions forme une chaîne que l'on peut vérifier [R653]. Une ouverture porte l'empreinte de l'ouverture de la phase 5
-- (`phase_openings`, HX71) [R651]. La Bourgogne-Franche-Comté (27) est ouverte d'office : elle n'a pas de ligne [R650].
CREATE TABLE IF NOT EXISTS region_decisions (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  region TEXT NOT NULL CHECK (region IN ('01', '02', '03', '04', '06', '11', '24', '28', '32', '44', '52', '53', '75', '76', '84', '93', '94')),
  is_open INTEGER NOT NULL CHECK (is_open IN (0, 1)),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 200),
  decided_by TEXT NOT NULL CHECK (decided_by LIKE 'direction:%'),
  decided_at TEXT NOT NULL,
  phase5_hash TEXT CHECK (phase5_hash IS NULL OR length(phase5_hash) = 64),
  prev_hash TEXT NOT NULL CHECK (length(prev_hash) = 64),
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  PRIMARY KEY (network_id, version),
  CHECK (is_open = 0 OR phase5_hash IS NOT NULL)
);
-- Chaque version suit la précédente du réseau sans trou, et change l'état de sa région (la première l'ouvre) [R651].
CREATE TRIGGER IF NOT EXISTS region_decisions_suite BEFORE INSERT ON region_decisions
WHEN NEW.version <> 1 + COALESCE((SELECT MAX(d.version) FROM region_decisions d WHERE d.network_id = NEW.network_id), 0)
  OR NEW.is_open = COALESCE((SELECT d.is_open FROM region_decisions d WHERE d.network_id = NEW.network_id AND d.region = NEW.region ORDER BY d.version DESC LIMIT 1), 0)
BEGIN SELECT RAISE(ABORT, 'region_decisions : version hors suite ou état inchangé'); END;
-- Une région ne s'ouvre jamais sans la phase 5 ouverte, même par une écriture directe [R651].
CREATE TRIGGER IF NOT EXISTS region_decisions_phase5 BEFORE INSERT ON region_decisions
WHEN NEW.is_open = 1 AND NOT EXISTS (SELECT 1 FROM phase_openings o WHERE o.network_id = NEW.network_id AND o.phase = 5 AND o.evidence_hash = NEW.phase5_hash)
BEGIN SELECT RAISE(ABORT, 'region_decisions : la phase 5 n''est pas ouverte'); END;
CREATE TRIGGER IF NOT EXISTS region_decisions_garde BEFORE DELETE ON region_decisions BEGIN SELECT RAISE(ABORT, 'region_decisions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS region_decisions_fige BEFORE UPDATE ON region_decisions BEGIN SELECT RAISE(ABORT, 'region_decisions : une décision ne change plus, une version s''ajoute'); END;
