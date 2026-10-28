-- W02 · Honoraires du locataire et dépôt de garantie sous le plafond (M15) [R102, R17].
-- La zone de chaque commune est une donnée publique rangée avec sa source et sa date d'effet, jamais écrite dans le
-- code. Une commune sans zone connue prend le plafond le plus bas (8 € par m²).
CREATE TABLE IF NOT EXISTS rental_zones (
  insee_code TEXT NOT NULL CHECK (length(insee_code) = 5),
  zone TEXT NOT NULL CHECK (zone IN ('tres_tendue', 'tendue', 'autre')),
  effective_from TEXT NOT NULL,
  source TEXT NOT NULL CHECK (length(source) BETWEEN 3 AND 200),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (insee_code, effective_from)
);
CREATE TRIGGER IF NOT EXISTS rental_zones_garde BEFORE DELETE ON rental_zones BEGIN SELECT RAISE(ABORT, 'rental_zones : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_zones_fige BEFORE UPDATE ON rental_zones BEGIN SELECT RAISE(ABORT, 'rental_zones : une zone rangée ne change plus'); END;

-- La commune du logement, fixée une fois pour sa mise en location : la zone, donc le plafond, en vient toujours,
-- jamais d'une saisie au moment du barème [R102].
CREATE TABLE IF NOT EXISTS rental_listing_communes (
  listing_id TEXT PRIMARY KEY REFERENCES rental_listings (id) ON DELETE RESTRICT,
  insee_code TEXT NOT NULL CHECK (length(insee_code) = 5),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS rental_listing_communes_garde BEFORE DELETE ON rental_listing_communes BEGIN SELECT RAISE(ABORT, 'rental_listing_communes : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_listing_communes_fige BEFORE UPDATE ON rental_listing_communes BEGIN SELECT RAISE(ABORT, 'rental_listing_communes : la commune d''un logement ne change plus'); END;

-- Le barème d'une mise en location, par version : montants en centimes, plafonds calculés par le code et rangés avec
-- lui pour être relus tels qu'ils ont été décidés. La base refuse elle-même un dépassement [R102]. La part du locataire
-- ne dépasse celle du bailleur ni pour visite, dossier et bail, ni pour l'état des lieux, chacune comparée à la sienne.
CREATE TABLE IF NOT EXISTS rental_fees (
  listing_id TEXT NOT NULL REFERENCES rental_listings (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  facts_version INTEGER NOT NULL,
  insee_code TEXT NOT NULL CHECK (length(insee_code) = 5),
  zone TEXT NOT NULL CHECK (zone IN ('tres_tendue', 'tendue', 'autre', 'inconnue')),
  tenant_cents INTEGER NOT NULL CHECK (tenant_cents >= 0),
  tenant_inventory_cents INTEGER NOT NULL CHECK (tenant_inventory_cents >= 0),
  landlord_cents INTEGER NOT NULL CHECK (landlord_cents >= 0),
  landlord_inventory_cents INTEGER NOT NULL CHECK (landlord_inventory_cents >= 0),
  deposit_cents INTEGER NOT NULL CHECK (deposit_cents >= 0),
  tenant_ceiling_cents INTEGER NOT NULL,
  inventory_ceiling_cents INTEGER NOT NULL,
  deposit_ceiling_cents INTEGER NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (listing_id, version),
  FOREIGN KEY (listing_id, facts_version) REFERENCES rental_facts (listing_id, version) ON DELETE RESTRICT,
  CHECK (tenant_cents <= tenant_ceiling_cents),
  CHECK (tenant_inventory_cents <= inventory_ceiling_cents),
  CHECK (tenant_cents <= landlord_cents),
  CHECK (tenant_inventory_cents <= landlord_inventory_cents),
  CHECK (deposit_cents <= deposit_ceiling_cents)
);
CREATE TRIGGER IF NOT EXISTS rental_fees_garde BEFORE DELETE ON rental_fees BEGIN SELECT RAISE(ABORT, 'rental_fees : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_fees_fige BEFORE UPDATE ON rental_fees BEGIN SELECT RAISE(ABORT, 'rental_fees : un barème rangé ne change plus'); END;
