-- AU032 · Les autres clés d'un même message reçu (M02, C01) [R18, R669].
-- La demande d'un portail se range sous sa référence de demande ; le même mail a pu être rangé avant sous son
-- identifiant de mail, puis revenir sous un autre. Chaque clé connue d'un message rangé est gardée ici, pour que toute
-- relivraison, sous l'une ou l'autre, reste un doublon. Une clé ne désigne qu'un message ; rien ne s'efface ni ne change.
CREATE TABLE IF NOT EXISTS inbound_message_keys (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  dedup_key TEXT NOT NULL CHECK (length(dedup_key) BETWEEN 1 AND 1000),
  inbound_id TEXT NOT NULL REFERENCES inbound_messages (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS inbound_message_keys_inbound ON inbound_message_keys (inbound_id);
