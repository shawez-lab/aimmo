-- P04 · Publication des annonces, en mode essai : une version publiée unique, la même sur chaque canal [R44].
-- Versions et essais d'envoi s'ajoutent ; rien ne change ni ne s'efface [R17].
CREATE TABLE IF NOT EXISTS listing_versions (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  state TEXT NOT NULL CHECK (state IN ('en_vente', 'sous_offre', 'vendu', 'retiree')),
  -- Le brouillon validé publié ; null pour un retrait.
  draft_id TEXT REFERENCES listing_drafts (id) ON DELETE RESTRICT,
  price_eur INTEGER CHECK (price_eur IS NULL OR price_eur > 0),
  -- Ce que chaque canal reçoit, en JSON : titre, texte, mentions, prix, état. Jamais d'adresse ni de nom.
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  payload_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (property_id, seq),
  CHECK ((state = 'retiree') = (draft_id IS NULL)),
  CHECK ((state = 'retiree') = (price_eur IS NULL)),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS listing_versions_sans_effacement
BEFORE DELETE ON listing_versions
BEGIN
  SELECT RAISE(ABORT, 'listing_versions : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS listing_versions_fige
BEFORE UPDATE ON listing_versions
BEGIN
  SELECT RAISE(ABORT, 'listing_versions : une version publiée ne change plus');
END;

-- Chaque essai d'envoi d'une version à un canal. Un seul succès par version et par canal : jamais de doublon.
CREATE TABLE IF NOT EXISTS listing_pushes (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES listing_versions (id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('site', 'reseaux', 'google', 'portails')),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'echec')),
  error_code TEXT,
  at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS listing_pushes_un_succes ON listing_pushes (version_id, channel) WHERE outcome = 'ok';
CREATE INDEX IF NOT EXISTS listing_pushes_version ON listing_pushes (version_id, channel);

CREATE TRIGGER IF NOT EXISTS listing_pushes_sans_effacement
BEFORE DELETE ON listing_pushes
BEGIN
  SELECT RAISE(ABORT, 'listing_pushes : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS listing_pushes_fige
BEFORE UPDATE ON listing_pushes
BEGIN
  SELECT RAISE(ABORT, 'listing_pushes : un essai rangé ne change plus');
END;
