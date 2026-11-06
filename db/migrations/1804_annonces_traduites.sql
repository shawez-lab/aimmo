-- HX05 · Annonces dans plusieurs langues. Les langues que l'agent déclare parler : chaque déclaration est gardée, la
-- dernière fait foi ; rien ne change ni ne s'efface [R17].
CREATE TABLE IF NOT EXISTS agent_language_declarations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  languages TEXT NOT NULL CHECK (json_valid(languages) AND json_type(languages) = 'array'),
  declared_by TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  UNIQUE (agent_id, seq),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS agent_language_declarations_fige BEFORE UPDATE ON agent_language_declarations BEGIN SELECT RAISE(ABORT, 'agent_language_declarations : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS agent_language_declarations_garde BEFORE DELETE ON agent_language_declarations BEGIN SELECT RAISE(ABORT, 'agent_language_declarations : rien ne s''efface'); END;

-- La traduction d'une annonce française validée (un brouillon figé de `listing_drafts`), dans une langue de la liste
-- fermée. Chaque traduction est contrôlée avant d'être rangée [R257] ; une traduction rangée ne change plus.
CREATE TABLE IF NOT EXISTS listing_translations (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL REFERENCES listing_drafts (id) ON DELETE RESTRICT,
  language TEXT NOT NULL CHECK (language IN ('en', 'ur', 'hi', 'pa', 'fa', 'ar', 'el')),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  origin TEXT NOT NULL CHECK (origin IN ('ia', 'agent')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (property_id, language, seq),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS listing_translations_fige BEFORE UPDATE ON listing_translations BEGIN SELECT RAISE(ABORT, 'listing_translations : une traduction rangée ne change plus'); END;
CREATE TRIGGER IF NOT EXISTS listing_translations_garde BEFORE DELETE ON listing_translations BEGIN SELECT RAISE(ABORT, 'listing_translations : rien ne s''efface'); END;

-- La validation d'une traduction par l'agent du bien [R258] : une seule par traduction, jamais changée.
CREATE TABLE IF NOT EXISTS listing_translation_validations (
  translation_id TEXT PRIMARY KEY REFERENCES listing_translations (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  validated_by TEXT NOT NULL,
  validated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS listing_translation_validations_fige BEFORE UPDATE ON listing_translation_validations BEGIN SELECT RAISE(ABORT, 'listing_translation_validations : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS listing_translation_validations_garde BEFORE DELETE ON listing_translation_validations BEGIN SELECT RAISE(ABORT, 'listing_translation_validations : rien ne s''efface'); END;
