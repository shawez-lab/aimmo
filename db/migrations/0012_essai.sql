-- C06 · Mode essai de la captation : chaque réponse prête est rangée ici et écrite au journal, jamais envoyée.
-- Uniquement des tables nouvelles. Rien n'est jamais effacé [R17]. Le texte reste dans la fiche (messages) :
-- ni texte ni coordonnée ici [R13]. À la mise en service (C09), ces messages ne compteront pas comme partis.
CREATE TABLE IF NOT EXISTS trial_outbox (
  message_id TEXT PRIMARY KEY REFERENCES messages (id) ON DELETE RESTRICT,
  channel TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trial_outbox_sans_effacement
BEFORE DELETE ON trial_outbox
BEGIN
  SELECT RAISE(ABORT, 'trial_outbox : rien ne s''efface');
END;
