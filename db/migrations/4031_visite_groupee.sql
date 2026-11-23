-- AU077 · Une visite groupée : plusieurs acquéreurs visitent le même bien avec le même agent, au même créneau, sans que
-- l'agent soit compté deux fois [R32]. Chaque acquéreur garde son rendez-vous, sa visite, son bon et son compte rendu.
--
-- `group_id` : l'identifiant du premier rendez-vous du groupe, porté par tous ses rendez-vous ; NULL hors groupe. Un seul
-- rendez-vous du groupe tient les tranches de l'agent ; s'il est annulé ou décalé, elles passent à un autre rendez-vous
-- encore pris du groupe, et ne sont libérées qu'avec le dernier.
ALTER TABLE appointments ADD COLUMN group_id TEXT;
CREATE INDEX IF NOT EXISTS appointments_groupe ON appointments (group_id) WHERE group_id IS NOT NULL;
