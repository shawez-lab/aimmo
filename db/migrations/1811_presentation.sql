-- HX13 · Mode présentation pendant la visite. Table nouvelle, en ajout seul : rien ne change ni ne s'efface [R17].

-- Les notes que l'acquéreur donne à chaque pièce, d'un geste, à la fin de la visite : une seule fois par visite [R280].
-- Rejouées à l'identique, elles rendent la même réponse ; un autre contenu est refusé, jamais écrit par-dessus. Aucun nom,
-- aucun texte libre : seulement la clé de chaque pièce de la liste du bien et sa note, d'une liste fermée.
CREATE TABLE IF NOT EXISTS presentation_ratings (
  appointment_id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  ratings TEXT NOT NULL CHECK (json_valid(ratings)),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  recorded_by TEXT NOT NULL,
  rated_at TEXT NOT NULL,
  FOREIGN KEY (appointment_id, network_id) REFERENCES appointments (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS presentation_ratings_property ON presentation_ratings (network_id, property_id);
CREATE TRIGGER IF NOT EXISTS presentation_ratings_fige BEFORE UPDATE ON presentation_ratings BEGIN SELECT RAISE(ABORT, 'presentation_ratings : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS presentation_ratings_garde BEFORE DELETE ON presentation_ratings BEGIN SELECT RAISE(ABORT, 'presentation_ratings : rien ne s''efface'); END;
