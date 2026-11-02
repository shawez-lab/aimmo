-- AC12 · Une note d'appel recopiée quand une fusion est défaite garde la trace de cette fusion [R204, R17].
-- Un identifiant de fusion, jamais de numéro ni de texte [R13]. Vide pour une note rangée directement.
ALTER TABLE call_notes ADD COLUMN undone_merge_id TEXT REFERENCES person_merges (id) ON DELETE RESTRICT;
