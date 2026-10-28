-- K06 · Rapport du matin (M13) : un rapport par lecteur et par jour ouvré, rangé à 7 h 30, heure de Paris [R18, R68].
-- Les chiffres viennent des tableaux de bord (K04, K05) ; le texte est écrit par le code. Rien ne change ni ne
-- s'efface [R17].
CREATE TABLE IF NOT EXISTS morning_reports (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  -- `direction` pour la direction du réseau, `agent:<id>` pour un agent.
  reader TEXT NOT NULL,
  day TEXT NOT NULL,
  -- La période couverte : du jour ouvré précédent à la veille, à Paris.
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content)),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, reader, day)
);
CREATE TRIGGER IF NOT EXISTS morning_reports_fige BEFORE UPDATE ON morning_reports BEGIN SELECT RAISE(ABORT, 'morning_reports : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS morning_reports_garde BEFORE DELETE ON morning_reports BEGIN SELECT RAISE(ABORT, 'morning_reports : rien ne s''efface'); END;
