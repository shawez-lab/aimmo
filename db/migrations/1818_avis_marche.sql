-- HX32 · Avis de valeur enrichi : concurrence, loyer possible et marché de la commune. Tables nouvelles, en ajout seul :
-- rien ne change ni ne s'efface [R17]. Aucune donnée du particulier ni de concurrent : ni nom, ni adresse, ni numéro
-- [R305, R13].

-- Le jour où la pige a vu une annonce en ligne, même à un prix inchangé : pour dire depuis combien de jours elle est en
-- ligne et le jour de son relevé [R303]. Une ligne par annonce et par jour, au plus.
CREATE TABLE IF NOT EXISTS pige_ad_sightings (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (length(source) BETWEEN 2 AND 60),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 120),
  seen_on TEXT NOT NULL CHECK (length(seen_on) = 10),
  PRIMARY KEY (network_id, source, source_ref, seen_on)
);
CREATE TRIGGER IF NOT EXISTS pige_ad_sightings_fige BEFORE UPDATE ON pige_ad_sightings BEGIN SELECT RAISE(ABORT, 'pige_ad_sightings : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS pige_ad_sightings_garde BEFORE DELETE ON pige_ad_sightings BEGIN SELECT RAISE(ABORT, 'pige_ad_sightings : rien ne s''efface'); END;

-- Le relevé du marché joint à un avis encore en brouillon, par l'agent qui suit le bien : concurrents, loyer possible et
-- marché de la commune, chacun avec sa source et sa date. Une nouvelle relève ajoute une ligne ; la page imprimée lit
-- la dernière. Un avis validé ne reçoit plus rien : ce qui part est ce que l'agent a vu en validant [R306, R30].
CREATE TABLE IF NOT EXISTS valuation_market_snapshots (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  report_id TEXT NOT NULL REFERENCES valuation_reports (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  market TEXT NOT NULL CHECK (json_valid(market) AND json_type(market) = 'object'),
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
-- Un relevé par version de l'avis : deux relevés croisés ne partagent jamais une version [R306].
CREATE UNIQUE INDEX IF NOT EXISTS valuation_market_snapshots_report ON valuation_market_snapshots (report_id, created_at);
CREATE TRIGGER IF NOT EXISTS valuation_market_snapshots_brouillon
BEFORE INSERT ON valuation_market_snapshots
WHEN NOT EXISTS (SELECT 1 FROM valuation_reports r WHERE r.id = NEW.report_id AND r.network_id = NEW.network_id AND r.status = 'draft')
BEGIN
  SELECT RAISE(ABORT, 'valuation_market_snapshots : avis validé ou d''un autre réseau');
END;
CREATE TRIGGER IF NOT EXISTS valuation_market_snapshots_fige BEFORE UPDATE ON valuation_market_snapshots BEGIN SELECT RAISE(ABORT, 'valuation_market_snapshots : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS valuation_market_snapshots_garde BEFORE DELETE ON valuation_market_snapshots BEGIN SELECT RAISE(ABORT, 'valuation_market_snapshots : rien ne s''efface'); END;
