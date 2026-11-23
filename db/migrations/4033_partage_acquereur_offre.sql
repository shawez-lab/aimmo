-- AU081 · Le collègue qui suit un acquéreur autorise l'agent d'un bien à présenter l'offre de cet acquéreur, pour ce
-- seul bien, sans passer par la direction et sans lui ouvrir sa fiche [R16, R56].
--
-- Une ligne par autorisation : le bien, l'acquéreur (fiche gardée au moment du geste), l'agent qui l'a donnée et quand.
-- Le retrait ne fait que dater la ligne ; elle reste, et une offre déjà inscrite reste au registre [R17].
CREATE TABLE IF NOT EXISTS offer_buyer_shares (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  buyer_person_id TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT
);
CREATE INDEX IF NOT EXISTS offer_buyer_shares_bien ON offer_buyer_shares (property_id, buyer_person_id);
CREATE TRIGGER IF NOT EXISTS offer_buyer_shares_fige
BEFORE UPDATE ON offer_buyer_shares
WHEN OLD.revoked_at IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.property_id IS NOT OLD.property_id
  OR NEW.buyer_person_id IS NOT OLD.buyer_person_id OR NEW.granted_by IS NOT OLD.granted_by OR NEW.granted_at IS NOT OLD.granted_at
  OR NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL
BEGIN
  SELECT RAISE(ABORT, 'partage figé : seul le retrait se date, une fois');
END;
