-- C02 · Rattacher chaque message reçu à la fiche de la personne : retrouver, sinon créer, sans doublon.
-- Uniquement des tables nouvelles, pour que le script se rejoue sans erreur. Rien n'est jamais effacé [R17].

-- Clés de contact : un identifiant normalisé (`phone:+33…`, `email:…`, `instagram:…`) ou un identifiant propre
-- au canal (`instagram:direct:<numéro>`, `site:site_chat:<session>`), et la fiche qui le porte.
-- La clé primaire fait que chaque clé n'appartient qu'à une fiche : si deux messages simultanés d'une même personne
-- inconnue créent chacun une fiche, le second voit la clé déjà prise et sa fiche est aussitôt fusionnée dans la
-- première (S04, réversible, rien n'est effacé). Une fiche est toujours créée avant de réserver ses clés.
-- Ces clés sont des coordonnées : elles restent dans la base, jamais dans un journal [R13].
CREATE TABLE IF NOT EXISTS contact_keys (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  key TEXT NOT NULL,
  person_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, key),
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS contact_keys_person ON contact_keys (person_id);

-- Journal du rattachement [R13], en ajout seul : identifiants internes et résultat, aucune donnée personnelle.
CREATE TABLE IF NOT EXISTS attach_log (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  inbound_id TEXT NOT NULL REFERENCES inbound_messages (id) ON DELETE RESTRICT,
  person_id TEXT,
  message_id TEXT REFERENCES messages (id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('created', 'matched', 'merged', 'ambiguous')),
  exclusion TEXT CHECK (exclusion IS NULL OR exclusion IN ('stop', 'refused', 'sold')),
  silenced INTEGER NOT NULL DEFAULT 0 CHECK (silenced IN (0, 1)),
  reason TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attach_log_inbound ON attach_log (inbound_id, occurred_at);
CREATE INDEX IF NOT EXISTS attach_log_person ON attach_log (person_id, occurred_at);
