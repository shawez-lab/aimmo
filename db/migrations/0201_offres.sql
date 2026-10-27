-- O01 · Offres écrites (M09). Le registre des offres d'un bien est l'offre elle-même : une ligne par offre reçue,
-- numérotée dans l'ordre d'arrivée, chaque ligne liée à la précédente par son empreinte [R56]. En ajout seul : rien
-- ne change ni ne s'efface [R17]. Le financement déclaré ne sert qu'à vérifier des montants, jamais à noter [R14].
CREATE TABLE IF NOT EXISTS offer_register (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  -- Rang de l'offre dans le registre du bien : 1, 2, 3… sans trou.
  seq INTEGER NOT NULL CHECK (seq >= 1),
  buyer_person_id TEXT NOT NULL,
  amount_eur INTEGER NOT NULL CHECK (amount_eur > 0),
  -- Conditions suspensives, en JSON, dans une liste fermée.
  conditions TEXT NOT NULL CHECK (json_valid(conditions)),
  -- Dernier jour de validité, à Paris (AAAA-MM-JJ).
  valid_until TEXT NOT NULL CHECK (length(valid_until) = 10),
  -- Financement déclaré par l'acquéreur : apport et prêt, en euros.
  down_payment_eur INTEGER NOT NULL CHECK (down_payment_eur >= 0),
  loan_eur INTEGER NOT NULL CHECK (loan_eur >= 0),
  -- Référence de stockage de l'offre signée.
  signed_ref TEXT NOT NULL,
  received_at TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  UNIQUE (property_id, seq),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (buyer_person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS offer_register_buyer ON offer_register (network_id, buyer_person_id);

CREATE TRIGGER IF NOT EXISTS offer_register_ligne_suivante
BEFORE INSERT ON offer_register
WHEN NEW.seq IS NOT (SELECT COALESCE(MAX(seq), 0) + 1 FROM offer_register WHERE property_id = NEW.property_id)
BEGIN
  SELECT RAISE(ABORT, 'registre des offres en ajout seul');
END;

CREATE TRIGGER IF NOT EXISTS offer_register_sans_modification
BEFORE UPDATE ON offer_register
BEGIN
  SELECT RAISE(ABORT, 'registre des offres en ajout seul');
END;

CREATE TRIGGER IF NOT EXISTS offer_register_sans_effacement
BEFORE DELETE ON offer_register
BEGIN
  SELECT RAISE(ABORT, 'registre des offres en ajout seul');
END;
