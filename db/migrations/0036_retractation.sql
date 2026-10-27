-- D05 · Rétractation et diffusion bloquée [R42].

-- La demande écrite du vendeur de commencer la diffusion avant la fin du délai de rétractation, avec sa preuve.
CREATE TABLE IF NOT EXISTS mandate_early_starts (
  mandate_id TEXT PRIMARY KEY REFERENCES mandates (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  proof TEXT NOT NULL CHECK (length(trim(proof)) BETWEEN 1 AND 300),
  received_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- La rétractation reçue du vendeur : le mandat s'arrête.
CREATE TABLE IF NOT EXISTS mandate_withdrawals (
  mandate_id TEXT PRIMARY KEY REFERENCES mandates (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  proof TEXT NOT NULL CHECK (length(trim(proof)) BETWEEN 1 AND 300),
  received_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS mandate_early_starts_fige BEFORE UPDATE ON mandate_early_starts BEGIN SELECT RAISE(ABORT, 'demande gardée'); END;
CREATE TRIGGER IF NOT EXISTS mandate_early_starts_garde BEFORE DELETE ON mandate_early_starts BEGIN SELECT RAISE(ABORT, 'demande gardée'); END;
CREATE TRIGGER IF NOT EXISTS mandate_withdrawals_fige BEFORE UPDATE ON mandate_withdrawals BEGIN SELECT RAISE(ABORT, 'rétractation gardée'); END;
CREATE TRIGGER IF NOT EXISTS mandate_withdrawals_garde BEFORE DELETE ON mandate_withdrawals BEGIN SELECT RAISE(ABORT, 'rétractation gardée'); END;
