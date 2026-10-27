-- F01 · Recommandations : un client recommande un proche, qui arrive dans la fiche unique avec sa source [R66].
-- Aucune colonne de récompense : une recommandation n'est jamais rémunérée à un particulier. Rien ne s'efface [R17] ;
-- seule la tâche « appeler » se marque faite.
CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  -- La fiche du client qui recommande, et celle du proche (la fiche gardée au moment de la recommandation).
  referrer_id TEXT NOT NULL,
  referred_id TEXT NOT NULL,
  project_id TEXT,
  -- L'agent qui suit le proche : celui qui reçoit la tâche « appeler ».
  agent_id TEXT,
  -- Le proche accepte d'être appelé, selon le client qui recommande ; la preuve est rangée avec l'accord (consents).
  callable INTEGER NOT NULL CHECK (callable IN (0, 1)),
  call_due_at TEXT,
  call_done_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (referrer_id, referred_id),
  CHECK (referrer_id <> referred_id),
  CHECK (call_done_at IS NULL OR call_due_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS referrals_referred ON referrals (referred_id);
CREATE TRIGGER IF NOT EXISTS referrals_garde BEFORE DELETE ON referrals BEGIN SELECT RAISE(ABORT, 'recommandation gardée'); END;
CREATE TRIGGER IF NOT EXISTS referrals_fige
BEFORE UPDATE ON referrals
WHEN NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.referrer_id IS NOT OLD.referrer_id OR NEW.referred_id IS NOT OLD.referred_id
  OR NEW.project_id IS NOT OLD.project_id OR NEW.agent_id IS NOT OLD.agent_id OR NEW.callable IS NOT OLD.callable OR NEW.call_due_at IS NOT OLD.call_due_at
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at OR OLD.call_done_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'recommandation figée');
END;
