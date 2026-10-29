-- L08 · Prospects à 3 ans et procédure de fuite [R17, R26, R97].

-- Un prospect arrivé à 3 ans après son dernier contact : la demande de consentement préparée (mode essai), le jour
-- où la réponse est attendue. Un cycle par dernier contact : si la personne revient puis se tait 3 ans de plus, un
-- nouveau cycle s'ouvre. En ajout seul.
CREATE TABLE IF NOT EXISTS prospect_retention_cycles (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  last_contact_at TEXT NOT NULL,
  reached_on TEXT NOT NULL CHECK (length(reached_on) = 10),
  listed_on TEXT NOT NULL CHECK (length(listed_on) = 10),
  answer_due_on TEXT NOT NULL CHECK (length(answer_due_on) = 10 AND answer_due_on > listed_on),
  request_mode TEXT NOT NULL CHECK (request_mode IN ('essai', 'reel')),
  created_at TEXT NOT NULL,
  UNIQUE (person_id, last_contact_at)
);
CREATE INDEX IF NOT EXISTS prospect_retention_cycles_network ON prospect_retention_cycles (network_id, answer_due_on);

-- La fin d'un cycle, une seule : contact repris, devenu client, ou effacement par la procédure de L07 (son plan par
-- sa seule empreinte, en essai tant que H29 n'est pas fait).
CREATE TABLE IF NOT EXISTS prospect_retention_outcomes (
  cycle_id TEXT PRIMARY KEY REFERENCES prospect_retention_cycles (id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('contact_repris', 'devenu_client', 'effacement')),
  mode TEXT NOT NULL CHECK (mode IN ('essai', 'reel')),
  plan_sha256 TEXT CHECK (plan_sha256 IS NULL OR length(plan_sha256) = 64),
  decided_on TEXT NOT NULL CHECK (length(decided_on) = 10),
  created_at TEXT NOT NULL,
  CHECK ((outcome = 'effacement') = (plan_sha256 IS NOT NULL))
);

