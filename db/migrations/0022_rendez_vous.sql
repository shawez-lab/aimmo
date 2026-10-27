-- V02 · Rendez-vous : disponibilités de l'agent, rendez-vous, et réservation des créneaux sans double réservation.
-- Rien ne s'efface : une annulation libère le créneau en marquant ses réservations, jamais en les supprimant.

-- Les disponibilités que l'agent fixe lui-même [R33] : plages par jour et exceptions, en JSON.
CREATE TABLE IF NOT EXISTS agent_availabilities (
  agent_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  availability TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  property_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('estimation', 'visite', 'signature', 'appel')),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL CHECK (end_at > start_at),
  status TEXT NOT NULL CHECK (status IN ('booked', 'cancelled', 'honored', 'absent')),
  -- Empreinte SHA-256 du jeton du lien pour décaler ou annuler ; le jeton lui-même n'est jamais gardé.
  token_hash TEXT NOT NULL UNIQUE,
  -- D'où vient la réservation : `site`, `assistant`, `espace`, `agent`.
  source TEXT NOT NULL,
  -- Le rendez-vous qu'il remplace, quand il a été décalé.
  replaces_id TEXT REFERENCES appointments (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancelled_at TEXT,
  UNIQUE (id, network_id),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS appointments_agent ON appointments (agent_id, status, start_at);
CREATE INDEX IF NOT EXISTS appointments_person ON appointments (person_id, start_at);

-- Les minutes tenues par chaque rendez-vous, par tranches de 5 minutes [R32] :
--   `own` : le rendez-vous lui-même, pour tous les types ;
--   `site` : le rendez-vous sur place, élargi de la moitié du temps de trajet de chaque côté.
-- Une tranche n'est tenue que par un rendez-vous à la fois : la réservation se fait en une seule instruction, qui
-- passe entière ou pas du tout. Une annulation marque `released_at`, la tranche redevient libre aussitôt.
CREATE TABLE IF NOT EXISTS appointment_holds (
  agent_id TEXT NOT NULL,
  layer TEXT NOT NULL CHECK (layer IN ('own', 'site')),
  unit INTEGER NOT NULL,
  appointment_id TEXT NOT NULL,
  released_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS appointment_holds_tenues ON appointment_holds (agent_id, layer, unit) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS appointment_holds_rdv ON appointment_holds (appointment_id);

CREATE TRIGGER IF NOT EXISTS appointments_sans_effacement
BEFORE DELETE ON appointments
BEGIN
  SELECT RAISE(ABORT, 'appointments : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS appointment_holds_sans_effacement
BEFORE DELETE ON appointment_holds
BEGIN
  SELECT RAISE(ABORT, 'appointment_holds : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS agent_availabilities_sans_effacement
BEFORE DELETE ON agent_availabilities
BEGIN
  SELECT RAISE(ABORT, 'agent_availabilities : rien ne s''efface');
END;
