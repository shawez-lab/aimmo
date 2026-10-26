-- C03 · Reconnaître le bien dont parle un message. Uniquement des tables nouvelles. Rien n'est jamais effacé [R17].

-- Correspondances vers un bien : publication ou vidéo (`post`, identifiant chez le canal), lien d'annonce (`url`,
-- adresse normalisée sans le protocole ni le « www »), référence d'un portail (`portal`, « <portail>:<référence> »).
-- La référence propre du bien est dans `properties.reference`. Une correspondance qui ne vaut plus est retirée
-- par une date, jamais effacée. Deux biens pour la même valeur : le message n'est attribué à aucun [R20].
CREATE TABLE IF NOT EXISTS property_links (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('post', 'url', 'portal')),
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  UNIQUE (network_id, kind, value, property_id),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS property_links_value ON property_links (network_id, kind, value);

CREATE TRIGGER IF NOT EXISTS property_links_sans_effacement
BEFORE DELETE ON property_links
BEGIN
  SELECT RAISE(ABORT, 'property_links : rien ne s''efface');
END;
