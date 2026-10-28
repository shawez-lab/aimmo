-- J07 · Bac à sable du premier parcours (M14) [R82, R16, R17].
-- Seule la progression vit dans la base du réseau : les contacts, biens et ventes inventés vivent dans une autre base.
CREATE TABLE IF NOT EXISTS sandbox_runs (
  agent_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  opened_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS sandbox_runs_garde BEFORE DELETE ON sandbox_runs BEGIN SELECT RAISE(ABORT, 'sandbox_runs : rien ne s''efface'); END;
-- Seule la fin du parcours s'écrit, une fois.
CREATE TRIGGER IF NOT EXISTS sandbox_runs_fige BEFORE UPDATE ON sandbox_runs
WHEN OLD.completed_at IS NOT NULL OR NEW.agent_id IS NOT OLD.agent_id OR NEW.network_id IS NOT OLD.network_id OR NEW.opened_at IS NOT OLD.opened_at
BEGIN SELECT RAISE(ABORT, 'sandbox_runs : seule la fin du parcours s''écrit, une fois'); END;

-- Chaque étape franchie, cochée par le code depuis le journal du bac à sable, une seule fois.
CREATE TABLE IF NOT EXISTS sandbox_steps (
  agent_id TEXT NOT NULL REFERENCES sandbox_runs (agent_id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  step TEXT NOT NULL CHECK (step IN ('contact_recu', 'qualification', 'rappel_fait', 'rendez_vous', 'avis_valide')),
  done_at TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, step)
);
CREATE TRIGGER IF NOT EXISTS sandbox_steps_garde BEFORE DELETE ON sandbox_steps BEGIN SELECT RAISE(ABORT, 'sandbox_steps : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS sandbox_steps_fige BEFORE UPDATE ON sandbox_steps BEGIN SELECT RAISE(ABORT, 'sandbox_steps : une étape cochée ne change plus'); END;
