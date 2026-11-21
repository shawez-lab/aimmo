-- AU092 · Grille à paliers : la part de l'agent suit son chiffre d'affaires cumulé de l'année civile (honoraires des
-- ventes déjà comptées, compromis à Paris). Chaque palier : le cumul à partir duquel il vaut, et son taux. Le palier
-- retenu pour une vente est rangé avec elle, une seule fois : le cumul lu, le palier, le taux [R17].
CREATE TABLE IF NOT EXISTS commission_grid_tiers (
  grid_id TEXT NOT NULL REFERENCES commission_grids (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  from_cents INTEGER NOT NULL CHECK (from_cents >= 0),
  rate_bp INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  PRIMARY KEY (grid_id, seq)
);
CREATE TRIGGER IF NOT EXISTS commission_grid_tiers_fige BEFORE UPDATE ON commission_grid_tiers BEGIN SELECT RAISE(ABORT, 'commission_grid_tiers : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS commission_grid_tiers_garde BEFORE DELETE ON commission_grid_tiers BEGIN SELECT RAISE(ABORT, 'commission_grid_tiers : rien ne s''efface'); END;

CREATE TABLE IF NOT EXISTS commission_tier_picks (
  file_id TEXT PRIMARY KEY REFERENCES commissions (file_id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  -- L'année civile du compromis, et le cumul des honoraires des ventes de l'agent déjà comptées cette année-là.
  year INTEGER NOT NULL,
  cumul_cents INTEGER NOT NULL CHECK (cumul_cents >= 0),
  tier_seq INTEGER NOT NULL CHECK (tier_seq >= 1),
  from_cents INTEGER NOT NULL CHECK (from_cents >= 0),
  rate_bp INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS commission_tier_picks_fige BEFORE UPDATE ON commission_tier_picks BEGIN SELECT RAISE(ABORT, 'commission_tier_picks : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS commission_tier_picks_garde BEFORE DELETE ON commission_tier_picks BEGIN SELECT RAISE(ABORT, 'commission_tier_picks : rien ne s''efface'); END;
