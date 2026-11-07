-- HX15 · Statistiques du site. Un compteur de vues par contenu public et par jour de Paris, rien d'autre : ni adresse
-- IP, ni navigateur, ni page d'arrivée, ni cookie, ni heure de la vue [R285, R156].
CREATE TABLE IF NOT EXISTS site_page_views (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  content_id TEXT NOT NULL REFERENCES public_contents (id) ON DELETE RESTRICT,
  day TEXT NOT NULL CHECK (length(day) = 10),
  views INTEGER NOT NULL CHECK (views >= 1),
  PRIMARY KEY (network_id, content_id, day)
);
-- Un compteur ne fait que monter, et rien ne s'efface [R17].
CREATE TRIGGER IF NOT EXISTS site_page_views_monte BEFORE UPDATE ON site_page_views
WHEN NEW.views < OLD.views OR NEW.network_id IS NOT OLD.network_id OR NEW.content_id IS NOT OLD.content_id OR NEW.day IS NOT OLD.day
BEGIN SELECT RAISE(ABORT, 'site_page_views : un compteur ne fait que monter'); END;
CREATE TRIGGER IF NOT EXISTS site_page_views_garde BEFORE DELETE ON site_page_views BEGIN SELECT RAISE(ABORT, 'site_page_views : rien ne s''efface'); END;
