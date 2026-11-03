-- W19 · Chaque fichier déposé pour une candidature, joint ou non à son dossier [R95, R97, R13, R17].
-- Un dépôt refusé ensuite par le geste, ou dont la réponse s'est perdue, reste stocké sans ligne de pièce : le droit
-- d'accès et l'effacement ne le voyaient pas. La ligne est écrite avant le fichier : un fichier stocké a toujours la
-- sienne ; une panne du stockage laisse une ligne sans fichier, sans dommage. Ni contenu ni nom ici.
-- `person_id` : la personne à qui est le fichier, le candidat, ou le garant s'il est une personne ; un visa Visale est
-- au candidat, le seul à qui il parle. `holder` : 'candidat', ou l'identifiant du garant.
CREATE TABLE IF NOT EXISTS rental_piece_deposits (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES rental_applications (id) ON DELETE RESTRICT,
  holder TEXT NOT NULL,
  person_id TEXT NOT NULL,
  ref TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  size INTEGER NOT NULL CHECK (size > 0),
  deposited_by TEXT NOT NULL,
  deposited_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rental_piece_deposits_person ON rental_piece_deposits (person_id);
CREATE TRIGGER IF NOT EXISTS rental_piece_deposits_garde BEFORE DELETE ON rental_piece_deposits BEGIN SELECT RAISE(ABORT, 'rental_piece_deposits : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_piece_deposits_fige BEFORE UPDATE ON rental_piece_deposits BEGIN SELECT RAISE(ABORT, 'rental_piece_deposits : un dépôt rangé ne change plus'); END;
