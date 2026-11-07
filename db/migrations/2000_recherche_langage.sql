-- HX28 · Recherche de biens en langage courant. Table nouvelle, en ajout seul : rien ne s'efface [R17].
-- La phrase de la personne n'est jamais gardée : seulement les critères qui en sont tirés, chacun avec les quelques
-- mots qui le portent [R420], et l'accord qui a permis de les ranger dans la fiche acquéreur [R422].

-- Une recherche en langage courant rangée dans la fiche acquéreur (T01), une ligne par rangement. `criteria` : JSON
-- [{ field, value, strength: 'must' | 'nice', source: { kind: 'phrase', words } | { kind: 'refus', reason } |
-- { kind: 'voisine', of } }]. `buyer_search_id` : la version de la fiche créée, NULL si rien n'a changé.
CREATE TABLE IF NOT EXISTS phrase_searches (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  buyer_search_id TEXT REFERENCES buyer_searches (id) ON DELETE RESTRICT,
  consent_id TEXT NOT NULL REFERENCES consents (id) ON DELETE RESTRICT,
  criteria TEXT NOT NULL CHECK (json_valid(criteria)),
  saved_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id, network_id) REFERENCES projects (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS phrase_searches_project ON phrase_searches (project_id, created_at);

CREATE TRIGGER IF NOT EXISTS phrase_searches_fige BEFORE UPDATE ON phrase_searches
BEGIN
  SELECT RAISE(ABORT, 'phrase_searches : une recherche rangée ne change pas, une nouvelle s''ajoute');
END;
CREATE TRIGGER IF NOT EXISTS phrase_searches_sans_effacement BEFORE DELETE ON phrase_searches
BEGIN
  SELECT RAISE(ABORT, 'phrase_searches : rien ne s''efface');
END;
