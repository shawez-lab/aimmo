-- P08 · Les vues d'une annonce par canal et par jour, telles que chaque canal les rapporte. Un seul relevé par bien,
-- canal et jour ; rien ne change ni ne s'efface [R17]. Aucune donnée sur les personnes : des nombres seulement.
CREATE TABLE IF NOT EXISTS listing_views (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('site', 'reseaux', 'google', 'portails')),
  day TEXT NOT NULL CHECK (length(day) = 10),
  views INTEGER NOT NULL CHECK (views >= 0),
  recorded_at TEXT NOT NULL,
  UNIQUE (property_id, channel, day),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS listing_views_sans_effacement
BEFORE DELETE ON listing_views
BEGIN
  SELECT RAISE(ABORT, 'listing_views : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS listing_views_fige
BEFORE UPDATE ON listing_views
BEGIN
  SELECT RAISE(ABORT, 'listing_views : un relevé rangé ne change plus');
END;
