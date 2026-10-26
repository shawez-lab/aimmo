-- C04 · Ce que la première réponse dit d'un bien, en plus de sa fiche : quartier et atout principal.
-- Uniquement des tables nouvelles. Rien n'est jamais effacé [R17]. Ni adresse exacte ni nom du vendeur ici [R19].
CREATE TABLE IF NOT EXISTS property_details (
  property_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  neighborhood TEXT,
  highlight TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS property_details_sans_effacement
BEFORE DELETE ON property_details
BEGIN
  SELECT RAISE(ABORT, 'property_details : rien ne s''efface');
END;

-- Une seule première réponse par message reçu [R18] : la réservation est prise avant d'écrire, en une instruction.
-- Un envoi en panne libère sa réservation en changeant sa clé, sans effacer la ligne, pour un nouvel essai.
CREATE TABLE IF NOT EXISTS first_reply_claims (
  claim_key TEXT PRIMARY KEY,
  inbound_id TEXT NOT NULL REFERENCES inbound_messages (id) ON DELETE RESTRICT,
  claim_id TEXT NOT NULL,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('sent', 'refused', 'failed')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS first_reply_claims_inbound ON first_reply_claims (inbound_id);

CREATE TRIGGER IF NOT EXISTS first_reply_claims_sans_effacement
BEFORE DELETE ON first_reply_claims
BEGIN
  SELECT RAISE(ABORT, 'first_reply_claims : rien ne s''efface');
END;
