-- AU058 · Le barème à tranches ou à forfaits : pour chaque tranche de prix, le plafond des honoraires, en taux du prix
-- ou en forfait. La dernière tranche peut rester ouverte (« au-delà »). Le taux maximal du barème vaut au-delà de la
-- dernière tranche fermée. Une tranche ne change plus ; un nouveau barème en écrit d'autres [R17].
CREATE TABLE IF NOT EXISTS fee_schedule_tiers (
  schedule_id TEXT NOT NULL REFERENCES fee_schedules (id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 10),
  up_to_eur INTEGER CHECK (up_to_eur IS NULL OR up_to_eur >= 1),
  rate_bp INTEGER CHECK (rate_bp IS NULL OR rate_bp BETWEEN 1 AND 10000),
  flat_eur INTEGER CHECK (flat_eur IS NULL OR flat_eur >= 0),
  CHECK ((rate_bp IS NULL) <> (flat_eur IS NULL)),
  PRIMARY KEY (schedule_id, position)
);
CREATE TRIGGER IF NOT EXISTS fee_schedule_tiers_garde BEFORE DELETE ON fee_schedule_tiers BEGIN SELECT RAISE(ABORT, 'fee_schedule_tiers : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS fee_schedule_tiers_fige BEFORE UPDATE ON fee_schedule_tiers BEGIN SELECT RAISE(ABORT, 'fee_schedule_tiers : rien ne se réécrit'); END;