-- Une violation de données (fuite) : le moment où le responsable en a eu connaissance et l'échéance de 72 heures
-- pour la CNIL, calculée par le code (RGPD, article 33). Aucun texte libre : rien de personnel n'y est écrit.
CREATE TABLE IF NOT EXISTS data_breaches (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  aware_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL CHECK (deadline_at > aware_at),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS data_breaches_network ON data_breaches (network_id, deadline_at);

-- L'évaluation saisie par le responsable, versionnée : risque, nature, catégories de données, personnes concernées.
CREATE TABLE IF NOT EXISTS data_breach_evaluations (
  breach_id TEXT NOT NULL REFERENCES data_breaches (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  risk TEXT NOT NULL CHECK (risk IN ('aucun', 'risque', 'eleve')),
  nature TEXT NOT NULL CHECK (json_valid(nature)),
  categories TEXT NOT NULL CHECK (json_valid(categories)),
  scope TEXT NOT NULL CHECK (scope IN ('reseau', 'agent', 'personnes')),
  agent_id TEXT,
  concerned_count INTEGER NOT NULL CHECK (concerned_count >= 0),
  persons_sha256 TEXT NOT NULL CHECK (length(persons_sha256) = 64),
  evaluated_by TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  PRIMARY KEY (breach_id, version),
  CHECK ((scope = 'agent') = (agent_id IS NOT NULL))
);

-- La liste des personnes concernées, figée à chaque évaluation (fiches gardées après fusion).
CREATE TABLE IF NOT EXISTS data_breach_persons (
  breach_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  PRIMARY KEY (breach_id, version, person_id),
  FOREIGN KEY (breach_id, version) REFERENCES data_breach_evaluations (breach_id, version) ON DELETE RESTRICT
);

-- Les accès coupés d'un geste : toutes les clés du réseau (sauf celles du responsable), ou celles d'une personne.
CREATE TABLE IF NOT EXISTS data_breach_cuts (
  id TEXT PRIMARY KEY,
  breach_id TEXT NOT NULL REFERENCES data_breaches (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  scope TEXT NOT NULL CHECK (scope IN ('tous', 'utilisateur')),
  user_id TEXT,
  keys_revoked INTEGER NOT NULL CHECK (keys_revoked >= 0),
  cut_by TEXT NOT NULL,
  cut_at TEXT NOT NULL,
  CHECK ((scope = 'utilisateur') = (user_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS data_breach_cuts_network ON data_breach_cuts (network_id);

-- Le rétablissement d'une coupure, une seule fois. Les clés retirées le restent : il faut une nouvelle invitation.
CREATE TABLE IF NOT EXISTS data_breach_restores (
  cut_id TEXT PRIMARY KEY REFERENCES data_breach_cuts (id) ON DELETE RESTRICT,
  restored_by TEXT NOT NULL,
  restored_at TEXT NOT NULL
);

-- Les notifications faites par le responsable (à la CNIL, aux personnes), une fois chacune, en retard ou non.
CREATE TABLE IF NOT EXISTS data_breach_notifications (
  breach_id TEXT NOT NULL REFERENCES data_breaches (id) ON DELETE RESTRICT,
  target TEXT NOT NULL CHECK (target IN ('cnil', 'personnes')),
  notified_at TEXT NOT NULL,
  late INTEGER NOT NULL CHECK (late IN (0, 1)),
  late_cause TEXT CHECK (late_cause IS NULL OR late_cause IN ('evaluation_en_cours', 'information_du_sous_traitant', 'autre')),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (breach_id, target),
  CHECK (late = 0 OR target <> 'cnil' OR late_cause IS NOT NULL)
);

-- Les alertes au responsable : dès la connaissance, 24 heures puis 6 heures avant l'échéance, puis à l'échéance.
CREATE TABLE IF NOT EXISTS data_breach_alerts (
  breach_id TEXT NOT NULL REFERENCES data_breaches (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('connaissance', 'h24', 'h6', 'echeance')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (breach_id, kind)
);

CREATE TRIGGER IF NOT EXISTS prospect_retention_cycles_sans_changement BEFORE UPDATE ON prospect_retention_cycles BEGIN SELECT RAISE(ABORT, 'cycle gardé'); END;
CREATE TRIGGER IF NOT EXISTS prospect_retention_cycles_sans_effacement BEFORE DELETE ON prospect_retention_cycles BEGIN SELECT RAISE(ABORT, 'cycle gardé'); END;
CREATE TRIGGER IF NOT EXISTS prospect_retention_outcomes_sans_changement BEFORE UPDATE ON prospect_retention_outcomes BEGIN SELECT RAISE(ABORT, 'fin de cycle gardée'); END;
CREATE TRIGGER IF NOT EXISTS prospect_retention_outcomes_sans_effacement BEFORE DELETE ON prospect_retention_outcomes BEGIN SELECT RAISE(ABORT, 'fin de cycle gardée'); END;
CREATE TRIGGER IF NOT EXISTS data_breaches_sans_changement BEFORE UPDATE ON data_breaches BEGIN SELECT RAISE(ABORT, 'fuite gardée'); END;
CREATE TRIGGER IF NOT EXISTS data_breaches_sans_effacement BEFORE DELETE ON data_breaches BEGIN SELECT RAISE(ABORT, 'fuite gardée'); END;
CREATE TRIGGER IF NOT EXISTS data_breach_evaluations_sans_changement BEFORE UPDATE ON data_breach_evaluations BEGIN SELECT RAISE(ABORT, 'évaluation gardée'); END;
CREATE TRIGGER IF NOT EXISTS data_breach_evaluations_sans_effacement BEFORE DELETE ON data_breach_evaluations BEGIN SELECT RAISE(ABORT, 'évaluation gardée'); END;
CREATE TRIGGER IF NOT EXISTS data_breach_persons_sans_changement BEFORE UPDATE ON data_breach_persons BEGIN SELECT RAISE(ABORT, 'liste gardée'); END;
CREATE TRIGGER IF NOT EXISTS data_breach_persons_sans_effacement BEFORE DELETE ON data_breach_persons BEGIN SELECT RAISE(ABORT, 'liste gardée'); END;
CREATE TRIGGER IF NOT EXISTS data_breach_cuts_sans_changement BEFORE UPDATE ON data_breach_cuts BEGIN SELECT RAISE(ABORT, 'coupure gardée'); END;
CREATE TRIGGER IF NOT EXISTS data_breach_cuts_sans_effacement BEFORE DELETE ON data_breach_cuts BEGIN SELECT RAISE(ABORT, 'coupure gardée'); END;
CREATE TRIGGER IF NOT EXISTS data_breach_restores_sans_changement BEFORE UPDATE ON data_breach_restores BEGIN SELECT RAISE(ABORT, 'rétablissement gardé'); END;
CREATE TRIGGER IF NOT EXISTS data_breach_restores_sans_effacement BEFORE DELETE ON data_breach_restores BEGIN SELECT RAISE(ABORT, 'rétablissement gardé'); END;
CREATE TRIGGER IF NOT EXISTS data_breach_notifications_sans_changement BEFORE UPDATE ON data_breach_notifications BEGIN SELECT RAISE(ABORT, 'notification gardée'); END;
CREATE TRIGGER IF NOT EXISTS data_breach_notifications_sans_effacement BEFORE DELETE ON data_breach_notifications BEGIN SELECT RAISE(ABORT, 'notification gardée'); END;
CREATE TRIGGER IF NOT EXISTS data_breach_alerts_sans_changement BEFORE UPDATE ON data_breach_alerts BEGIN SELECT RAISE(ABORT, 'alerte gardée'); END;
CREATE TRIGGER IF NOT EXISTS data_breach_alerts_sans_effacement BEFORE DELETE ON data_breach_alerts BEGIN SELECT RAISE(ABORT, 'alerte gardée'); END;
