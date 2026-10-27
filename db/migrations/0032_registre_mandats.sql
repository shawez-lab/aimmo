-- D01 · Registre des mandats : un registre par réseau, en ajout seul, chaque ligne liée à la précédente par son
-- empreinte [R39]. Rien ne s'efface ni ne se modifie [R17] : une erreur se corrige par une ligne d'annulation.

-- Le format du registre du réseau : préfixe, premier numéro, largeur du numéro. Réglé par la direction, une seule fois,
-- avant la première inscription (pendant la preuve, celui de l'agence : H23).
CREATE TABLE IF NOT EXISTS mandate_register_settings (
  network_id TEXT PRIMARY KEY REFERENCES networks (id) ON DELETE RESTRICT,
  prefix TEXT NOT NULL CHECK (length(prefix) <= 20),
  first_number INTEGER NOT NULL CHECK (first_number >= 1),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 10),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mandate_register (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  -- Rang de la ligne dans le registre du réseau : 1, 2, 3… sans trou.
  seq INTEGER NOT NULL CHECK (seq >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('inscription', 'annulation')),
  mandate_id TEXT NOT NULL REFERENCES mandates (id) ON DELETE RESTRICT,
  -- Le numéro du mandat : sa valeur et son texte, tel qu'il figure sur l'exemplaire du mandant.
  number_value INTEGER NOT NULL,
  number TEXT NOT NULL,
  -- Ce que la ligne fige du mandat à l'inscription, pour qu'une modification après coup se voie.
  agent_id TEXT NOT NULL,
  property_id TEXT,
  signed_at TEXT NOT NULL,
  -- Pour une annulation : la ligne annulée et la raison, dans une liste fermée.
  cancels_seq INTEGER,
  reason TEXT CHECK (reason IS NULL OR reason IN ('error', 'withdrawal', 'termination')),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  PRIMARY KEY (network_id, seq),
  CHECK ((kind = 'inscription' AND cancels_seq IS NULL AND reason IS NULL) OR (kind = 'annulation' AND cancels_seq IS NOT NULL AND reason IS NOT NULL))
);
-- Un mandat n'est inscrit qu'une fois, et ne reçoit qu'un numéro ; un numéro n'est donné qu'une fois.
CREATE UNIQUE INDEX IF NOT EXISTS mandate_register_inscription ON mandate_register (mandate_id) WHERE kind = 'inscription';
CREATE UNIQUE INDEX IF NOT EXISTS mandate_register_number ON mandate_register (network_id, number_value) WHERE kind = 'inscription';
CREATE UNIQUE INDEX IF NOT EXISTS mandate_register_cancel ON mandate_register (network_id, cancels_seq) WHERE kind = 'annulation';

CREATE TRIGGER IF NOT EXISTS mandate_register_ligne_suivante
BEFORE INSERT ON mandate_register
WHEN NEW.seq IS NOT (SELECT COALESCE(MAX(seq), 0) + 1 FROM mandate_register WHERE network_id = NEW.network_id)
BEGIN
  SELECT RAISE(ABORT, 'registre en ajout seul');
END;

CREATE TRIGGER IF NOT EXISTS mandate_register_sans_modification
BEFORE UPDATE ON mandate_register
BEGIN
  SELECT RAISE(ABORT, 'registre en ajout seul');
END;

CREATE TRIGGER IF NOT EXISTS mandate_register_sans_effacement
BEFORE DELETE ON mandate_register
BEGIN
  SELECT RAISE(ABORT, 'registre en ajout seul');
END;

CREATE TRIGGER IF NOT EXISTS mandate_register_settings_sans_effacement
BEFORE DELETE ON mandate_register_settings
BEGIN
  SELECT RAISE(ABORT, 'réglage du registre gardé');
END;

-- Le format ne change plus dès qu'un numéro a été donné.
CREATE TRIGGER IF NOT EXISTS mandate_register_settings_figes
BEFORE UPDATE ON mandate_register_settings
WHEN EXISTS (SELECT 1 FROM mandate_register WHERE network_id = OLD.network_id)
BEGIN
  SELECT RAISE(ABORT, 'registre déjà ouvert : format figé');
END;
