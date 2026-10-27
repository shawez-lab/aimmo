-- P02 · Réglages des annonces d'un réseau : le numéro de carte professionnelle, mention obligatoire [R43].
-- Chaque réglage s'ajoute, le dernier compte ; rien ne change ni ne s'efface [R17].
CREATE TABLE IF NOT EXISTS listing_settings (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  card_number TEXT NOT NULL CHECK (length(trim(card_number)) BETWEEN 4 AND 40),
  set_by TEXT NOT NULL,
  set_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS listing_settings_network ON listing_settings (network_id, set_at);

CREATE TRIGGER IF NOT EXISTS listing_settings_sans_effacement
BEFORE DELETE ON listing_settings
BEGIN
  SELECT RAISE(ABORT, 'listing_settings : rien ne s''efface');
END;

CREATE TRIGGER IF NOT EXISTS listing_settings_fige
BEFORE UPDATE ON listing_settings
BEGIN
  SELECT RAISE(ABORT, 'listing_settings : un réglage rangé ne change plus');
END;
