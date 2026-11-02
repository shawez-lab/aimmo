-- AC08 · Une exclusion recopiée quand une fusion est défaite garde la trace de cette fusion [R02, R04, R17].
-- Un identifiant de fusion, jamais de motif ni de coordonnée [R13]. Vide pour une exclusion notée directement.
ALTER TABLE exclusions ADD COLUMN undone_merge_id TEXT REFERENCES person_merges (id) ON DELETE RESTRICT;
