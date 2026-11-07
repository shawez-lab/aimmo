-- HX11 · Pige des annonces de particuliers. Tables nouvelles, en ajout seul : rien ne change ni ne s'efface [R17].
-- Aucune donnée du particulier : ni nom, ni numéro, ni mail, ni texte de l'annonce ; seulement le bien et sa source
-- [R273, R13].

-- Un bien vu une fois « pas d'agence », sur n'importe quel site : son empreinte seule, pour qu'il n'entre jamais dans la
-- file, ni là ni ailleurs, et n'ait jamais de message [R273].
CREATE TABLE IF NOT EXISTS pige_no_agency (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  noted_at TEXT NOT NULL,
  PRIMARY KEY (network_id, fingerprint)
);
CREATE TRIGGER IF NOT EXISTS pige_no_agency_fige BEFORE UPDATE ON pige_no_agency BEGIN SELECT RAISE(ABORT, 'pige_no_agency : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS pige_no_agency_garde BEFORE DELETE ON pige_no_agency BEGIN SELECT RAISE(ABORT, 'pige_no_agency : rien ne s''efface'); END;

-- Une annonce de particulier, dans une commune d'une zone du réseau : le bien, sans adresse, et sa source.
CREATE TABLE IF NOT EXISTS pige_ads (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (length(source) BETWEEN 2 AND 60),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 120),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  kind TEXT NOT NULL CHECK (kind IN ('apartment', 'house')),
  commune TEXT NOT NULL CHECK (length(commune) BETWEEN 1 AND 80),
  postal_code TEXT NOT NULL CHECK (length(postal_code) = 5),
  surface_m2 INTEGER NOT NULL CHECK (surface_m2 BETWEEN 8 AND 2000),
  rooms INTEGER CHECK (rooms IS NULL OR rooms BETWEEN 1 AND 40),
  price_eur INTEGER NOT NULL CHECK (price_eur BETWEEN 1000 AND 50000000),
  published_at TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  UNIQUE (network_id, source, source_ref)
);
CREATE INDEX IF NOT EXISTS pige_ads_file ON pige_ads (network_id, commune, published_at);
CREATE INDEX IF NOT EXISTS pige_ads_fingerprint ON pige_ads (network_id, fingerprint);
-- Une annonce « pas d'agence » n'entre jamais [R273].
CREATE TRIGGER IF NOT EXISTS pige_ads_pas_agence
BEFORE INSERT ON pige_ads
WHEN EXISTS (SELECT 1 FROM pige_no_agency n WHERE n.network_id = NEW.network_id AND n.fingerprint = NEW.fingerprint)
BEGIN
  SELECT RAISE(ABORT, 'pige_ads : pas d''agence');
END;
CREATE TRIGGER IF NOT EXISTS pige_ads_fige BEFORE UPDATE ON pige_ads BEGIN SELECT RAISE(ABORT, 'pige_ads : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS pige_ads_garde BEFORE DELETE ON pige_ads BEGIN SELECT RAISE(ABORT, 'pige_ads : rien ne s''efface'); END;

-- Le particulier a dit non, ou stop : ce bien est fermé pour toujours, sur tous les canaux [R275, R04, R02].
CREATE TABLE IF NOT EXISTS pige_oppositions (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  noted_by TEXT NOT NULL,
  noted_at TEXT NOT NULL,
  PRIMARY KEY (network_id, fingerprint)
);
CREATE TRIGGER IF NOT EXISTS pige_oppositions_fige BEFORE UPDATE ON pige_oppositions BEGIN SELECT RAISE(ABORT, 'pige_oppositions : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS pige_oppositions_garde BEFORE DELETE ON pige_oppositions BEGIN SELECT RAISE(ABORT, 'pige_oppositions : rien ne s''efface'); END;

-- Le premier message, écrit par le code, une seule fois par bien [R275, R05]. Jamais envoyé par AIMMO.
CREATE TABLE IF NOT EXISTS pige_drafts (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  ad_id TEXT NOT NULL REFERENCES pige_ads (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 20 AND 1000),
  gap_pct INTEGER,
  market_source TEXT,
  market_last_sale TEXT,
  created_at TEXT NOT NULL,
  CHECK ((gap_pct IS NULL) = (market_source IS NULL) AND (gap_pct IS NULL) = (market_last_sale IS NULL)),
  UNIQUE (network_id, fingerprint),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS pige_drafts_ferme
BEFORE INSERT ON pige_drafts
WHEN EXISTS (SELECT 1 FROM pige_no_agency n WHERE n.network_id = NEW.network_id AND n.fingerprint = NEW.fingerprint)
  OR EXISTS (SELECT 1 FROM pige_oppositions o WHERE o.network_id = NEW.network_id AND o.fingerprint = NEW.fingerprint)
BEGIN
  SELECT RAISE(ABORT, 'pige_drafts : bien fermé');
END;
CREATE TRIGGER IF NOT EXISTS pige_drafts_fige BEFORE UPDATE ON pige_drafts BEGIN SELECT RAISE(ABORT, 'pige_drafts : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS pige_drafts_garde BEFORE DELETE ON pige_drafts BEGIN SELECT RAISE(ABORT, 'pige_drafts : rien ne s''efface'); END;

-- Le message validé par l'agent et remis à lui seul, à coller dans la messagerie de l'annonce : une fois [R275, R05].
CREATE TABLE IF NOT EXISTS pige_handovers (
  draft_id TEXT PRIMARY KEY REFERENCES pige_drafts (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel = 'annonce'),
  handed_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS pige_handovers_ferme
BEFORE INSERT ON pige_handovers
WHEN EXISTS (SELECT 1 FROM pige_drafts d JOIN pige_oppositions o ON o.network_id = d.network_id AND o.fingerprint = d.fingerprint WHERE d.id = NEW.draft_id)
  OR EXISTS (SELECT 1 FROM pige_drafts d JOIN pige_no_agency n ON n.network_id = d.network_id AND n.fingerprint = d.fingerprint WHERE d.id = NEW.draft_id)
  OR NOT EXISTS (SELECT 1 FROM pige_drafts d WHERE d.id = NEW.draft_id AND d.agent_id = NEW.agent_id)
BEGIN
  SELECT RAISE(ABORT, 'pige_handovers : bien fermé ou autre agent');
END;
CREATE TRIGGER IF NOT EXISTS pige_handovers_fige BEFORE UPDATE ON pige_handovers BEGIN SELECT RAISE(ABORT, 'pige_handovers : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS pige_handovers_garde BEFORE DELETE ON pige_handovers BEGIN SELECT RAISE(ABORT, 'pige_handovers : rien ne s''efface'); END;
