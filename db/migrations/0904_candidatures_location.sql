-- W04 · Candidatures limitées aux pièces de la liste officielle (M15) [R104, R15, R14, R17].
-- Un candidat et chaque garant personne sont des personnes de la fiche client. Leur pièce d'identité ne vit qu'au
-- coffre de la conformité (L01) : ici, aucune pièce d'identité, aucun relevé ni coordonnée bancaire [R15, R90].
-- Ni note, ni rang, ni score : l'ordre d'arrivée seul [R14].
CREATE TABLE IF NOT EXISTS rental_applications (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES rental_listings (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  arrival INTEGER NOT NULL CHECK (arrival >= 1),
  dossierfacile_url TEXT,
  created_by TEXT NOT NULL,
  arrived_at TEXT NOT NULL,
  UNIQUE (listing_id, arrival),
  UNIQUE (listing_id, person_id)
);
CREATE TRIGGER IF NOT EXISTS rental_applications_garde BEFORE DELETE ON rental_applications BEGIN SELECT RAISE(ABORT, 'rental_applications : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_applications_fige BEFORE UPDATE ON rental_applications BEGIN SELECT RAISE(ABORT, 'rental_applications : une candidature rangée ne change plus'); END;

-- Les garants : une personne de la fiche, ou la garantie Visale.
CREATE TABLE IF NOT EXISTS rental_guarantors (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES rental_applications (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('personne', 'visale')),
  person_id TEXT,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  CHECK ((kind = 'personne') = (person_id IS NOT NULL)),
  UNIQUE (application_id, person_id)
);
CREATE TRIGGER IF NOT EXISTS rental_guarantors_garde BEFORE DELETE ON rental_guarantors BEGIN SELECT RAISE(ABORT, 'rental_guarantors : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_guarantors_fige BEFORE UPDATE ON rental_guarantors BEGIN SELECT RAISE(ABORT, 'rental_guarantors : un garant rangé ne change plus'); END;

-- Les pièces : une sorte de la liste officielle, sa référence de stockage et son empreinte, jamais son contenu.
-- `holder` : 'candidat', ou l'identifiant du garant.
CREATE TABLE IF NOT EXISTS rental_application_pieces (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES rental_applications (id) ON DELETE RESTRICT,
  holder TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('domicile', 'activite', 'ressources', 'garantie')),
  sort TEXT NOT NULL,
  ref TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rental_application_pieces_app ON rental_application_pieces (application_id, holder, category);
CREATE TRIGGER IF NOT EXISTS rental_application_pieces_garde BEFORE DELETE ON rental_application_pieces BEGIN SELECT RAISE(ABORT, 'rental_application_pieces : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_application_pieces_fige BEFORE UPDATE ON rental_application_pieces BEGIN SELECT RAISE(ABORT, 'rental_application_pieces : une pièce rangée ne change plus'); END;
-- Un seul justificatif de domicile par personne : la liste officielle n'en permet pas plus.
CREATE UNIQUE INDEX IF NOT EXISTS rental_application_pieces_un_domicile ON rental_application_pieces (application_id, holder) WHERE category = 'domicile';
