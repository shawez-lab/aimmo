-- I02 · Reprise des contacts existants. Uniquement des tables nouvelles. Rien n'est jamais effacé [R17].

-- Ce qui a déjà été repris, par clé d'origine (`site:compte:<id>`, `site:demande:<référence>`, `…:projet`, `…:source`) :
-- relancer la reprise retrouve la fiche ou le projet au lieu d'en créer un autre. Chaque clé n'est prise qu'une fois.
-- Ces clés restent dans la base, jamais dans un journal [R13].
CREATE TABLE IF NOT EXISTS import_keys (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  key TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('person', 'project', 'source')),
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, key)
);

CREATE TRIGGER IF NOT EXISTS import_keys_sans_modification
BEFORE UPDATE ON import_keys
BEGIN
  SELECT RAISE(ABORT, 'import_keys en ajout seul');
END;

CREATE TRIGGER IF NOT EXISTS import_keys_sans_effacement
BEFORE DELETE ON import_keys
BEGIN
  SELECT RAISE(ABORT, 'import_keys en ajout seul');
END;
