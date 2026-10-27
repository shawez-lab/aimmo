-- P03 · Annonces : brouillons proposés par l'IA, le code ou l'agent, puis validés par l'agent du bien [R47].
-- Chaque brouillon et chaque validation s'ajoutent ; rien ne change ni ne s'efface [R17].
CREATE TABLE IF NOT EXISTS listing_drafts (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  origin TEXT NOT NULL CHECK (origin IN ('ia', 'secours', 'agent')),
  -- La version de la fiche du bien sur laquelle le texte a été contrôlé.
  sheet_version INTEGER,
  -- Les phrases et leurs sources, en JSON : ce que l'agent voit avant de valider.
  trace TEXT NOT NULL CHECK (json_valid(trace)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (property_id, seq),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS listing_drafts_sans_effacement
BEFORE DELETE ON listing_drafts
BEGIN
  SELECT RAISE(ABORT, 'listing_drafts : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS listing_drafts_fige
BEFORE UPDATE ON listing_drafts
BEGIN
  SELECT RAISE(ABORT, 'listing_drafts : un brouillon rangé ne change plus');
END;

CREATE TABLE IF NOT EXISTS listing_validations (
  draft_id TEXT PRIMARY KEY REFERENCES listing_drafts (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  validated_by TEXT NOT NULL,
  validated_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS listing_validations_sans_effacement
BEFORE DELETE ON listing_validations
BEGIN
  SELECT RAISE(ABORT, 'listing_validations : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS listing_validations_fige
BEFORE UPDATE ON listing_validations
BEGIN
  SELECT RAISE(ABORT, 'listing_validations : une validation rangée ne change plus');
END;
