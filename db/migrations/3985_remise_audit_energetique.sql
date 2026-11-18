-- AU010b · L'audit énergétique remis à l'acquéreur dès la première visite (art. L126-28-1 du CCH) [R60, R73].

-- La remise de l'audit à un visiteur, rangée par l'agent de la visite : la date et le moyen qu'il déclare, jamais
-- une date inventée par le logiciel [R10] ; la version de l'audit remise quand le bien en a une. Une remise rangée ne
-- change plus et ne s'efface pas [R17] ; une seule par visite.
CREATE TABLE IF NOT EXISTS visit_energy_audit_handovers (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  appointment_id TEXT NOT NULL UNIQUE REFERENCES visits (appointment_id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  handed_on TEXT NOT NULL CHECK (length(handed_on) = 10),
  means TEXT NOT NULL CHECK (means IN ('papier', 'mail', 'espace')),
  -- Le document remis, quand le bien en a un au dossier : sa référence de stockage, jamais son contenu.
  audit_ref TEXT,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS visit_energy_audit_handovers_person ON visit_energy_audit_handovers (property_id, person_id);
CREATE TRIGGER IF NOT EXISTS visit_energy_audit_handovers_fige BEFORE UPDATE ON visit_energy_audit_handovers BEGIN SELECT RAISE(ABORT, 'visit_energy_audit_handovers : une remise rangée ne change plus'); END;
CREATE TRIGGER IF NOT EXISTS visit_energy_audit_handovers_garde BEFORE DELETE ON visit_energy_audit_handovers BEGIN SELECT RAISE(ABORT, 'visit_energy_audit_handovers : rien ne s''efface'); END;

-- La mention « audit énergétique » d'une certification DPE de diagnostiqueur, lue sur le certificat par la direction
-- quand elle le vérifie : sans elle, un diagnostiqueur ne fait pas l'audit réglementaire. Rangée avec la version du
-- justificatif qui la porte ; un renouvellement sans mention ne l'a pas [R73, R17].
CREATE TABLE IF NOT EXISTS partner_credential_mentions (
  credential_id TEXT NOT NULL REFERENCES partner_credentials (id) ON DELETE RESTRICT,
  mention TEXT NOT NULL CHECK (mention IN ('audit_energetique')),
  network_id TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (credential_id, mention)
);
CREATE TRIGGER IF NOT EXISTS partner_credential_mentions_fige BEFORE UPDATE ON partner_credential_mentions BEGIN SELECT RAISE(ABORT, 'partner_credential_mentions : une mention rangée ne change plus'); END;
CREATE TRIGGER IF NOT EXISTS partner_credential_mentions_garde BEFORE DELETE ON partner_credential_mentions BEGIN SELECT RAISE(ABORT, 'partner_credential_mentions : rien ne s''efface'); END;
