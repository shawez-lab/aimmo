-- HX17 · Score de vente par adresse. Tables nouvelles, en ajout seul : rien ne change ni ne s'efface [R17]. Aucune
-- colonne pour un nom, un numéro, un mail ou une adresse de propriétaire : il n'est jamais cherché [R291]. Aucune vente
-- d'une adresse n'est rangée : les ventes publiques ne sont lues qu'en compte du voisinage [R29, R37]. L'adresse notée
-- n'est lue que par l'agent de la zone et la direction, jamais au journal [R13, R292].

-- Un score d'une adresse, un jour : les points, chacun avec sa donnée publique, sa source et sa date, et l'empreinte
-- des données lues. Les mêmes données donnent le même score [R291]. Un seul par adresse et par jour dans le réseau.
CREATE TABLE IF NOT EXISTS address_scores (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  address_key TEXT NOT NULL CHECK (length(address_key) BETWEEN 3 AND 200),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 3 AND 200),
  postcode TEXT NOT NULL CHECK (length(postcode) = 5),
  commune TEXT NOT NULL CHECK (length(trim(commune)) BETWEEN 1 AND 80),
  commune_slug TEXT NOT NULL CHECK (length(commune_slug) BETWEEN 1 AND 80),
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  band TEXT NOT NULL CHECK (band IN ('faible', 'moyen', 'fort', 'tres_fort')),
  points TEXT NOT NULL CHECK (json_valid(points)),
  facts_hash TEXT NOT NULL CHECK (length(facts_hash) = 64),
  scored_on TEXT NOT NULL CHECK (length(scored_on) = 10),
  created_at TEXT NOT NULL,
  UNIQUE (network_id, address_key, scored_on),
  UNIQUE (id, network_id),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS address_scores_key ON address_scores (network_id, address_key, created_at);
CREATE TRIGGER IF NOT EXISTS address_scores_fige BEFORE UPDATE ON address_scores BEGIN SELECT RAISE(ABORT, 'address_scores : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS address_scores_garde BEFORE DELETE ON address_scores BEGIN SELECT RAISE(ABORT, 'address_scores : rien ne s''efface'); END;

-- Un mandat signé (G03, lu par G10) relié à une adresse notée, par l'agent du mandat : une fois par mandat, une fois
-- par adresse. C'est ce qui dit si le score marche [R293].
CREATE TABLE IF NOT EXISTS address_score_mandates (
  mandate_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  address_key TEXT NOT NULL,
  score_id TEXT NOT NULL,
  linked_by TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  UNIQUE (network_id, address_key),
  FOREIGN KEY (score_id, network_id) REFERENCES address_scores (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (mandate_id) REFERENCES mandates (id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS address_score_mandates_fige BEFORE UPDATE ON address_score_mandates BEGIN SELECT RAISE(ABORT, 'address_score_mandates : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS address_score_mandates_garde BEFORE DELETE ON address_score_mandates BEGIN SELECT RAISE(ABORT, 'address_score_mandates : rien ne s''efface'); END;
