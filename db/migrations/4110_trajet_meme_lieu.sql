-- AU055 · La marge du même lieu (M05) [R700, R32].
-- Chaque tranche tenue par un rendez-vous sur place porte le bien de ce rendez-vous : au même bien, une tranche de trajet
-- déjà tenue est partagée par le rendez-vous suivant, et elle lui passe quand l'autre est annulé ou décalé, même s'il
-- est encore en train d'être pris. Vide pour un appel, un bien inconnu et les tranches d'avant : rien ne se partage alors.
ALTER TABLE appointment_holds ADD COLUMN property_id TEXT;
CREATE INDEX IF NOT EXISTS appointment_holds_meme_lieu ON appointment_holds (agent_id, property_id, layer, unit) WHERE released_at IS NULL;
