-- HX07 · La boutique de l'agent. Tables nouvelles, en ajout seul : rien ne change ni ne s'efface [R17].
-- Ni nom, ni téléphone, ni adresse au journal [R13] ; le support garde seulement les coordonnées professionnelles de
-- l'agent et l'annonce publiée, qui n'en portent aucune d'un client.

-- Le tarif d'un support chez l'imprimeur, réglé par la direction depuis un devis : le prix d'une commande vient de lui
-- seul, jamais d'une saisie [R264]. Le dernier tarif d'un support et d'une quantité fait foi, jusqu'à sa date de fin.
CREATE TABLE IF NOT EXISTS shop_tariffs (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  support TEXT NOT NULL CHECK (support IN ('panneau', 'flyer', 'vitrine', 'carte')),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  printer TEXT NOT NULL CHECK (length(trim(printer)) BETWEEN 1 AND 80),
  source TEXT NOT NULL CHECK (length(trim(source)) BETWEEN 1 AND 200),
  valid_until TEXT NOT NULL CHECK (valid_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shop_tariffs_support ON shop_tariffs (network_id, support, quantity, set_at);
CREATE TRIGGER IF NOT EXISTS shop_tariffs_fige BEFORE UPDATE ON shop_tariffs BEGIN SELECT RAISE(ABORT, 'shop_tariffs : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS shop_tariffs_garde BEFORE DELETE ON shop_tariffs BEGIN SELECT RAISE(ABORT, 'shop_tariffs : rien ne s''efface'); END;

-- Une commande préparée : le support exact (HTML et empreinte), tiré de la version publiée de l'annonce, et le prix du
-- tarif en vigueur. Préparée, elle n'est ni commandée ni payée [R265].
CREATE TABLE IF NOT EXISTS shop_orders (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  property_id TEXT REFERENCES properties (id) ON DELETE RESTRICT,
  support TEXT NOT NULL CHECK (support IN ('panneau', 'flyer', 'vitrine', 'carte')),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  listing_version_id TEXT,
  target_url TEXT NOT NULL,
  html TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  tariff_id TEXT NOT NULL REFERENCES shop_tariffs (id) ON DELETE RESTRICT,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  prepared_by TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  CHECK ((support = 'carte') = (property_id IS NULL)),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS shop_orders_agent ON shop_orders (agent_id, prepared_at);
CREATE TRIGGER IF NOT EXISTS shop_orders_fige BEFORE UPDATE ON shop_orders BEGIN SELECT RAISE(ABORT, 'shop_orders : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS shop_orders_garde BEFORE DELETE ON shop_orders BEGIN SELECT RAISE(ABORT, 'shop_orders : rien ne s''efface'); END;

-- Le geste de l'agent qui commande : une fois par commande [R265].
CREATE TABLE IF NOT EXISTS shop_order_validations (
  order_id TEXT PRIMARY KEY REFERENCES shop_orders (id) ON DELETE RESTRICT,
  validated_by TEXT NOT NULL,
  validated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS shop_order_validations_fige BEFORE UPDATE ON shop_order_validations BEGIN SELECT RAISE(ABORT, 'shop_order_validations : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS shop_order_validations_garde BEFORE DELETE ON shop_order_validations BEGIN SELECT RAISE(ABORT, 'shop_order_validations : rien ne s''efface'); END;

-- L'envoi à l'imprimeur, réservé avant de partir : jamais deux envois d'une même commande. `outcome` reste NULL tant que
-- l'imprimeur n'a pas répondu ; la réponse est rangée une seule fois dans `shop_order_results`.
CREATE TABLE IF NOT EXISTS shop_order_sends (
  order_id TEXT PRIMARY KEY REFERENCES shop_order_validations (order_id) ON DELETE RESTRICT,
  printer TEXT NOT NULL,
  reserved_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS shop_order_sends_fige BEFORE UPDATE ON shop_order_sends BEGIN SELECT RAISE(ABORT, 'shop_order_sends : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS shop_order_sends_garde BEFORE DELETE ON shop_order_sends BEGIN SELECT RAISE(ABORT, 'shop_order_sends : rien ne s''efface'); END;

CREATE TABLE IF NOT EXISTS shop_order_results (
  order_id TEXT PRIMARY KEY REFERENCES shop_order_sends (order_id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('envoyee', 'echec')),
  printer_ref TEXT CHECK (printer_ref IS NULL OR length(printer_ref) BETWEEN 1 AND 120),
  at TEXT NOT NULL,
  CHECK ((outcome = 'envoyee') = (printer_ref IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS shop_order_results_fige BEFORE UPDATE ON shop_order_results BEGIN SELECT RAISE(ABORT, 'shop_order_results : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS shop_order_results_garde BEFORE DELETE ON shop_order_results BEGIN SELECT RAISE(ABORT, 'shop_order_results : rien ne s''efface'); END;
