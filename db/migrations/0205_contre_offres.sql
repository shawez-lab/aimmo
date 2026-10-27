-- O04 · Contre-offres : la suite des propositions d'une offre, chacune transmise puis répondue, en ajout seul [R17, R57].
CREATE TABLE IF NOT EXISTS offer_proposals (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES offer_register (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  -- Rang dans la suite de l'offre : 1 est la contre-offre du vendeur, puis l'acquéreur, puis le vendeur…
  seq INTEGER NOT NULL CHECK (seq >= 1),
  side TEXT NOT NULL CHECK (side IN ('vendeur', 'acquereur')),
  amount_eur INTEGER NOT NULL CHECK (amount_eur > 0),
  valid_until TEXT NOT NULL CHECK (length(valid_until) = 10),
  proof_ref TEXT NOT NULL,
  created_by TEXT NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (offer_id, seq)
);
CREATE TABLE IF NOT EXISTS proposal_transmissions (
  proposal_id TEXT PRIMARY KEY REFERENCES offer_proposals (id) ON DELETE RESTRICT,
  via TEXT NOT NULL CHECK (via IN ('telephone', 'en_personne', 'ecrit')),
  at TEXT NOT NULL,
  by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS proposal_responses (
  proposal_id TEXT PRIMARY KEY REFERENCES offer_proposals (id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('acceptee', 'refusee', 'contre_offre')),
  proof_ref TEXT NOT NULL,
  responded_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS offer_proposals_fige BEFORE UPDATE ON offer_proposals BEGIN SELECT RAISE(ABORT, 'offer_proposals : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS offer_proposals_sans_effacement BEFORE DELETE ON offer_proposals BEGIN SELECT RAISE(ABORT, 'offer_proposals : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS proposal_transmissions_fige BEFORE UPDATE ON proposal_transmissions BEGIN SELECT RAISE(ABORT, 'proposal_transmissions : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS proposal_transmissions_sans_effacement BEFORE DELETE ON proposal_transmissions BEGIN SELECT RAISE(ABORT, 'proposal_transmissions : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS proposal_responses_fige BEFORE UPDATE ON proposal_responses BEGIN SELECT RAISE(ABORT, 'proposal_responses : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS proposal_responses_sans_effacement BEFORE DELETE ON proposal_responses BEGIN SELECT RAISE(ABORT, 'proposal_responses : rien ne s''efface'); END;
