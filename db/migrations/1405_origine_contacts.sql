-- AT05 · Origine des contacts : le contenu précis qui a amené chaque contact [R156].
-- Chaque contenu public a un identifiant court, porté par ses liens (`?o=<code>`). L'origine d'un contact est rangée
-- en liste fermée : le contenu, sa sorte, et la façon dont elle a été lue ; « inconnue » quand rien n'est lu. Aucune
-- adresse de page, aucun cookie, aucun identifiant de navigateur ni donnée personnelle n'est gardé [R156].
-- Rien ne s'efface ni ne se réécrit [R17].

CREATE TABLE IF NOT EXISTS public_contents (
  -- Le code porté par les liens : 12 lettres et chiffres en base 32, tiré au hasard, sans rien dire du contenu.
  id TEXT PRIMARY KEY CHECK (length(id) = 12),
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('bien', 'prix', 'agent', 'video', 'publication', 'quartier', 'simulateur', 'portail')),
  -- L'identifiant interne du contenu : un bien, un agent, un chemin de prix, une publication du Studio, un portail.
  ref TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL,
  UNIQUE (network_id, kind, ref)
);
CREATE TRIGGER IF NOT EXISTS public_contents_garde BEFORE DELETE ON public_contents BEGIN SELECT RAISE(ABORT, 'public_contents : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS public_contents_fige BEFORE UPDATE ON public_contents BEGIN SELECT RAISE(ABORT, 'public_contents : rien ne se réécrit'); END;

-- Une publication ou une vidéo mise en ligne sur un réseau : la référence du message chez le réseau, pour reconnaître
-- un commentaire ou un message venu de lui.
CREATE TABLE IF NOT EXISTS public_content_posts (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('instagram', 'facebook', 'whatsapp')),
  post_ref TEXT NOT NULL CHECK (length(post_ref) BETWEEN 1 AND 200),
  content_id TEXT NOT NULL REFERENCES public_contents (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (network_id, channel, post_ref)
);
CREATE TRIGGER IF NOT EXISTS public_content_posts_garde BEFORE DELETE ON public_content_posts BEGIN SELECT RAISE(ABORT, 'public_content_posts : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS public_content_posts_fige BEFORE UPDATE ON public_content_posts BEGIN SELECT RAISE(ABORT, 'public_content_posts : rien ne se réécrit'); END;

-- L'origine de chaque message reçu, une seule fois : la première lecture compte.
CREATE TABLE IF NOT EXISTS contact_origins (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  inbound_id TEXT NOT NULL UNIQUE REFERENCES inbound_messages (id) ON DELETE RESTRICT,
  content_id TEXT REFERENCES public_contents (id) ON DELETE RESTRICT,
  content_kind TEXT NOT NULL CHECK (content_kind IN ('bien', 'prix', 'agent', 'video', 'publication', 'quartier', 'simulateur', 'portail', 'inconnue')),
  method TEXT NOT NULL CHECK (method IN ('lien', 'page', 'publication', 'portail', 'inconnue')),
  recorded_at TEXT NOT NULL,
  CHECK ((content_id IS NULL) = (content_kind = 'inconnue')),
  CHECK ((method = 'inconnue') = (content_kind = 'inconnue'))
);
CREATE INDEX IF NOT EXISTS contact_origins_content ON contact_origins (network_id, content_id);
CREATE TRIGGER IF NOT EXISTS contact_origins_garde BEFORE DELETE ON contact_origins BEGIN SELECT RAISE(ABORT, 'contact_origins : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS contact_origins_fige BEFORE UPDATE ON contact_origins BEGIN SELECT RAISE(ABORT, 'contact_origins : rien ne se réécrit'); END;
