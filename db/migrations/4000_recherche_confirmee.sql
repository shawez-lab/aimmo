-- AU074 · L'acquéreur dit sa recherche toujours d'actualité : elle reste active au rapprochement sans changer de critère.
-- Une ligne par confirmation ; rien ne change ni ne s'efface [R17].
CREATE TABLE IF NOT EXISTS buyer_search_confirmations (
  project_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  confirmed_at TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,
  PRIMARY KEY (project_id, confirmed_at),
  FOREIGN KEY (project_id, network_id) REFERENCES projects (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS buyer_search_confirmations_fige BEFORE UPDATE ON buyer_search_confirmations BEGIN SELECT RAISE(ABORT, 'buyer_search_confirmations : rien ne se réécrit'); END;
CREATE TRIGGER IF NOT EXISTS buyer_search_confirmations_garde BEFORE DELETE ON buyer_search_confirmations BEGIN SELECT RAISE(ABORT, 'buyer_search_confirmations : rien ne s''efface'); END;
