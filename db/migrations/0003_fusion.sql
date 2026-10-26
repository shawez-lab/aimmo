-- S04 · Fusion de deux fiches, réversible, sans rien effacer ni déplacer [R17].
-- Une fusion ne réécrit aucune ligne : chaque identifiant, accord, message reste sur sa fiche d'origine.
-- La fiche fusionnée pointe vers la fiche gardée tant que la fusion est active ; la défaire remplit undone_at.
-- (Le numéro 0002 est pris par le journal de S07.)

CREATE TABLE IF NOT EXISTS person_merges (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT,
  survivor_id TEXT NOT NULL,
  merged_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  merged_at TEXT NOT NULL,
  undone_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (survivor_id <> merged_id),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (survivor_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT,
  FOREIGN KEY (merged_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
-- Une fiche n'est fusionnée que dans une seule autre à la fois.
CREATE UNIQUE INDEX IF NOT EXISTS person_merges_active ON person_merges (merged_id) WHERE undone_at IS NULL;
CREATE INDEX IF NOT EXISTS person_merges_survivor ON person_merges (survivor_id, undone_at);
CREATE INDEX IF NOT EXISTS person_merges_network ON person_merges (network_id, undone_at);
