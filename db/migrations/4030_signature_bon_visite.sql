-- AU075 · Le bon d'une visite sur place se signe sans papier : sur le téléphone de l'agent, avec le code reçu par le
-- visiteur, ou à distance par un lien et un code ; le visiteur reçoit son exemplaire avec la preuve [R40, R03, R16].
--
-- Une ligne par ouverture de signature. Seules les empreintes du lien, du code, du tracé et du lien de l'exemplaire
-- sont gardées. La signature d'une visite faite à distance reste celle de HX44 (`remote_slip_signatures`).
CREATE TABLE IF NOT EXISTS visit_slip_signatures (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  appointment_id TEXT NOT NULL REFERENCES visits (appointment_id) ON DELETE RESTRICT,
  slip_id TEXT NOT NULL REFERENCES visit_slips (id) ON DELETE RESTRICT,
  slip_hash TEXT NOT NULL CHECK (length(slip_hash) = 64),
  place TEXT NOT NULL CHECK (place IN ('sur_place', 'distance')),
  channel TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
  token_hash TEXT UNIQUE CHECK (token_hash IS NULL OR length(token_hash) = 64),
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
  code_expires_at TEXT NOT NULL,
  link_expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  status TEXT NOT NULL CHECK (status IN ('ouverte', 'signee', 'bloquee', 'remplacee')),
  signed_at TEXT,
  drawing_hash TEXT,
  proof TEXT,
  copy_token_hash TEXT UNIQUE CHECK (copy_token_hash IS NULL OR length(copy_token_hash) = 64),
  copy_status TEXT CHECK (copy_status IS NULL OR copy_status IN ('remis', 'refuse')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((status = 'signee') = (signed_at IS NOT NULL AND proof IS NOT NULL AND copy_token_hash IS NOT NULL)),
  -- Un lien n'existe que pour la signature à distance ; sur place, le bon se lit sur le téléphone de l'agent.
  CHECK ((place = 'distance') = (token_hash IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS visit_slip_signatures_visit ON visit_slip_signatures (appointment_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS visit_slip_signatures_une_signee ON visit_slip_signatures (appointment_id) WHERE status = 'signee';
CREATE UNIQUE INDEX IF NOT EXISTS visit_slip_signatures_une_ouverte ON visit_slip_signatures (appointment_id) WHERE status = 'ouverte';
CREATE TRIGGER IF NOT EXISTS visit_slip_signatures_garde BEFORE DELETE ON visit_slip_signatures BEGIN SELECT RAISE(ABORT, 'visit_slip_signatures : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS visit_slip_signatures_fige
BEFORE UPDATE ON visit_slip_signatures
WHEN NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.appointment_id IS NOT OLD.appointment_id
  OR NEW.slip_id IS NOT OLD.slip_id OR NEW.slip_hash IS NOT OLD.slip_hash OR NEW.place IS NOT OLD.place OR NEW.channel IS NOT OLD.channel
  OR NEW.token_hash IS NOT OLD.token_hash OR NEW.code_hash IS NOT OLD.code_hash OR NEW.code_expires_at IS NOT OLD.code_expires_at
  OR NEW.link_expires_at IS NOT OLD.link_expires_at OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
  OR NEW.attempts < OLD.attempts
  -- Une signature close ne change plus, sauf l'issue de la remise de l'exemplaire, notée une fois.
  OR (OLD.status <> 'ouverte' AND (NEW.status IS NOT OLD.status OR NEW.signed_at IS NOT OLD.signed_at OR NEW.drawing_hash IS NOT OLD.drawing_hash
    OR NEW.proof IS NOT OLD.proof OR NEW.copy_token_hash IS NOT OLD.copy_token_hash OR NEW.attempts IS NOT OLD.attempts
    OR (OLD.copy_status IS NOT NULL AND NEW.copy_status IS NOT OLD.copy_status)))
BEGIN
  SELECT RAISE(ABORT, 'visit_slip_signatures : une signature close ne change plus');
END;
-- Le bon signé est celui de la visite, complet, pas encore signé, et la visite n'est pas une visite à distance.
CREATE TRIGGER IF NOT EXISTS visit_slip_signatures_bon_de_la_visite
BEFORE INSERT ON visit_slip_signatures
WHEN NOT EXISTS (SELECT 1 FROM visit_slips s WHERE s.id = NEW.slip_id AND s.appointment_id = NEW.appointment_id AND s.network_id = NEW.network_id AND s.status = 'complet' AND s.signed_at IS NULL)
  OR EXISTS (SELECT 1 FROM remote_visits r WHERE r.appointment_id = NEW.appointment_id)
BEGIN
  SELECT RAISE(ABORT, 'visit_slip_signatures : bon complet et non signé d''une visite sur place seulement');
END;
