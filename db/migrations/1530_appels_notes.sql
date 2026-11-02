-- AC09 · Les appels que l'agent note, pour compter la fréquence de la prospection par téléphone [R204].
-- Une ligne par appel noté, jamais effacée [R17]. Ni numéro, ni texte, ni nom : le fait, son heure et sa base [R13].
-- `basis` : ce qui ouvrait l'appel à ce moment-là, fixé par le serveur. Un appel sur demande de la personne ne compte pas.
CREATE TABLE IF NOT EXISTS call_notes (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('called', 'refused')),
  basis TEXT NOT NULL CHECK (basis IN ('prospecting', 'request')),
  noted_by TEXT NOT NULL,
  noted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS call_notes_person ON call_notes (person_id, noted_at);
