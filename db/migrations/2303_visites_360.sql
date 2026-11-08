-- HX43 · Visite à 360 degrés avec contact (M07, M19). En ajout seul : rien ne s'efface ni ne se réécrit [R17].

-- Les vues d'une visite à 360 degrés, faite au téléphone : chaque vue est reliée à une pièce du plan du logement (X04),
-- dans la version du plan qu'elle cite ; une nouvelle saisie fait une nouvelle version [R499, R500].
-- Aucune image ici : la référence de stockage et l'empreinte de chaque vue, la pièce, et l'attestation de l'agent.
CREATE TABLE IF NOT EXISTS virtual_tours (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  tour_ref TEXT NOT NULL CHECK (length(tour_ref) BETWEEN 1 AND 200),
  version INTEGER NOT NULL CHECK (version >= 1),
  plan_version INTEGER NOT NULL CHECK (plan_version >= 1),
  views TEXT NOT NULL CHECK (length(views) >= 2),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (property_id, tour_ref, version),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, plan_version) REFERENCES floor_plans (property_id, version) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS virtual_tours_garde BEFORE DELETE ON virtual_tours BEGIN SELECT RAISE(ABORT, 'virtual_tours : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS virtual_tours_fige BEFORE UPDATE ON virtual_tours BEGIN SELECT RAISE(ABORT, 'virtual_tours : une version ne change plus'); END;

-- L'origine d'un contact pris dans la visite : le message reçu par C01 (rangé une seule fois, R18), la visite, sa
-- version et la vue d'où il est parti [R501]. Aucune donnée du visiteur ici : elles sont dans le message reçu.
CREATE TABLE IF NOT EXISTS virtual_tour_contacts (
  inbound_id TEXT PRIMARY KEY REFERENCES inbound_messages (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  tour_id TEXT NOT NULL REFERENCES virtual_tours (id) ON DELETE RESTRICT,
  view_ref TEXT NOT NULL CHECK (length(view_ref) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS virtual_tour_contacts_property ON virtual_tour_contacts (property_id, created_at);
CREATE TRIGGER IF NOT EXISTS virtual_tour_contacts_garde BEFORE DELETE ON virtual_tour_contacts BEGIN SELECT RAISE(ABORT, 'virtual_tour_contacts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS virtual_tour_contacts_fige BEFORE UPDATE ON virtual_tour_contacts BEGIN SELECT RAISE(ABORT, 'virtual_tour_contacts : rien ne se réécrit'); END;
