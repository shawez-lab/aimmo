-- G08 · Recommandations des partenaires, avec leur source et la preuve de l'accord de la personne recommandée (M20)
-- [R142, R66, R77, R17]. Aucune colonne de récompense. Une recommandation sans preuve d'accord n'est jamais rangée.
-- Rien ne s'efface ; seule la tâche « appeler » se marque faite.
CREATE TABLE IF NOT EXISTS partner_recommendations (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  partner_id TEXT NOT NULL REFERENCES partners (id) ON DELETE RESTRICT,
  -- La fiche gardée de la personne recommandée au moment de la recommandation.
  referred_id TEXT NOT NULL,
  project_id TEXT,
  -- Le prénom tel que le partenaire l'a saisi.
  first_name TEXT CHECK (first_name IS NULL OR length(first_name) BETWEEN 1 AND 60),
  -- L'agent qui reçoit la tâche « appeler » ; vide : la direction l'attribue.
  agent_id TEXT,
  -- La preuve de l'accord de la personne recommandée, toujours là [R142] : sa forme, son canal et sa date.
  consent_kind TEXT NOT NULL CHECK (consent_kind IN ('message_ecrit', 'appel_a_trois', 'formulaire_signe')),
  consent_channel TEXT NOT NULL CHECK (consent_channel IN ('email', 'phone', 'sms', 'whatsapp')),
  consent_given_at TEXT NOT NULL,
  -- Vide quand la personne est exclue ou a demandé l'arrêt : jamais rappelée [R02, R04].
  call_due_at TEXT,
  call_done_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (partner_id, referred_id),
  CHECK (call_done_at IS NULL OR call_due_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS partner_recommendations_agent ON partner_recommendations (network_id, agent_id, call_due_at);
CREATE INDEX IF NOT EXISTS partner_recommendations_referred ON partner_recommendations (referred_id);
CREATE TRIGGER IF NOT EXISTS partner_recommendations_garde BEFORE DELETE ON partner_recommendations BEGIN SELECT RAISE(ABORT, 'partner_recommendations : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS partner_recommendations_fige
BEFORE UPDATE ON partner_recommendations
WHEN NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.partner_id IS NOT OLD.partner_id OR NEW.referred_id IS NOT OLD.referred_id
  OR NEW.project_id IS NOT OLD.project_id OR NEW.first_name IS NOT OLD.first_name OR NEW.consent_kind IS NOT OLD.consent_kind
  OR NEW.consent_channel IS NOT OLD.consent_channel OR NEW.consent_given_at IS NOT OLD.consent_given_at OR NEW.call_due_at IS NOT OLD.call_due_at
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at OR OLD.call_done_at IS NOT NULL
  -- L'agent ne se donne qu'une fois, par la direction, à une recommandation qui n'en avait pas.
  OR (NEW.agent_id IS NOT OLD.agent_id AND (OLD.agent_id IS NOT NULL OR NEW.agent_id IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'partner_recommendations : une recommandation rangée ne change plus');
END;
