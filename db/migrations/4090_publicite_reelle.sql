-- AU038 · La vraie campagne de publicité, son accusé, ses échecs actionnables et les demandes qu'elle amène.
-- Rien ne change ni ne s'efface [R17]. Aucune personne ni aucun texte de message ici [R13, R156].

-- L'accusé de la plateforme au lancement : sa référence de la campagne et le mode dans lequel elle est partie. La
-- ligne de `ad_campaign_starts` reste le lancement tenu par la base ; celle-ci dit ce que la plateforme a répondu.
CREATE TABLE IF NOT EXISTS ad_campaign_receipts (
  approval_id TEXT PRIMARY KEY REFERENCES ad_campaign_starts (approval_id) ON DELETE RESTRICT,
  campaign_id TEXT NOT NULL REFERENCES ad_campaigns (id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('essai', 'reel')),
  external_ref TEXT NOT NULL CHECK (length(external_ref) BETWEEN 1 AND 200),
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ad_campaign_receipts_campaign ON ad_campaign_receipts (campaign_id);
CREATE TRIGGER IF NOT EXISTS ad_campaign_receipts_garde BEFORE DELETE ON ad_campaign_receipts BEGIN SELECT RAISE(ABORT, 'ad_campaign_receipts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS ad_campaign_receipts_fige BEFORE UPDATE ON ad_campaign_receipts BEGIN SELECT RAISE(ABORT, 'ad_campaign_receipts : un accusé ne change plus'); END;

-- L'échec d'un appel à la plateforme, en code fermé et en geste : chacun s'ajoute, le dernier fait foi [R587].
CREATE TABLE IF NOT EXISTS ad_campaign_failures (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES ad_campaigns (id) ON DELETE RESTRICT,
  step TEXT NOT NULL CHECK (step IN ('lancement', 'pause', 'depense')),
  code TEXT NOT NULL CHECK (code IN ('reconnecter', 'acces', 'refusee', 'lieu_inconnu', 'rayon', 'indisponible', 'inconnue')),
  action TEXT NOT NULL CHECK (action IN ('reconnecter', 'donner_acces', 'corriger', 'reessayer', 'verifier')),
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ad_campaign_failures_campaign ON ad_campaign_failures (campaign_id, at);
CREATE TRIGGER IF NOT EXISTS ad_campaign_failures_garde BEFORE DELETE ON ad_campaign_failures BEGIN SELECT RAISE(ABORT, 'ad_campaign_failures : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS ad_campaign_failures_fige BEFORE UPDATE ON ad_campaign_failures BEGIN SELECT RAISE(ABORT, 'ad_campaign_failures : rien ne se réécrit'); END;

-- Une demande arrivée par le lien d'une campagne (`?o=<code>`) : le message reçu et la campagne, jamais l'adresse
-- de la page ni le texte. Elle devient un contact de la campagne quand le message est rattaché à une fiche [R588].
CREATE TABLE IF NOT EXISTS ad_campaign_arrivals (
  inbound_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES ad_campaigns (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  arrived_at TEXT NOT NULL,
  -- La fiche rapprochée, une fois ; tant qu'elle manque, le passage planifié la cherche.
  matched_at TEXT,
  FOREIGN KEY (campaign_id, network_id) REFERENCES ad_campaigns (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS ad_campaign_arrivals_open ON ad_campaign_arrivals (network_id, matched_at);
CREATE TRIGGER IF NOT EXISTS ad_campaign_arrivals_garde BEFORE DELETE ON ad_campaign_arrivals BEGIN SELECT RAISE(ABORT, 'ad_campaign_arrivals : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS ad_campaign_arrivals_fige BEFORE UPDATE ON ad_campaign_arrivals
WHEN NOT (OLD.matched_at IS NULL AND NEW.matched_at IS NOT NULL AND NEW.inbound_id = OLD.inbound_id AND NEW.campaign_id = OLD.campaign_id
  AND NEW.network_id = OLD.network_id AND NEW.arrived_at = OLD.arrived_at)
BEGIN SELECT RAISE(ABORT, 'ad_campaign_arrivals : seul le rapprochement se range, une fois'); END;
