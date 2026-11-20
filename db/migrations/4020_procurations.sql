-- AU059 · Un mandant représenté par procuration : la partie et son représentant sont distincts. La procuration est
-- donnée à la préparation du document, qui nomme les deux ; rien ne change ensuite, rien ne s'efface [R17, R41].
CREATE TABLE IF NOT EXISTS document_proxies (
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  mandant_person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  proxy_person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  power_kind TEXT NOT NULL CHECK (power_kind IN ('notariee', 'sous_seing_prive')),
  granted_on TEXT NOT NULL CHECK (length(granted_on) = 10),
  power_ref TEXT NOT NULL CHECK (length(power_ref) BETWEEN 1 AND 200),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (document_id, mandant_person_id),
  CHECK (mandant_person_id <> proxy_person_id)
);
CREATE TRIGGER IF NOT EXISTS document_proxies_garde BEFORE DELETE ON document_proxies BEGIN SELECT RAISE(ABORT, 'document_proxies : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS document_proxies_fige BEFORE UPDATE ON document_proxies BEGIN SELECT RAISE(ABORT, 'document_proxies : rien ne se réécrit'); END;

-- La session de signature en ligne d'un mandant représenté : le code part au représentant, qui signe pour lui.
CREATE TABLE IF NOT EXISTS signature_session_proxies (
  session_id TEXT PRIMARY KEY REFERENCES signature_sessions (id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE RESTRICT,
  mandant_person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  proxy_person_id TEXT NOT NULL REFERENCES persons (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS signature_session_proxies_garde BEFORE DELETE ON signature_session_proxies BEGIN SELECT RAISE(ABORT, 'signature_session_proxies : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS signature_session_proxies_fige BEFORE UPDATE ON signature_session_proxies BEGIN SELECT RAISE(ABORT, 'signature_session_proxies : rien ne se réécrit'); END;
