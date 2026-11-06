-- HX21 · Appels entrants résumés et rangés dans la fiche. Un appel n'est rangé qu'une fois [R18, R244]. Il n'est enregistré,
-- et sa transcription n'existe, que si l'annonce et l'accord de l'appelant sont rangés, pendant l'appel [R242]. Chaque champ
-- tiré de l'appel renvoie à un passage des paroles de l'appelant [R243]. L'origine ne vient que d'un code de contenu de AT05
-- porté par l'appel, sinon « inconnue », jamais devinée [R245, R156]. Le numéro n'est pas gardé ici : il est sur la fiche.
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  call_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('en_cours', 'traite', 'sans_enregistrement', 'impossible', 'masque')),
  failure TEXT CHECK (failure IN ('indisponible', 'echec', 'vide', 'incertaine')),
  person_id TEXT,
  attach TEXT CHECK (attach IN ('created', 'matched', 'ambiguous')),
  started_at TEXT,
  ended_at TEXT,
  consent_announced_at TEXT,
  consent_given_at TEXT,
  recording_ref TEXT,
  transcript TEXT,
  language TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  category TEXT,
  route TEXT,
  fields TEXT,
  qualification_source TEXT CHECK (qualification_source IN ('ai', 'rules')),
  origin_content_id TEXT REFERENCES public_contents (id) ON DELETE RESTRICT,
  origin_kind TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (network_id, provider, call_id),
  FOREIGN KEY (person_id, network_id) REFERENCES persons (id, network_id) ON DELETE RESTRICT,
  CHECK (status <> 'traite' OR (consent_announced_at IS NOT NULL AND consent_given_at IS NOT NULL AND recording_ref IS NOT NULL AND transcript IS NOT NULL AND fields IS NOT NULL AND person_id IS NOT NULL)),
  CHECK (status = 'traite' OR (transcript IS NULL AND fields IS NULL AND language IS NULL AND category IS NULL)),
  CHECK (status IN ('traite', 'impossible') OR recording_ref IS NULL),
  CHECK (status <> 'impossible' OR (failure IS NOT NULL AND consent_given_at IS NOT NULL)),
  CHECK (status = 'impossible' OR failure IS NULL),
  CHECK (status <> 'masque' OR person_id IS NULL)
);
CREATE INDEX IF NOT EXISTS calls_person ON calls (person_id);
-- Un appel est réservé (`en_cours`) avant tout le reste : deux livraisons du même appel ne le rangent qu'une fois. Ensuite,
-- rien ne change.
CREATE TRIGGER IF NOT EXISTS calls_fige BEFORE UPDATE ON calls WHEN OLD.status <> 'en_cours' BEGIN SELECT RAISE(ABORT, 'calls : rien ne change'); END;
-- L'événement d'un appel va au journal une seule fois [R244], même si le journal tombe en panne juste après le rangement :
-- une livraison suivante prend cette réservation, vérifie le journal, ajoute l'événement s'il manque, puis la ferme.
-- Une réservation lâchée sur une panne, ou restée ouverte (Worker coupé), est reprise.
CREATE TABLE IF NOT EXISTS call_journal (
  call_id TEXT PRIMARY KEY REFERENCES calls (id) ON DELETE RESTRICT,
  claimed_at TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1))
);
CREATE TRIGGER IF NOT EXISTS call_journal_fige BEFORE UPDATE ON call_journal WHEN OLD.done = 1 BEGIN SELECT RAISE(ABORT, 'call_journal : rien ne change'); END;
