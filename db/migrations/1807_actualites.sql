-- HX09 · Actualités utiles, pas du bruit. Tables nouvelles, en ajout seul : rien ne change ni ne s'efface [R17].
-- Aucune donnée d'un client : une actualité est un texte de la direction, sa source est publique [R13].

-- Une actualité juridique ou de marché, rangée par la direction avec sa source (nom, adresse https, date) et la ligne
-- qui dit ce qu'elle change pour l'agent [R268]. Les dossiers concernés se lisent dans la base au moment de la montrer,
-- d'après une cible fermée (sortes de biens, codes postaux, moments du dossier, classes énergie, copropriété) [R269].
-- La même source n'est jamais rangée deux fois dans un réseau [R269].
CREATE TABLE IF NOT EXISTS network_news (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  topic TEXT NOT NULL CHECK (topic IN ('juridique', 'marche')),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 4 AND 140),
  impact TEXT NOT NULL CHECK (length(trim(impact)) BETWEEN 10 AND 200 AND instr(impact, char(10)) = 0 AND instr(impact, char(13)) = 0),
  source_name TEXT NOT NULL CHECK (length(trim(source_name)) BETWEEN 2 AND 80),
  source_url TEXT NOT NULL CHECK (source_url GLOB 'https://?*' AND length(source_url) <= 500),
  source_date TEXT NOT NULL CHECK (source_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  target TEXT NOT NULL CHECK (json_valid(target)),
  published_on TEXT NOT NULL CHECK (published_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL,
  UNIQUE (network_id, source_url)
);
CREATE INDEX IF NOT EXISTS network_news_recent ON network_news (network_id, published_on);
CREATE TRIGGER IF NOT EXISTS network_news_fige BEFORE UPDATE ON network_news BEGIN SELECT RAISE(ABORT, 'network_news : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS network_news_garde BEFORE DELETE ON network_news BEGIN SELECT RAISE(ABORT, 'network_news : rien ne s''efface'); END;

-- Le retrait d'une actualité par la direction (erreur, texte abrogé) : une fois, avec sa raison. Elle n'est plus montrée.
CREATE TABLE IF NOT EXISTS network_news_withdrawals (
  news_id TEXT PRIMARY KEY REFERENCES network_news (id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 2 AND 200),
  withdrawn_by TEXT NOT NULL,
  withdrawn_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS network_news_withdrawals_fige BEFORE UPDATE ON network_news_withdrawals BEGIN SELECT RAISE(ABORT, 'network_news_withdrawals : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS network_news_withdrawals_garde BEFORE DELETE ON network_news_withdrawals BEGIN SELECT RAISE(ABORT, 'network_news_withdrawals : rien ne s''efface'); END;

-- Une actualité montrée à un agent : une seule fois, jamais deux [R269]. La clé primaire le garantit même quand deux
-- écrans demandent le fil en même temps.
CREATE TABLE IF NOT EXISTS network_news_deliveries (
  news_id TEXT NOT NULL REFERENCES network_news (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  concerned INTEGER NOT NULL CHECK (concerned >= 0),
  shown_at TEXT NOT NULL,
  PRIMARY KEY (news_id, agent_id),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS network_news_deliveries_fige BEFORE UPDATE ON network_news_deliveries BEGIN SELECT RAISE(ABORT, 'network_news_deliveries : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS network_news_deliveries_garde BEFORE DELETE ON network_news_deliveries BEGIN SELECT RAISE(ABORT, 'network_news_deliveries : rien ne s''efface'); END;
