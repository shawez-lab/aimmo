-- AU008 · Alerte de sécurité réelle, acquittée, escaladée. Une alerte n'est « prévenue » que sur l'accusé du service
-- d'envoi réel ; en essai, elle est dite « essai », jamais « prévenue ». Tant que personne de la direction ne l'acquitte,
-- elle monte d'un palier toutes les 5 minutes, jusqu'au palier 3, pendant l'heure qui suit le geste [R54].

ALTER TABLE safety_alerts ADD COLUMN level INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 3);
ALTER TABLE safety_alerts ADD COLUMN level_at TEXT;
-- Le mode du dernier envoi du palier : `reel` avec son accusé, `essai` sans rien qui parte.
ALTER TABLE safety_alerts ADD COLUMN mode TEXT CHECK (mode IS NULL OR mode IN ('essai', 'reel'));
ALTER TABLE safety_alerts ADD COLUMN receipt TEXT CHECK (receipt IS NULL OR length(receipt) BETWEEN 1 AND 200);
ALTER TABLE safety_alerts ADD COLUMN trial_at TEXT;
ALTER TABLE safety_alerts ADD COLUMN acknowledged_at TEXT;
ALTER TABLE safety_alerts ADD COLUMN acknowledged_by TEXT;

-- Avant AU008, seul l'essai était branché : une alerte marquée « prévenue » ne l'a jamais été réellement.
UPDATE safety_alerts SET mode = 'essai', trial_at = notified_at, notified_at = NULL WHERE notified_at IS NOT NULL AND receipt IS NULL;

-- Un accusé rangé ne change plus ; un palier ne redescend jamais.
CREATE TRIGGER IF NOT EXISTS safety_alerts_acquittee
BEFORE UPDATE ON safety_alerts
WHEN (OLD.acknowledged_at IS NOT NULL AND (NEW.acknowledged_at IS NOT OLD.acknowledged_at OR NEW.acknowledged_by IS NOT OLD.acknowledged_by))
  OR NEW.level < OLD.level
BEGIN
  SELECT RAISE(ABORT, 'acquittement gardé');
END;
