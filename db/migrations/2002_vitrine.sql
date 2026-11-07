-- HX31 · Écran de vitrine en agence. Tables nouvelles, en ajout seul : rien ne s'efface ni ne se réécrit [R17].

-- Un écran de vitrine : son code (12 caractères en base 32, tiré au hasard) sert d'adresse de l'écran et de marque
-- « vitrine » dans les liens de ses codes QR [R433]. Un écran d'agent ne montre que les biens de cet agent ; un écran
-- du réseau, tous les biens du réseau.
CREATE TABLE IF NOT EXISTS vitrine_screens (
  id TEXT PRIMARY KEY CHECK (length(id) = 12),
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT REFERENCES agents (id) ON DELETE RESTRICT,
  -- Le nom que la direction ou l'agent lui donne (« Vitrine rue principale ») : jamais montré à l'écran.
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  seconds_per_slide INTEGER NOT NULL CHECK (seconds_per_slide BETWEEN 6 AND 60),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vitrine_screens_network ON vitrine_screens (network_id, agent_id);
CREATE TRIGGER IF NOT EXISTS vitrine_screens_garde BEFORE DELETE ON vitrine_screens BEGIN SELECT RAISE(ABORT, 'vitrine_screens : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS vitrine_screens_fige BEFORE UPDATE ON vitrine_screens BEGIN SELECT RAISE(ABORT, 'vitrine_screens : rien ne se réécrit'); END;

-- Allumer ou éteindre un écran : chaque geste s'ajoute, le dernier compte.
CREATE TABLE IF NOT EXISTS vitrine_screen_switches (
  id TEXT PRIMARY KEY,
  screen_id TEXT NOT NULL REFERENCES vitrine_screens (id) ON DELETE RESTRICT,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  by_actor TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vitrine_screen_switches_screen ON vitrine_screen_switches (screen_id, at);
CREATE TRIGGER IF NOT EXISTS vitrine_screen_switches_garde BEFORE DELETE ON vitrine_screen_switches BEGIN SELECT RAISE(ABORT, 'vitrine_screen_switches : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS vitrine_screen_switches_fige BEFORE UPDATE ON vitrine_screen_switches BEGIN SELECT RAISE(ABORT, 'vitrine_screen_switches : rien ne se réécrit'); END;

-- Le contact venu d'un code QR de vitrine, une seule fois par message reçu : l'écran et le bien, rien d'autre [R434, R156].
CREATE TABLE IF NOT EXISTS contact_vitrines (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  inbound_id TEXT NOT NULL UNIQUE REFERENCES inbound_messages (id) ON DELETE RESTRICT,
  screen_id TEXT NOT NULL REFERENCES vitrine_screens (id) ON DELETE RESTRICT,
  property_id TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contact_vitrines_screen ON contact_vitrines (network_id, screen_id);
CREATE TRIGGER IF NOT EXISTS contact_vitrines_garde BEFORE DELETE ON contact_vitrines BEGIN SELECT RAISE(ABORT, 'contact_vitrines : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS contact_vitrines_fige BEFORE UPDATE ON contact_vitrines BEGIN SELECT RAISE(ABORT, 'contact_vitrines : rien ne se réécrit'); END;
