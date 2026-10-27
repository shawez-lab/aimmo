-- Q02 · Note et température d'un contact, une par qualification, par barème fixe. La raison tient en une ligne, sans
-- donnée personnelle [R24]. Rien n'est jamais effacé [R17].
CREATE TABLE IF NOT EXISTS contact_scores (
  qualification_id TEXT PRIMARY KEY REFERENCES qualifications (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  temperature TEXT NOT NULL CHECK (temperature IN ('cold', 'warm', 'hot')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contact_scores_hot ON contact_scores (network_id, temperature, created_at);

CREATE TRIGGER IF NOT EXISTS contact_scores_sans_effacement
BEFORE DELETE ON contact_scores
BEGIN
  SELECT RAISE(ABORT, 'contact_scores : rien ne s''efface');
END;
