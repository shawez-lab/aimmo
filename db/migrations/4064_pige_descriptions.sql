-- AU035 · Ce qu'une annonce fermée dit d'elle quand elle est revue (M01, M02) [R672, R273, R17].
-- Une annonce fermée (« pas d'agence », non, trop reliée) n'entre jamais dans la file, mais ce qu'elle dit d'elle en
-- dernier compte pour le doute : seulement des empreintes, la clé de l'annonce sur son site, l'empreinte du bien sans
-- les pièces, et si elle dit ses pièces. Jamais un chiffre, un texte, ni rien du particulier.
-- Table nouvelle, en ajout seul : rien ne change ni ne s'efface.
CREATE TABLE IF NOT EXISTS pige_closed_descriptions (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  ref_key TEXT NOT NULL CHECK (length(ref_key) = 64),
  property_fingerprint TEXT NOT NULL CHECK (length(property_fingerprint) = 64),
  rooms_said INTEGER NOT NULL CHECK (rooms_said IN (0, 1)),
  noted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pige_closed_descriptions_ref ON pige_closed_descriptions (network_id, ref_key, noted_at);
CREATE TRIGGER IF NOT EXISTS pige_closed_descriptions_fige BEFORE UPDATE ON pige_closed_descriptions BEGIN SELECT RAISE(ABORT, 'pige_closed_descriptions : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS pige_closed_descriptions_garde BEFORE DELETE ON pige_closed_descriptions BEGIN SELECT RAISE(ABORT, 'pige_closed_descriptions : rien ne s''efface'); END;
