-- HX10 · Les clés des biens. Tables nouvelles, en ajout seul : rien ne change ni ne s'efface [R17].
-- Aucune donnée d'un client : un trousseau, son numéro, le bien et les agents qui l'ont eu [R13].

-- Un trousseau d'un bien, rangé dans l'armoire de l'agence avec son numéro, unique dans le réseau et donné par le code
-- [R270]. Son libellé dit ce qu'il ouvre (« porte d'entrée et cave »), jamais une adresse ni un code.
CREATE TABLE IF NOT EXISTS property_keys (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number >= 1),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 2 AND 80 AND instr(label, char(10)) = 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (network_id, number),
  UNIQUE (id, network_id),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS property_keys_property ON property_keys (network_id, property_id);
CREATE TRIGGER IF NOT EXISTS property_keys_fige BEFORE UPDATE ON property_keys BEGIN SELECT RAISE(ABORT, 'property_keys : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS property_keys_garde BEFORE DELETE ON property_keys BEGIN SELECT RAISE(ABORT, 'property_keys : rien ne s''efface'); END;

-- Une sortie du trousseau : à un agent du réseau, depuis telle heure, pour un rendez-vous du bien ou une autre raison
-- d'une liste fermée, avec l'heure où il doit revenir [R271]. Tant qu'elle n'a pas de retour, le trousseau est chez lui.
CREATE TABLE IF NOT EXISTS property_key_loans (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  holder_agent_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('visite', 'estimation', 'photos', 'diagnostic', 'travaux')),
  appointment_id TEXT,
  due_at TEXT NOT NULL,
  handed_by TEXT NOT NULL,
  out_at TEXT NOT NULL CHECK (due_at > out_at),
  CHECK ((purpose IN ('visite', 'estimation')) = (appointment_id IS NOT NULL)),
  FOREIGN KEY (key_id, network_id) REFERENCES property_keys (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (holder_agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (appointment_id, network_id) REFERENCES appointments (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS property_key_loans_key ON property_key_loans (key_id, out_at);
CREATE INDEX IF NOT EXISTS property_key_loans_holder ON property_key_loans (network_id, holder_agent_id, due_at);
-- Un trousseau n'est jamais chez deux personnes à la fois : une sortie n'entre que s'il est dans l'armoire [R271].
CREATE TRIGGER IF NOT EXISTS property_key_loans_un_seul
BEFORE INSERT ON property_key_loans
WHEN EXISTS (SELECT 1 FROM property_key_loans l WHERE l.key_id = NEW.key_id AND NOT EXISTS (SELECT 1 FROM property_key_returns r WHERE r.loan_id = l.id))
  OR EXISTS (SELECT 1 FROM property_key_retirements t WHERE t.key_id = NEW.key_id)
BEGIN
  SELECT RAISE(ABORT, 'property_key_loans : trousseau déjà sorti ou retiré');
END;
-- Pour une visite ou une estimation : un rendez-vous prévu, du même bien, de la même sorte, tenu par celui qui prend la clé.
CREATE TRIGGER IF NOT EXISTS property_key_loans_rendez_vous
BEFORE INSERT ON property_key_loans
WHEN NEW.appointment_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM appointments a JOIN property_keys k ON k.id = NEW.key_id
   WHERE a.id = NEW.appointment_id AND a.status = 'booked' AND a.agent_id = NEW.holder_agent_id AND a.property_id = k.property_id AND a.kind = NEW.purpose)
BEGIN
  SELECT RAISE(ABORT, 'property_key_loans : rendez-vous non valable');
END;
CREATE TRIGGER IF NOT EXISTS property_key_loans_fige BEFORE UPDATE ON property_key_loans BEGIN SELECT RAISE(ABORT, 'property_key_loans : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS property_key_loans_garde BEFORE DELETE ON property_key_loans BEGIN SELECT RAISE(ABORT, 'property_key_loans : rien ne s''efface'); END;

-- Le retour d'une sortie, une fois : rendu à l'armoire, ou perdu.
CREATE TABLE IF NOT EXISTS property_key_returns (
  loan_id TEXT PRIMARY KEY REFERENCES property_key_loans (id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('rendu', 'perdu')),
  recorded_by TEXT NOT NULL,
  returned_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS property_key_returns_fige BEFORE UPDATE ON property_key_returns BEGIN SELECT RAISE(ABORT, 'property_key_returns : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS property_key_returns_garde BEFORE DELETE ON property_key_returns BEGIN SELECT RAISE(ABORT, 'property_key_returns : rien ne s''efface'); END;

-- Le trousseau qui quitte l'armoire pour de bon : rendu au propriétaire, ou perdu. Il ne sort plus.
CREATE TABLE IF NOT EXISTS property_key_retirements (
  key_id TEXT PRIMARY KEY REFERENCES property_keys (id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason IN ('rendu_au_proprietaire', 'perdu')),
  retired_by TEXT NOT NULL,
  retired_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS property_key_retirements_fige BEFORE UPDATE ON property_key_retirements BEGIN SELECT RAISE(ABORT, 'property_key_retirements : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS property_key_retirements_garde BEFORE DELETE ON property_key_retirements BEGIN SELECT RAISE(ABORT, 'property_key_retirements : rien ne s''efface'); END;
-- Rendu au propriétaire seulement depuis l'armoire : un trousseau sorti revient d'abord, ou il est perdu.
CREATE TRIGGER IF NOT EXISTS property_key_retirements_armoire
BEFORE INSERT ON property_key_retirements
WHEN NEW.reason = 'rendu_au_proprietaire'
  AND EXISTS (SELECT 1 FROM property_key_loans l WHERE l.key_id = NEW.key_id AND NOT EXISTS (SELECT 1 FROM property_key_returns r WHERE r.loan_id = l.id))
BEGIN
  SELECT RAISE(ABORT, 'property_key_retirements : trousseau encore sorti');
END;
