-- J01 · Candidatures au réseau (M14) [R81, R18].
-- Un candidat n'est pas un client : il vit ici, jamais dans la fiche client.
-- Aucune colonne de note, de score, de rang ni de priorité : une candidature se lit dans l'ordre d'arrivée [R81, R14].
-- Une coordonnée ne fait qu'une candidature par réseau [R18]. Rien ne s'efface ni ne change [R17].
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  first_name TEXT NOT NULL CHECK (length(first_name) BETWEEN 1 AND 60),
  last_name TEXT CHECK (last_name IS NULL OR length(last_name) BETWEEN 1 AND 60),
  email TEXT CHECK (email IS NULL OR length(email) BETWEEN 3 AND 254),
  phone TEXT CHECK (phone IS NULL OR length(phone) BETWEEN 6 AND 20),
  town TEXT CHECK (town IS NULL OR length(town) BETWEEN 1 AND 80),
  current_status TEXT NOT NULL CHECK (current_status IN ('agent_commercial', 'salarie_immobilier', 'autre_metier', 'sans_emploi', 'etudiant', 'autre')),
  experience TEXT NOT NULL CHECK (experience IN ('aucune', 'moins_de_2_ans', 'de_2_a_5_ans', 'plus_de_5_ans')),
  question TEXT CHECK (question IS NULL OR length(question) BETWEEN 1 AND 1000),
  source TEXT NOT NULL CHECK (source IN ('video', 'podcast', 'page', 'parrain', 'autre')),
  sponsor_agent_id TEXT,
  contact_consent_at TEXT,
  contact_consent_proof TEXT CHECK (contact_consent_proof IS NULL OR length(contact_consent_proof) BETWEEN 1 AND 300),
  created_at TEXT NOT NULL,
  CHECK (email IS NOT NULL OR phone IS NOT NULL),
  CHECK ((contact_consent_at IS NULL) = (contact_consent_proof IS NULL)),
  FOREIGN KEY (sponsor_agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS candidates_arrival ON candidates (network_id, created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS candidates_email ON candidates (network_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS candidates_phone ON candidates (network_id, phone) WHERE phone IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS candidates_garde BEFORE DELETE ON candidates BEGIN SELECT RAISE(ABORT, 'candidates : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS candidates_fige BEFORE UPDATE ON candidates BEGIN SELECT RAISE(ABORT, 'candidates : une candidature rangée ne change plus'); END;
