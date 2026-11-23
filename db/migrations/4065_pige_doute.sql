-- AU035 · Le doute lisible par la base (M01, M02) [R672, R295, R273, R04, R17].
-- Quand un site tait les pièces, deux annonces de même sorte, code postal, commune et surface à 1 m² près pourraient
-- être le même bien : rien ne les réunit, mais une fermeture de l'une tient l'autre fermée. Le code le vérifiait seul ;
-- la base le vérifie aussi, pour qu'une conversion écrite directement, ou une fermeture arrivée entre le contrôle et
-- l'écriture, ne passe pas.
-- Pour chaque relève : sa clé d'annonce et l'empreinte de son bien sans les pièces, à sa surface (exact = 1) et à 1 m²
-- près (exact = 0). Des empreintes seulement, jamais un chiffre ni un texte. Table nouvelle, en ajout seul.
CREATE TABLE IF NOT EXISTS pige_ad_doubt_keys (
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  ad_id TEXT NOT NULL REFERENCES pige_ads (id) ON DELETE RESTRICT,
  ref_key TEXT NOT NULL CHECK (length(ref_key) = 64),
  legacy_fp TEXT NOT NULL CHECK (length(legacy_fp) = 64),
  exact INTEGER NOT NULL CHECK (exact IN (0, 1)),
  PRIMARY KEY (ad_id, legacy_fp)
);
CREATE INDEX IF NOT EXISTS pige_ad_doubt_keys_fp ON pige_ad_doubt_keys (network_id, legacy_fp, exact);
CREATE INDEX IF NOT EXISTS pige_ad_doubt_keys_ref ON pige_ad_doubt_keys (network_id, ref_key);
-- Les empreintes d'une relève sont celles de la relève elle-même, jamais d'une autre.
CREATE TRIGGER IF NOT EXISTS pige_ad_doubt_keys_releve
BEFORE INSERT ON pige_ad_doubt_keys
WHEN NOT EXISTS (SELECT 1 FROM pige_ads a WHERE a.id = NEW.ad_id AND a.network_id = NEW.network_id)
BEGIN
  SELECT RAISE(ABORT, 'pige_ad_doubt_keys : relève inconnue');
