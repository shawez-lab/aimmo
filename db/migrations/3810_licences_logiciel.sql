-- HX73 · La licence du logiciel aux agences hors réseau, à un seul tarif publié (Feuille de route, phase 5, « puis
-- licence du logiciel aux agences hors réseau » ; Offre aux agents, « Licence du logiciel ») [R654, R655, R656, R657].
-- Tables nouvelles, en ajout seul : rien ne change ni ne s'efface [R17].

-- Le tarif mensuel de la licence, un seul pour toutes les agences, par versions du réseau qui se suivent sans trou ;
-- la plus haute version vaut pour une licence nouvelle [R655].
CREATE TABLE IF NOT EXISTS licence_tariffs (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  monthly_cents INTEGER NOT NULL CHECK (monthly_cents BETWEEN 100 AND 10000000),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 200),
  decided_by TEXT NOT NULL CHECK (decided_by LIKE 'direction:%'),
  decided_at TEXT NOT NULL,
  PRIMARY KEY (network_id, version)
);
CREATE TRIGGER IF NOT EXISTS licence_tariffs_suite BEFORE INSERT ON licence_tariffs
WHEN NEW.version <> 1 + COALESCE((SELECT MAX(t.version) FROM licence_tariffs t WHERE t.network_id = NEW.network_id), 0)
BEGIN SELECT RAISE(ABORT, 'licence_tariffs : version hors suite'); END;
CREATE TRIGGER IF NOT EXISTS licence_tariffs_garde BEFORE DELETE ON licence_tariffs BEGIN SELECT RAISE(ABORT, 'licence_tariffs : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS licence_tariffs_fige BEFORE UPDATE ON licence_tariffs BEGIN SELECT RAISE(ABORT, 'licence_tariffs : un tarif ne change plus, une version s''ajoute'); END;

-- Une licence : une agence hors réseau, qui est son propre réseau dans AIMMO, jamais le réseau qui la donne ; une seule
-- licence par agence. Elle porte la version du tarif et son prix, recopié du tarif : la base refuse tout autre prix
-- [R655]. Elle porte l'empreinte de l'ouverture de la phase 5 : la base refuse une licence sans elle [R654].
CREATE TABLE IF NOT EXISTS software_licences (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  licensee_network_id TEXT NOT NULL UNIQUE REFERENCES networks (id) ON DELETE RESTRICT,
  agency_name TEXT NOT NULL CHECK (length(trim(agency_name)) BETWEEN 2 AND 120),
  siren TEXT NOT NULL CHECK (length(siren) = 9 AND ltrim(siren, '0123456789') = ''),
  card_number TEXT NOT NULL CHECK (card_number LIKE 'CPI %' AND length(card_number) BETWEEN 10 AND 34),
  card_expires_on TEXT NOT NULL CHECK (length(card_expires_on) = 10 AND substr(card_expires_on, 5, 1) = '-' AND substr(card_expires_on, 8, 1) = '-' AND ltrim(replace(card_expires_on, '-', ''), '0123456789') = ''),
  department TEXT NOT NULL CHECK (length(department) BETWEEN 2 AND 3),
  tariff_version INTEGER NOT NULL,
  monthly_cents INTEGER NOT NULL,
  phase5_hash TEXT NOT NULL CHECK (length(phase5_hash) = 64),
  granted_by TEXT NOT NULL CHECK (granted_by LIKE 'direction:%'),
  granted_at TEXT NOT NULL,
  CHECK (licensee_network_id <> network_id),
  UNIQUE (network_id, siren),
  FOREIGN KEY (network_id, tariff_version) REFERENCES licence_tariffs (network_id, version) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS software_licences_reseau ON software_licences (network_id, granted_at);
CREATE TRIGGER IF NOT EXISTS software_licences_prix BEFORE INSERT ON software_licences
WHEN NOT EXISTS (SELECT 1 FROM licence_tariffs t WHERE t.network_id = NEW.network_id AND t.version = NEW.tariff_version AND t.monthly_cents = NEW.monthly_cents)
  OR NEW.tariff_version <> (SELECT MAX(t.version) FROM licence_tariffs t WHERE t.network_id = NEW.network_id)
BEGIN SELECT RAISE(ABORT, 'software_licences : le prix n''est pas celui du tarif publié en vigueur'); END;
CREATE TRIGGER IF NOT EXISTS software_licences_phase5 BEFORE INSERT ON software_licences
WHEN NOT EXISTS (SELECT 1 FROM phase_openings o WHERE o.network_id = NEW.network_id AND o.phase = 5 AND o.evidence_hash = NEW.phase5_hash)
BEGIN SELECT RAISE(ABORT, 'software_licences : la phase 5 n''est pas ouverte'); END;
-- Une agence sous licence ne donne pas de licence, et un réseau qui en donne n'en reçoit pas [R657].
CREATE TRIGGER IF NOT EXISTS software_licences_sens BEFORE INSERT ON software_licences
WHEN EXISTS (SELECT 1 FROM software_licences l WHERE l.licensee_network_id = NEW.network_id)
  OR EXISTS (SELECT 1 FROM software_licences l WHERE l.network_id = NEW.licensee_network_id)
BEGIN SELECT RAISE(ABORT, 'software_licences : une agence sous licence ne donne pas de licence'); END;
CREATE TRIGGER IF NOT EXISTS software_licences_garde BEFORE DELETE ON software_licences BEGIN SELECT RAISE(ABORT, 'software_licences : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS software_licences_fige BEFORE UPDATE ON software_licences BEGIN SELECT RAISE(ABORT, 'software_licences : une licence ne change plus, un état s''ajoute'); END;

-- L'état d'une licence, par versions qui se suivent sans trou : elle naît active (sans ligne), puis se suspend, reprend
-- ou se termine, chaque fois avec une raison ; terminée, elle ne bouge plus [R656].
CREATE TABLE IF NOT EXISTS licence_states (
  licence_id TEXT NOT NULL REFERENCES software_licences (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  state TEXT NOT NULL CHECK (state IN ('active', 'suspendue', 'terminee')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 200),
  decided_by TEXT NOT NULL CHECK (decided_by LIKE 'direction:%'),
  decided_at TEXT NOT NULL,
  PRIMARY KEY (licence_id, version)
);
CREATE TRIGGER IF NOT EXISTS licence_states_suite BEFORE INSERT ON licence_states
WHEN NEW.version <> 1 + COALESCE((SELECT MAX(s.version) FROM licence_states s WHERE s.licence_id = NEW.licence_id), 0)
  OR NEW.state = COALESCE((SELECT s.state FROM licence_states s WHERE s.licence_id = NEW.licence_id ORDER BY s.version DESC LIMIT 1), 'active')
  OR EXISTS (SELECT 1 FROM licence_states s WHERE s.licence_id = NEW.licence_id AND s.state = 'terminee')
BEGIN SELECT RAISE(ABORT, 'licence_states : version hors suite, état inchangé ou licence terminée'); END;
CREATE TRIGGER IF NOT EXISTS licence_states_garde BEFORE DELETE ON licence_states BEGIN SELECT RAISE(ABORT, 'licence_states : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS licence_states_fige BEFORE UPDATE ON licence_states BEGIN SELECT RAISE(ABORT, 'licence_states : un état ne change plus, une version s''ajoute'); END;
