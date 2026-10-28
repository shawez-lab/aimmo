-- L03 · Identification et bénéficiaire effectif, étape bloquante [R17, R92].

-- Ce que l'agent déclare du client : personne physique ou société. La dernière déclaration compte ; aucune ne s'efface
-- ni ne change. Sans déclaration, le client est une personne physique.
CREATE TABLE IF NOT EXISTS client_identifications (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  entity TEXT NOT NULL CHECK (entity IN ('personne', 'societe')),
  -- Le nombre de bénéficiaires effectifs annoncés : une déclaration ne compte qu'une fois tous écrits.
  owners_count INTEGER NOT NULL CHECK (owners_count >= 0 AND (entity = 'societe' OR owners_count = 0)),
  declared_by TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS client_identifications_person ON client_identifications (network_id, person_id, declared_at);

-- Les bénéficiaires effectifs d'une société déclarée : chacun une fiche du réseau, à 25 % ou plus.
CREATE TABLE IF NOT EXISTS beneficial_owners (
  declaration_id TEXT NOT NULL REFERENCES client_identifications (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  owner_person_id TEXT NOT NULL,
  -- En centièmes de pour cent, en entier : 33,33 % s'écrit 3333.
  share_hundredths INTEGER NOT NULL CHECK (share_hundredths BETWEEN 2500 AND 10000),
  PRIMARY KEY (declaration_id, owner_person_id),
  FOREIGN KEY (owner_person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS client_identifications_sans_changement BEFORE UPDATE ON client_identifications BEGIN SELECT RAISE(ABORT, 'déclaration gardée'); END;
CREATE TRIGGER IF NOT EXISTS client_identifications_sans_effacement BEFORE DELETE ON client_identifications BEGIN SELECT RAISE(ABORT, 'déclaration gardée'); END;
CREATE TRIGGER IF NOT EXISTS beneficial_owners_sans_changement BEFORE UPDATE ON beneficial_owners BEGIN SELECT RAISE(ABORT, 'déclaration gardée'); END;
CREATE TRIGGER IF NOT EXISTS beneficial_owners_sans_effacement BEFORE DELETE ON beneficial_owners BEGIN SELECT RAISE(ABORT, 'déclaration gardée'); END;