END;
CREATE TRIGGER IF NOT EXISTS pige_ad_doubt_keys_fige BEFORE UPDATE ON pige_ad_doubt_keys BEGIN SELECT RAISE(ABORT, 'pige_ad_doubt_keys : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS pige_ad_doubt_keys_garde BEFORE DELETE ON pige_ad_doubt_keys BEGIN SELECT RAISE(ABORT, 'pige_ad_doubt_keys : rien ne s''efface'); END;

-- Les relèves fermées dans le doute : celles dont une autre annonce, qui pourrait être leur bien, est fermée.
-- Une autre annonce B pourrait être le bien de la relève A quand l'empreinte sans pièces de B est à 1 m² près celle de A,
-- et que l'une des deux tait ses pièces :
--   1. ce que B a dit d'elle en dernier, fermée, le dit, et elle n'a pas été rangée ouverte depuis ;
--   2. sinon, sa dernière relève rangée le dit.
-- Et la relève dont l'annonce a été revue et refusée depuis : ce qu'elle dit aujourd'hui compte, pas sa vieille relève.
-- B compte alors si sa clé ou l'une des empreintes qu'elle a portées est fermée (« pas d'agence » ou non). S'ajoute le
-- bien sans pièces fermé à 1 m² près, qui pourrait être tout bien de cette surface. Le doute ne passe jamais d'un bien à un
-- troisième : seule une fermeture rangée sur B compte, jamais un doute sur B.
CREATE VIEW IF NOT EXISTS pige_doubt_closed AS
SELECT a.ad_id AS ad_id
  FROM pige_ad_doubt_keys a
  JOIN pige_ads x ON x.id = a.ad_id
  JOIN pige_closed_descriptions d ON d.network_id = a.network_id AND d.property_fingerprint = a.legacy_fp AND d.ref_key <> a.ref_key
 WHERE (x.rooms IS NULL OR d.rooms_said = 0)
   AND d.noted_at = (SELECT max(e.noted_at) FROM pige_closed_descriptions e WHERE e.network_id = d.network_id AND e.ref_key = d.ref_key)
   AND NOT EXISTS (SELECT 1 FROM pige_ad_doubt_keys bk JOIN pige_ads b ON b.id = bk.ad_id
                    WHERE bk.network_id = d.network_id AND bk.ref_key = d.ref_key AND b.collected_at > d.noted_at)
   AND (EXISTS (SELECT 1 FROM pige_no_agency n WHERE n.network_id = d.network_id AND n.fingerprint = d.ref_key)
     OR EXISTS (SELECT 1 FROM pige_oppositions o WHERE o.network_id = d.network_id AND o.fingerprint = d.ref_key)
     OR EXISTS (SELECT 1 FROM pige_ad_doubt_keys bk JOIN pige_ads b ON b.id = bk.ad_id
                  JOIN pige_no_agency n ON n.network_id = b.network_id AND n.fingerprint = b.fingerprint
                 WHERE bk.network_id = d.network_id AND bk.ref_key = d.ref_key)
     OR EXISTS (SELECT 1 FROM pige_ad_doubt_keys bk JOIN pige_ads b ON b.id = bk.ad_id
                  JOIN pige_oppositions o ON o.network_id = b.network_id AND o.fingerprint = b.fingerprint
                 WHERE bk.network_id = d.network_id AND bk.ref_key = d.ref_key))
UNION ALL
SELECT a.ad_id AS ad_id
  FROM pige_ad_doubt_keys a
  JOIN pige_ads x ON x.id = a.ad_id
  JOIN pige_ad_doubt_keys bk ON bk.network_id = a.network_id AND bk.legacy_fp = a.legacy_fp AND bk.exact = 1 AND bk.ref_key <> a.ref_key
  JOIN pige_ads b ON b.id = bk.ad_id
 WHERE (x.rooms IS NULL OR b.rooms IS NULL)
   -- La dernière relève rangée de B.
   AND NOT EXISTS (SELECT 1 FROM pige_ad_doubt_keys ck JOIN pige_ads c ON c.id = ck.ad_id
                    WHERE ck.network_id = bk.network_id AND ck.ref_key = bk.ref_key AND c.collected_at > b.collected_at)
   -- Revue fermée depuis : c'est ce qu'elle a dit en dernier qui compte (1.).
   AND NOT EXISTS (SELECT 1 FROM pige_closed_descriptions d WHERE d.network_id = bk.network_id AND d.ref_key = bk.ref_key AND d.noted_at >= b.collected_at)
   AND (EXISTS (SELECT 1 FROM pige_no_agency n WHERE n.network_id = bk.network_id AND n.fingerprint = bk.ref_key)
     OR EXISTS (SELECT 1 FROM pige_oppositions o WHERE o.network_id = bk.network_id AND o.fingerprint = bk.ref_key)
     OR EXISTS (SELECT 1 FROM pige_ad_doubt_keys ck JOIN pige_ads c ON c.id = ck.ad_id
                  JOIN pige_no_agency n ON n.network_id = c.network_id AND n.fingerprint = c.fingerprint
                 WHERE ck.network_id = bk.network_id AND ck.ref_key = bk.ref_key)
     OR EXISTS (SELECT 1 FROM pige_ad_doubt_keys ck JOIN pige_ads c ON c.id = ck.ad_id
                  JOIN pige_oppositions o ON o.network_id = c.network_id AND o.fingerprint = c.fingerprint
                 WHERE ck.network_id = bk.network_id AND ck.ref_key = bk.ref_key))
UNION ALL
-- L'annonce elle-même revue et refusée depuis sa dernière relève rangée : ce qu'elle dit aujourd'hui l'a fermée, ses
-- vieilles relèves ne rouvrent rien.
SELECT a.ad_id AS ad_id
  FROM pige_ad_doubt_keys a
 WHERE a.exact = 1
   AND EXISTS (SELECT 1 FROM pige_closed_descriptions d
                WHERE d.network_id = a.network_id AND d.ref_key = a.ref_key
                  AND d.noted_at >= (SELECT max(c.collected_at) FROM pige_ad_doubt_keys ck JOIN pige_ads c ON c.id = ck.ad_id
                                      WHERE ck.network_id = a.network_id AND ck.ref_key = a.ref_key AND ck.exact = 1))
UNION ALL
SELECT a.ad_id AS ad_id
  FROM pige_ad_doubt_keys a
 WHERE EXISTS (SELECT 1 FROM pige_no_agency n WHERE n.network_id = a.network_id AND n.fingerprint = a.legacy_fp)
    OR EXISTS (SELECT 1 FROM pige_oppositions o WHERE o.network_id = a.network_id AND o.fingerprint = a.legacy_fp);

-- Une relève n'est convertie que si son doute se lit (ses empreintes rangées) et qu'il ne la ferme pas [R672, R295].
CREATE TRIGGER IF NOT EXISTS pige_properties_doute
BEFORE INSERT ON pige_properties
WHEN NOT EXISTS (SELECT 1 FROM pige_ad_doubt_keys k WHERE k.ad_id = NEW.ad_id AND k.network_id = NEW.network_id)
  OR EXISTS (SELECT 1 FROM pige_doubt_closed v WHERE v.ad_id = NEW.ad_id)
BEGIN
  SELECT RAISE(ABORT, 'pige_properties : bien fermé dans le doute');
END;
-- Et aucune clé ne s'attache à un bien converti dont la relève est fermée dans le doute depuis.
CREATE TRIGGER IF NOT EXISTS pige_property_keys_doute
BEFORE INSERT ON pige_property_keys
WHEN EXISTS (SELECT 1 FROM pige_properties p JOIN pige_doubt_closed v ON v.ad_id = p.ad_id WHERE p.property_id = NEW.property_id)
BEGIN
  SELECT RAISE(ABORT, 'pige_property_keys : bien fermé dans le doute');
END;
