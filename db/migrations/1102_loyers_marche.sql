-- Y02 · Loyers de marché : une estimation lue dans la base, jamais écrite dans le code ni lue en direct sur Internet
-- [R122]. Chaque import de la direction est rangé avec sa source, son millésime et l'empreinte du fichier ; un import
-- plus récent s'ajoute, rien ne s'efface ni ne se réécrit [R17]. Un import n'est lu qu'une fois complet.
CREATE TABLE IF NOT EXISTS market_rent_imports (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source IN ('anil')),
  -- Le type de logement du fichier : la Carte des loyers en publie un par type.
  kind TEXT NOT NULL CHECK (kind IN ('apartment', 'apartment_t1_t2', 'apartment_t3_plus', 'house')),
  vintage INTEGER NOT NULL CHECK (vintage BETWEEN 2000 AND 2100),
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
  rows_count INTEGER NOT NULL CHECK (rows_count >= 1),
  status TEXT NOT NULL CHECK (status IN ('en_cours', 'complet')),
  imported_by TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (network_id, kind, file_sha256)
);
CREATE INDEX IF NOT EXISTS market_rent_imports_latest ON market_rent_imports (network_id, kind, status, vintage, imported_at);

-- Une ligne par commune : loyer au m² charges comprises, bornes de l'intervalle de prévision, en centimes ;
-- nombre d'observations de la commune.
CREATE TABLE IF NOT EXISTS market_rents (
  import_id TEXT NOT NULL REFERENCES market_rent_imports (id) ON DELETE RESTRICT,
  insee_code TEXT NOT NULL CHECK (length(insee_code) = 5),
  rent_m2_cents INTEGER NOT NULL CHECK (rent_m2_cents > 0),
  lower_m2_cents INTEGER NOT NULL CHECK (lower_m2_cents > 0 AND lower_m2_cents <= rent_m2_cents),
  upper_m2_cents INTEGER NOT NULL CHECK (upper_m2_cents >= rent_m2_cents),
  observations INTEGER NOT NULL CHECK (observations >= 0),
  PRIMARY KEY (import_id, insee_code)
);

CREATE TRIGGER IF NOT EXISTS market_rent_imports_garde BEFORE DELETE ON market_rent_imports
BEGIN
  SELECT RAISE(ABORT, 'market_rent_imports : rien ne s''efface');
END;
-- Seul passage permis : un import en cours devient complet, rien d'autre ne change.
CREATE TRIGGER IF NOT EXISTS market_rent_imports_fige BEFORE UPDATE ON market_rent_imports
WHEN NOT (OLD.status = 'en_cours' AND NEW.status = 'complet' AND OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL
  AND NEW.id = OLD.id AND NEW.network_id = OLD.network_id AND NEW.source = OLD.source AND NEW.kind = OLD.kind
  AND NEW.vintage = OLD.vintage AND NEW.file_sha256 = OLD.file_sha256 AND NEW.rows_count = OLD.rows_count
  AND NEW.imported_by = OLD.imported_by AND NEW.imported_at = OLD.imported_at)
BEGIN
  SELECT RAISE(ABORT, 'market_rent_imports : un import rangé ne change plus');
END;
CREATE TRIGGER IF NOT EXISTS market_rents_garde BEFORE DELETE ON market_rents
BEGIN
  SELECT RAISE(ABORT, 'market_rents : rien ne s''efface');
END;
CREATE TRIGGER IF NOT EXISTS market_rents_fige BEFORE UPDATE ON market_rents
BEGIN
  SELECT RAISE(ABORT, 'market_rents : un loyer rangé ne change plus');
END;
-- Une ligne ne s'ajoute qu'à un import en cours : un import complet ne grossit plus.
CREATE TRIGGER IF NOT EXISTS market_rents_ferme BEFORE INSERT ON market_rents
WHEN (SELECT status FROM market_rent_imports WHERE id = NEW.import_id) IS NOT 'en_cours'
BEGIN
  SELECT RAISE(ABORT, 'market_rents : import fermé');
END;
