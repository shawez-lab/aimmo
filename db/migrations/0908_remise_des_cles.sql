-- W08 · Remise des clés, sans argent pour AIMMO ; gestion locative par un partenaire carte G (M15) [R107, R74, R73, R17].
-- Aucune table d'AIMMO ne reçoit un loyer ni un dépôt de garantie : la remise des clés déclare seulement qu'ils sont
-- versés directement au propriétaire, et la base refuse toute autre valeur.
CREATE TABLE IF NOT EXISTS rental_handovers (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL UNIQUE REFERENCES rental_listings (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL,
  lease_id TEXT NOT NULL REFERENCES rental_leases (id) ON DELETE RESTRICT,
  inventory_id TEXT NOT NULL REFERENCES rental_inventories (id) ON DELETE RESTRICT,
  handed_on TEXT NOT NULL,
  deposit_payee TEXT NOT NULL CHECK (deposit_payee = 'proprietaire'),
  first_rent_payee TEXT NOT NULL CHECK (first_rent_payee = 'proprietaire'),
  deposit_cents INTEGER NOT NULL CHECK (deposit_cents >= 0),
  first_rent_cents INTEGER NOT NULL CHECK (first_rent_cents >= 0),
  text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL CHECK (length(text_sha256) = 64),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS rental_handovers_garde BEFORE DELETE ON rental_handovers BEGIN SELECT RAISE(ABORT, 'rental_handovers : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_handovers_fige BEFORE UPDATE ON rental_handovers BEGIN SELECT RAISE(ABORT, 'rental_handovers : une remise des clés ne change plus'); END;

-- La gestion locative confiée par la mise en relation de M18 : l'accord du propriétaire et la carte G valide sont
-- vérifiés au moment du lien.
CREATE TABLE IF NOT EXISTS rental_management_links (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES rental_listings (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL,
  referral_id TEXT NOT NULL UNIQUE REFERENCES partner_referrals (id) ON DELETE RESTRICT,
  partner_id TEXT NOT NULL,
  linked_by TEXT NOT NULL,
  linked_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS rental_management_links_garde BEFORE DELETE ON rental_management_links BEGIN SELECT RAISE(ABORT, 'rental_management_links : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS rental_management_links_fige BEFORE UPDATE ON rental_management_links BEGIN SELECT RAISE(ABORT, 'rental_management_links : un lien ne change plus'); END;
