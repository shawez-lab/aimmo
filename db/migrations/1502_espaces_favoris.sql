-- EC04 · Favoris de l'acquéreur dans son espace. Un favori ne déclenche aucun envoi [R49] : c'est une marque du client
-- sur un bien qui lui a été proposé. Un retrait est une ligne à part ; rien ne s'efface ni ne se réécrit [R17].
CREATE TABLE IF NOT EXISTS client_space_favorites (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS client_space_favorites_person ON client_space_favorites (network_id, person_id, property_id);

CREATE TABLE IF NOT EXISTS client_space_favorite_removals (
  favorite_id TEXT PRIMARY KEY REFERENCES client_space_favorites (id) ON DELETE RESTRICT,
  ended_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS client_space_favorites_garde BEFORE DELETE ON client_space_favorites
BEGIN
  SELECT RAISE(ABORT, 'client_space_favorites : rien ne s''efface');
END;
CREATE TRIGGER IF NOT EXISTS client_space_favorites_fige BEFORE UPDATE ON client_space_favorites
BEGIN
  SELECT RAISE(ABORT, 'client_space_favorites : un favori rangé ne change plus');
END;
CREATE TRIGGER IF NOT EXISTS client_space_favorite_removals_garde BEFORE DELETE ON client_space_favorite_removals
BEGIN
  SELECT RAISE(ABORT, 'client_space_favorite_removals : rien ne s''efface');
END;
CREATE TRIGGER IF NOT EXISTS client_space_favorite_removals_fige BEFORE UPDATE ON client_space_favorite_removals
BEGIN
  SELECT RAISE(ABORT, 'client_space_favorite_removals : un retrait ne change plus');
END;
