-- K07 · Alertes de pilotage (M13) : budget de l'IA, baisse d'un indicateur, échéance d'un document d'agent [R18].
-- Les réglages se versionnent ; chaque alerte a sa clé (seuil et période), une seule fois. Rien ne change ni ne
-- s'efface [R17]. Aucune alerte ne note un agent : seulement des chiffres et des échéances [R14].
CREATE TABLE IF NOT EXISTS pilotage_settings (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  -- Le budget mensuel de l'IA, en centimes ; NULL : pas d'alerte de budget.
  ai_monthly_budget_cents INTEGER CHECK (ai_monthly_budget_cents IS NULL OR ai_monthly_budget_cents > 0),
  -- La part du budget qui déclenche l'alerte, en points de base (7 000 = 70 %).
  ai_alert_bp INTEGER NOT NULL CHECK (ai_alert_bp BETWEEN 1 AND 10000),
  -- La baisse d'un indicateur qui déclenche l'alerte, en points de base de la moyenne des 28 jours précédents.
  drop_alert_bp INTEGER NOT NULL CHECK (drop_alert_bp BETWEEN 1 AND 10000),
  -- Le nombre de jours avant l'échéance d'un document d'agent.
  document_notice_days INTEGER NOT NULL CHECK (document_notice_days BETWEEN 1 AND 365),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, version)
);
CREATE TABLE IF NOT EXISTS pilotage_alerts (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('budget_ia', 'baisse_indicateur', 'document_agent')),
  data TEXT NOT NULL CHECK (json_valid(data)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, key)
);
CREATE TRIGGER IF NOT EXISTS pilotage_settings_fige BEFORE UPDATE ON pilotage_settings BEGIN SELECT RAISE(ABORT, 'pilotage_settings : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS pilotage_settings_garde BEFORE DELETE ON pilotage_settings BEGIN SELECT RAISE(ABORT, 'pilotage_settings : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS pilotage_alerts_fige BEFORE UPDATE ON pilotage_alerts BEGIN SELECT RAISE(ABORT, 'pilotage_alerts : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS pilotage_alerts_garde BEFORE DELETE ON pilotage_alerts BEGIN SELECT RAISE(ABORT, 'pilotage_alerts : rien ne s''efface'); END;
