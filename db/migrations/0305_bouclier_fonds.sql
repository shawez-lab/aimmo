-- N05 · Bouclier contre le faux RIB (M10). Une alerte par message reçu suspect [R18] : seules les sortes de signaux,
-- jamais le texte ni l'IBAN [R15]. Le rappel au client et son issue. Aucune table ne suit de fonds [R62]. Rien ne
-- s'efface [R17].
CREATE TABLE IF NOT EXISTS sale_file_fund_alerts (
  message_id TEXT PRIMARY KEY REFERENCES messages (id) ON DELETE RESTRICT,
  file_id TEXT NOT NULL REFERENCES sale_files (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('vendeur', 'acquereur')),
  signals TEXT NOT NULL CHECK (json_valid(signals)),
  created_at TEXT NOT NULL,
  reminder_status TEXT CHECK (reminder_status IS NULL OR reminder_status IN ('sent', 'waiting', 'refused', 'failed')),
  reminder_rule TEXT
);
CREATE INDEX IF NOT EXISTS sale_file_fund_alerts_file ON sale_file_fund_alerts (network_id, file_id, created_at);
CREATE TRIGGER IF NOT EXISTS sale_file_fund_alerts_sans_effacement BEFORE DELETE ON sale_file_fund_alerts BEGIN SELECT RAISE(ABORT, 'sale_file_fund_alerts : rien ne s''efface'); END;
-- Seule l'issue du rappel change, et une issue finale ne change plus.
CREATE TRIGGER IF NOT EXISTS sale_file_fund_alerts_fige BEFORE UPDATE ON sale_file_fund_alerts
WHEN NEW.message_id IS NOT OLD.message_id OR NEW.file_id IS NOT OLD.file_id OR NEW.signals IS NOT OLD.signals OR NEW.person_id IS NOT OLD.person_id
  OR NEW.agent_id IS NOT OLD.agent_id OR NEW.side IS NOT OLD.side OR NEW.created_at IS NOT OLD.created_at OR OLD.reminder_status IN ('sent', 'refused')
BEGIN SELECT RAISE(ABORT, 'sale_file_fund_alerts : rien ne change'); END;
