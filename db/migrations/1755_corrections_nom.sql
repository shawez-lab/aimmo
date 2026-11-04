-- SV10 · La direction corrige un nom sur une fiche : la valeur d'avant reste lisible par elle, ici et jamais au journal [R13, R17].
-- Pas de texte libre : le motif est dans une liste fermée. Une ligne ne change jamais ; elle reste effaçable, car elle porte
-- un nom : seule la procédure d'effacement de la Conformité y touche (plan d'effacement, carte des demandes d'accès).
CREATE TABLE IF NOT EXISTS person_name_corrections (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  old_first_name TEXT,
  old_last_name TEXT,
  new_first_name TEXT,
  new_last_name TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('faute_de_frappe', 'nom_dans_prenom', 'demande_de_la_personne', 'etat_civil')),
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS person_name_corrections_person ON person_name_corrections (person_id, created_at);
CREATE TRIGGER IF NOT EXISTS person_name_corrections_fige BEFORE UPDATE ON person_name_corrections BEGIN SELECT RAISE(ABORT, 'person_name_corrections : rien ne change'); END;

-- Tous les noms qu'une personne a portés : le nom en vigueur et ceux d'avant une correction. Les gardes qui retiennent un nom d'un
-- texte (R15, R19, R46, R161) lisent ici : un nom corrigé reste un nom, et ne doit pas sortir parce qu'il a changé. Une ligne effacée par
-- la procédure d'effacement sort d'ici avec elle.
CREATE VIEW IF NOT EXISTS person_known_names AS
  SELECT id, network_id, first_name, last_name FROM persons
  UNION
  SELECT person_id, network_id, old_first_name, old_last_name FROM person_name_corrections;
