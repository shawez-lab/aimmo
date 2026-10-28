-- W06 · Bail et annexes depuis les modèles (M15) [R101, R102, R105, R17].
-- Les modèles du bail suivent la règle de M06 (D02) : datés, versionnés, nés « essai », validés par la conformité
-- seule (H08) ; un modèle d'essai ne fait qu'un bail d'essai. Le bail garde la version et l'empreinte du modèle, ce qu'il
-- a vu (faits, barème, choix du propriétaire) et son propre contenu, figé.
CREATE TABLE IF NOT EXISTS rental_lease_templates (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('bail_vide', 'bail_meuble')),
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('essai', 'valide')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 50000),
  fields TEXT NOT NULL CHECK (json_valid(fields)),
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  validated_by TEXT,
  validated_at TEXT,
  UNIQUE (network_id, kind, version)
);
CREATE TRIGGER IF NOT EXISTS rental_lease_templates_garde BEFORE DELETE ON rental_lease_templates BEGIN SELECT RAISE(ABORT, 'rental_lease_templates : rien ne s''efface'); END;
-- Seul le passage d'« essai » à « validé » est permis, une fois ; le texte ne change jamais.
CREATE TRIGGER IF NOT EXISTS rental_lease_templates_fige BEFORE UPDATE ON rental_lease_templates
WHEN NOT (OLD.status = 'essai' AND NEW.status = 'valide' AND NEW.body = OLD.body AND NEW.hash = OLD.hash AND NEW.version = OLD.version AND NEW.kind = OLD.kind AND OLD.validated_at IS NULL AND NEW.validated_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'rental_lease_templates : un modèle rangé ne change plus'); END;

CREATE TABLE IF NOT EXISTS rental_leases (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES rental_listings (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  application_id TEXT NOT NULL REFERENCES rental_applications (id) ON DELETE RESTRICT,
  template_id TEXT NOT NULL REFERENCES rental_lease_templates (id) ON DELETE RESTRICT,
  template_version INTEGER NOT NULL,
  template_hash TEXT NOT NULL,
  facts_version INTEGER NOT NULL,
  fees_version INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('essai', 'reel')),
  status TEXT NOT NULL CHECK (status IN ('complet', 'incomplet')),
  missing TEXT NOT NULL CHECK (json_valid(missing)),
  -- Les annexes jointes, par leur sorte et leur référence de stockage : diagnostics de W01 et notice d'information.
  annexes TEXT NOT NULL CHECK (json_valid(annexes)),
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (listing_id, version)
);
CREATE TRIGGER IF NOT EXISTS rental_leases_garde BEFORE DELETE ON rental_leases BEGIN SELECT RAISE(ABORT, 'rental_leases : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_leases_fige BEFORE UPDATE ON rental_leases BEGIN SELECT RAISE(ABORT, 'rental_leases : un bail rangé ne change plus'); END;
