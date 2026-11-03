-- IN02 · Le sceau d'un mois de la preuve à Dijon [R212, R17] : une chaîne par réseau, en ajout seul. Un mois corrigé
-- reçoit un nouveau sceau, l'ancien reste lisible. Aucune donnée personnelle : numéros du registre et empreintes.
CREATE TABLE IF NOT EXISTS proof_seals (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  counted INTEGER NOT NULL CHECK (counted >= 0),
  simple INTEGER NOT NULL CHECK (simple >= 0),
  exclusive INTEGER NOT NULL CHECK (exclusive >= 0),
  untyped INTEGER NOT NULL CHECK (untyped >= 0),
  terminated INTEGER NOT NULL CHECK (terminated >= 0),
  withdrawn INTEGER NOT NULL CHECK (withdrawn >= 0),
  cancelled_error INTEGER NOT NULL CHECK (cancelled_error >= 0),
  -- Les lignes qui comptent : `[numéro, empreinte de la ligne du registre]`, de quoi recalculer l'empreinte du mois.
  lines TEXT NOT NULL,
  lines_digest TEXT NOT NULL,
  sealed_at TEXT NOT NULL,
  sealed_by TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  PRIMARY KEY (network_id, seq),
  CHECK (counted = simple + exclusive + untyped)
);
CREATE INDEX IF NOT EXISTS proof_seals_month ON proof_seals (network_id, month, seq);

CREATE TRIGGER IF NOT EXISTS proof_seals_suivant
BEFORE INSERT ON proof_seals
WHEN NEW.seq IS NOT (SELECT COALESCE(MAX(seq), 0) + 1 FROM proof_seals WHERE network_id = NEW.network_id)
BEGIN
  SELECT RAISE(ABORT, 'sceaux en ajout seul');
END;
CREATE TRIGGER IF NOT EXISTS proof_seals_sans_modification BEFORE UPDATE ON proof_seals BEGIN SELECT RAISE(ABORT, 'sceaux en ajout seul'); END;
CREATE TRIGGER IF NOT EXISTS proof_seals_sans_effacement BEFORE DELETE ON proof_seals BEGIN SELECT RAISE(ABORT, 'sceaux en ajout seul'); END;

-- Ce que rend la page publique, recalculé au plus toutes les 5 minutes : une boucle de lectures anonymes ne relit pas le
-- registre. Une copie qui se recalcule, pas une donnée : `seals` dit combien de sceaux elle connaît, un sceau la périme.
CREATE TABLE IF NOT EXISTS proof_publication_cache (
  network_id TEXT PRIMARY KEY REFERENCES networks (id) ON DELETE RESTRICT,
  seals INTEGER NOT NULL,
  body TEXT NOT NULL,
  computed_at TEXT NOT NULL
);
