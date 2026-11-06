-- HX25 · Dates des clients : anniversaire et fête, seulement celles que la personne a données. Tables nouvelles, en
-- ajout seul : rien ne s'efface [R17]. Aucune date ni aucun texte n'est écrit au journal [R13].

-- Chaque date donnée par la personne, avec d'où elle vient. Une correction est une nouvelle ligne : la dernière compte [R404].
CREATE TABLE IF NOT EXISTS client_dates (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('anniversaire', 'fete')),
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  day INTEGER NOT NULL CHECK (day BETWEEN 1 AND 31),
  -- Comment la personne l'a donnée (« dit au téléphone le 12/10 », « formulaire du site ») : jamais une date devinée.
  proof TEXT NOT NULL CHECK (length(trim(proof)) > 0),
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS client_dates_day ON client_dates (network_id, month, day);
CREATE INDEX IF NOT EXISTS client_dates_person ON client_dates (person_id, kind, created_at);

CREATE TRIGGER IF NOT EXISTS client_dates_sans_modification
BEFORE UPDATE ON client_dates
BEGIN
  SELECT RAISE(ABORT, 'client_dates en ajout seul');
END;

-- Le texte du message de date, écrit par la direction, jamais par l'IA ; chaque version est gardée, la dernière compte [R405].
CREATE TABLE IF NOT EXISTS client_date_texts (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('anniversaire', 'fete')),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp')),
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (network_id, kind, seq)
);

CREATE TRIGGER IF NOT EXISTS client_date_texts_sans_modification
BEFORE UPDATE ON client_date_texts
BEGIN
  SELECT RAISE(ABORT, 'client_date_texts en ajout seul');
END;

-- Un message de date par fiche gardée, par sorte de date et par an, jamais deux [R18, R405].
-- `en_cours` : pris par un passage ; `reporte` : refusé pour l'heure seulement, repris au passage suivant.
CREATE TABLE IF NOT EXISTS client_date_messages (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('anniversaire', 'fete')),
  year INTEGER NOT NULL,
  date_id TEXT NOT NULL REFERENCES client_dates (id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('en_cours', 'reporte', 'essai', 'refuse')),
  rule TEXT,
  message_id TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT,
  PRIMARY KEY (network_id, person_id, kind, year)
);
