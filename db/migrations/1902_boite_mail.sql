-- HX26 · Tri de la boîte mail de l'agent. Tables nouvelles, en ajout seul : rien ne s'efface [R17].
-- Ni adresse, ni objet, ni nom de fichier au journal [R13].

-- Chaque mail lu une fois dans la boîte d'un agent, par sa clé chez le fournisseur : deux lectures n'en rangent qu'un [R18].
-- Un mail d'une adresse inconnue ne garde que sa clé : ni adresse, ni objet, ni texte [R13, R408].
CREATE TABLE IF NOT EXISTS mailbox_mails (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook')),
  external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  -- `en_cours` : pris par un tri depuis `claimed_at` ; `a_reprendre` : tri coupé par une panne, repris à la lecture
  -- suivante ; `rattache` : rangé dans une fiche ; `inconnu` : aucune fiche visible de l'agent ; `ambigu` : plusieurs
  -- fiches, l'agent choisit.
  status TEXT NOT NULL CHECK (status IN ('en_cours', 'a_reprendre', 'rattache', 'inconnu', 'ambigu')),
  claimed_at TEXT NOT NULL,
  person_id TEXT,
  -- Le dossier : le seul projet ouvert de la fiche ; NULL quand il y en a zéro ou plusieurs (l'agent choisit).
  project_id TEXT,
  message_id TEXT UNIQUE,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  done_at TEXT,
  UNIQUE (network_id, agent_id, provider, external_id),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS mailbox_mails_person ON mailbox_mails (person_id, received_at);

CREATE TRIGGER IF NOT EXISTS mailbox_mails_sans_effacement BEFORE DELETE ON mailbox_mails
BEGIN
  SELECT RAISE(ABORT, 'mailbox_mails : rien ne s''efface');
END;

-- Une pièce jointe rangée dans un dossier, une seule fois par empreinte SHA-256 [R410]. Le fichier vit dans le stockage
-- sous `ref` ; son nom d'origine n'est jamais gardé [R13].
CREATE TABLE IF NOT EXISTS mailbox_attachments (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  ref TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  size INTEGER NOT NULL CHECK (size > 0),
  first_mail_id TEXT NOT NULL REFERENCES mailbox_mails (id) ON DELETE RESTRICT,
  stored_at TEXT NOT NULL,
  UNIQUE (network_id, project_id, sha256)
);

CREATE TRIGGER IF NOT EXISTS mailbox_attachments_fige BEFORE UPDATE ON mailbox_attachments
BEGIN
  SELECT RAISE(ABORT, 'mailbox_attachments : rien ne change');
END;
CREATE TRIGGER IF NOT EXISTS mailbox_attachments_sans_effacement BEFORE DELETE ON mailbox_attachments
BEGIN
  SELECT RAISE(ABORT, 'mailbox_attachments : rien ne s''efface');
END;

-- Ce que le tri a fait de chaque pièce jointe d'un mail, par son empreinte [R410].
CREATE TABLE IF NOT EXISTS mailbox_attachment_links (
  mail_id TEXT NOT NULL REFERENCES mailbox_mails (id) ON DELETE RESTRICT,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  -- `range` : rangée ; `deja_range` : la même empreinte était déjà au dossier ; `en_attente` : pas de dossier choisi ;
  -- `inutile` : petite image de signature ; `interdit` : pièce d'identité, RIB ou document fiscal [R15] ;
  -- `type_refuse` : ni PDF, ni JPEG, ni PNG confirmé par les premiers octets, ou trop lourd ; `trop` : au-delà des 20
  -- premières pièces du mail, laissée à l'agent.
  outcome TEXT NOT NULL CHECK (outcome IN ('range', 'deja_range', 'en_attente', 'inutile', 'interdit', 'type_refuse', 'trop')),
  attachment_id TEXT REFERENCES mailbox_attachments (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (mail_id, sha256)
);

CREATE TRIGGER IF NOT EXISTS mailbox_attachment_links_sans_effacement BEFORE DELETE ON mailbox_attachment_links
BEGIN
  SELECT RAISE(ABORT, 'mailbox_attachment_links : rien ne s''efface');
END;

-- La réponse préparée : des phrases fixes, chacune avec ce qu'elle reprend du dossier [R411]. Elle ne part qu'après la
-- validation de l'agent de la boîte, une seule fois, par le contrôle central [R409].
CREATE TABLE IF NOT EXISTS mailbox_drafts (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  mail_id TEXT NOT NULL UNIQUE REFERENCES mailbox_mails (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  -- JSON : [{ "text": ..., "sources": [{ "table": ..., "id": ..., "field": ... }] }].
  sentences TEXT NOT NULL,
  -- JSON : les chiffres du texte, tous repris du dossier [R10].
  figures TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepare', 'valide', 'parti', 'refuse')),
  validated_by TEXT,
  validated_at TEXT,
  rule TEXT,
  sent_message_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS mailbox_drafts_texte_fige BEFORE UPDATE OF body, sentences, figures, mail_id, person_id, agent_id ON mailbox_drafts
BEGIN
  SELECT RAISE(ABORT, 'mailbox_drafts : le texte validé est celui préparé');
END;
CREATE TRIGGER IF NOT EXISTS mailbox_drafts_sans_effacement BEFORE DELETE ON mailbox_drafts
BEGIN
  SELECT RAISE(ABORT, 'mailbox_drafts : rien ne s''efface');
END;
