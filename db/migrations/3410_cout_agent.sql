-- HX65 · Le coût complet de l'agent moyen, couvert par la part du réseau (Feuille de route, phase 4 ; Offre aux
-- agents, « La règle de calcul » ; M13) [R623, R624, R625]. Tables nouvelles, en ajout seul : rien ne change ni ne
-- s'efface [R17].

-- Le poste d'une facture fournisseur rangée (HX49), dit par la direction seule, par versions : la plus haute vaut.
CREATE TABLE IF NOT EXISTS agent_cost_assignments (
  invoice_id TEXT NOT NULL REFERENCES supplier_invoices (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  category TEXT NOT NULL CHECK (category IN ('ia', 'clients_apportes', 'diffusion', 'accompagnement', 'conformite', 'hors_agents')),
  assigned_by TEXT NOT NULL CHECK (assigned_by LIKE 'direction:%'),
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (invoice_id, version)
);
CREATE INDEX IF NOT EXISTS agent_cost_assignments_network ON agent_cost_assignments (network_id);
-- La facture est du même réseau ; chaque version suit la précédente, sans trou [R623].
CREATE TRIGGER IF NOT EXISTS agent_cost_assignments_controle BEFORE INSERT ON agent_cost_assignments
WHEN NOT EXISTS (SELECT 1 FROM supplier_invoices i WHERE i.id = NEW.invoice_id AND i.network_id = NEW.network_id)
  OR NEW.version <> 1 + COALESCE((SELECT MAX(a.version) FROM agent_cost_assignments a WHERE a.invoice_id = NEW.invoice_id), 0)
BEGIN SELECT RAISE(ABORT, 'agent_cost_assignments : autre réseau ou version hors suite'); END;
CREATE TRIGGER IF NOT EXISTS agent_cost_assignments_garde BEFORE DELETE ON agent_cost_assignments BEGIN SELECT RAISE(ABORT, 'agent_cost_assignments : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_cost_assignments_fige BEFORE UPDATE ON agent_cost_assignments BEGIN SELECT RAISE(ABORT, 'agent_cost_assignments : un classement ne change plus, une version s''ajoute'); END;

-- Les réglages du calcul, par versions datées : la provision pour l'indemnité de fin de contrat, en points de base des
-- parts encaissées des agents, et la marge, en points de base du coût complet. La version la plus haute dont le
-- premier mois est atteint vaut pour un mois [R624].
CREATE TABLE IF NOT EXISTS agent_cost_settings (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  valid_from TEXT NOT NULL CHECK (valid_from GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  provision_bp INTEGER NOT NULL CHECK (provision_bp BETWEEN 0 AND 10000),
  margin_bp INTEGER NOT NULL CHECK (margin_bp BETWEEN 0 AND 10000),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 200),
  set_by TEXT NOT NULL CHECK (set_by LIKE 'direction:%'),
  set_at TEXT NOT NULL,
  PRIMARY KEY (network_id, version)
);
CREATE TRIGGER IF NOT EXISTS agent_cost_settings_suite BEFORE INSERT ON agent_cost_settings
WHEN NEW.version <> 1 + COALESCE((SELECT MAX(s.version) FROM agent_cost_settings s WHERE s.network_id = NEW.network_id), 0)
BEGIN SELECT RAISE(ABORT, 'agent_cost_settings : version hors suite'); END;
CREATE TRIGGER IF NOT EXISTS agent_cost_settings_garde BEFORE DELETE ON agent_cost_settings BEGIN SELECT RAISE(ABORT, 'agent_cost_settings : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_cost_settings_fige BEFORE UPDATE ON agent_cost_settings BEGIN SELECT RAISE(ABORT, 'agent_cost_settings : un réglage ne change plus, une version s''ajoute'); END;
