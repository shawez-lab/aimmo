-- Q01 · Qualification d'un contact : une par message reçu, et les corrections de l'agent. Rien n'est jamais
-- effacé [R17]. Seulement les champs prévus [R23] : aucun texte libre sur la personne, le texte reçu reste dans
-- inbound_messages. Le financement n'est rangé que déclaré [R24].
CREATE TABLE IF NOT EXISTS qualifications (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  inbound_id TEXT NOT NULL UNIQUE REFERENCES inbound_messages (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  project_id TEXT,
  category TEXT NOT NULL CHECK (category IN ('seller', 'buyer', 'valuation', 'rent_out', 'professional', 'partner', 'curious', 'spam')),
  route TEXT CHECK (route IS NULL OR route IN ('M15', 'M16', 'M17')),
  city TEXT,
  budget_min_eur INTEGER CHECK (budget_min_eur IS NULL OR budget_min_eur >= 0),
  budget_max_eur INTEGER CHECK (budget_max_eur IS NULL OR budget_max_eur >= 0),
  price_eur INTEGER CHECK (price_eur IS NULL OR price_eur >= 0),
  deadline TEXT CHECK (deadline IS NULL OR deadline IN ('now', 'within_3_months', 'within_6_months', 'within_1_year', 'later')),
  financing TEXT CHECK (financing IS NULL OR financing IN ('cash', 'loan_approved', 'loan_in_progress', 'loan_needed')),
  -- Liste JSON de critères pris dans une liste fermée.
  criteria TEXT NOT NULL DEFAULT '[]',
  property_id TEXT,
  -- `ai` : sortie de l'IA vérifiée ; `rules` : règles fixes.
  source TEXT NOT NULL CHECK (source IN ('ai', 'rules')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS qualifications_person ON qualifications (network_id, person_id, created_at);

-- La correction de l'agent : gardée telle quelle, elle devient un cas de test pour la mesure (Q05).
CREATE TABLE IF NOT EXISTS qualification_corrections (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  qualification_id TEXT NOT NULL REFERENCES qualifications (id) ON DELETE RESTRICT,
  actor TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('seller', 'buyer', 'valuation', 'rent_out', 'professional', 'partner', 'curious', 'spam')),
  route TEXT CHECK (route IS NULL OR route IN ('M15', 'M16', 'M17')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS qualification_corrections_of ON qualification_corrections (qualification_id, created_at);

CREATE TRIGGER IF NOT EXISTS qualifications_sans_effacement
BEFORE DELETE ON qualifications
BEGIN
  SELECT RAISE(ABORT, 'qualifications : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS qualification_corrections_sans_effacement
BEFORE DELETE ON qualification_corrections
BEGIN
  SELECT RAISE(ABORT, 'qualification_corrections : rien ne s''efface');
END;
