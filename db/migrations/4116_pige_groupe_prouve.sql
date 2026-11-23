-- AU035 · Le groupe prouvé lisible par la base (M01, M02) [R672, R295, R273, R04].
-- Deux annonces sont reliées sur preuve quand leurs relèves portent le même bien avec ses pièces, de proche en proche.
-- Une fermeture dans le doute de l'une tient fermées toutes celles de son groupe. Le code le vérifiait seul, et la base
-- seulement par les clés rangées avec la conversion ; elle le vérifie aussi pour une fiche écrite seule.
-- La table `pige_ad_proven_keys` et la vue `pige_proven_peers` sont dans 4065, lues aussi par le doute.
-- Une relève n'est convertie que si son groupe prouvé se lit, complet, et qu'aucune annonce du groupe n'est fermée, dans
-- le doute ou non [R672, R295, R273, R04].
CREATE TRIGGER IF NOT EXISTS pige_properties_groupe
BEFORE INSERT ON pige_properties
WHEN NOT EXISTS (SELECT 1 FROM pige_ad_proven_keys g WHERE g.ad_id = NEW.ad_id AND g.network_id = NEW.network_id)
  OR EXISTS (SELECT 1 FROM pige_ad_doubt_keys k
               JOIN pige_proven_peers p ON p.network_id = k.network_id AND p.ref_key = k.ref_key
              WHERE k.ad_id = NEW.ad_id AND k.exact = 1
                AND (p.complete = 0
                  OR EXISTS (SELECT 1 FROM pige_doubt_closed_refs r WHERE r.network_id = p.network_id AND r.ref_key = p.peer_key)
                  OR EXISTS (SELECT 1 FROM pige_no_agency n WHERE n.network_id = p.network_id AND n.fingerprint = p.peer_key)
                  OR EXISTS (SELECT 1 FROM pige_oppositions o WHERE o.network_id = p.network_id AND o.fingerprint = p.peer_key)
                  -- Et chaque empreinte qu'une annonce du groupe a portée, anciennes comprises : une fermeture sans clé
                  -- d'annonce lisible se range sur le bien, jamais sur une annonce.
                  OR EXISTS (SELECT 1 FROM pige_ad_doubt_keys bk JOIN pige_ads b ON b.id = bk.ad_id
                               JOIN pige_no_agency n ON n.network_id = b.network_id AND n.fingerprint = b.fingerprint
                              WHERE bk.network_id = p.network_id AND bk.ref_key = p.peer_key AND bk.exact = 1)
                  OR EXISTS (SELECT 1 FROM pige_ad_doubt_keys bk JOIN pige_ads b ON b.id = bk.ad_id
                               JOIN pige_oppositions o ON o.network_id = b.network_id AND o.fingerprint = b.fingerprint
                              WHERE bk.network_id = p.network_id AND bk.ref_key = p.peer_key AND bk.exact = 1)))
BEGIN
  SELECT RAISE(ABORT, 'pige_properties : bien fermé dans le doute, par son groupe');
END;
