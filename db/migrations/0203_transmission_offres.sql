-- O03 · Transmission des offres au vendeur et réponse du vendeur, rapportée par l'agent avec sa preuve [R56, R57].
-- En ajout seul : une transmission, une réponse et une alerte par offre ; rien ne change ni ne s'efface [R17].
CREATE TABLE IF NOT EXISTS offer_transmissions (
  offer_id TEXT PRIMARY KEY REFERENCES offer_register (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  -- Par message (contrôle central, en essai), au téléphone ou en personne, attesté par l'agent.
  via TEXT NOT NULL CHECK (via IN ('message', 'telephone', 'en_personne')),
  message_id TEXT,
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  CHECK ((via = 'message') = (message_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS offer_responses (
  offer_id TEXT PRIMARY KEY REFERENCES offer_register (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('acceptee', 'refusee', 'contre_offre')),
  -- Référence de stockage de la preuve de la réponse du vendeur (écrit signé, mail, message).
  proof_ref TEXT NOT NULL,
  responded_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS offer_untransmitted_alerts (
  offer_id TEXT PRIMARY KEY REFERENCES offer_register (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS offer_transmissions_fige BEFORE UPDATE ON offer_transmissions BEGIN SELECT RAISE(ABORT, 'offer_transmissions : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS offer_transmissions_sans_effacement BEFORE DELETE ON offer_transmissions BEGIN SELECT RAISE(ABORT, 'offer_transmissions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS offer_responses_fige BEFORE UPDATE ON offer_responses BEGIN SELECT RAISE(ABORT, 'offer_responses : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS offer_responses_sans_effacement BEFORE DELETE ON offer_responses BEGIN SELECT RAISE(ABORT, 'offer_responses : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS offer_untransmitted_alerts_fige BEFORE UPDATE ON offer_untransmitted_alerts BEGIN SELECT RAISE(ABORT, 'offer_untransmitted_alerts : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS offer_untransmitted_alerts_sans_effacement BEFORE DELETE ON offer_untransmitted_alerts BEGIN SELECT RAISE(ABORT, 'offer_untransmitted_alerts : rien ne s''efface'); END;
