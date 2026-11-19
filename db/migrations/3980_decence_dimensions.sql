-- AU017 · Décence : la pièce principale (surface et hauteur sous plafond) et le volume habitable, rangés avec les faits.
-- Sans eux, un logement n'est jamais dit louable (décret n° 2002-120, art. 4). Colonnes vides pour les faits d'avant [R17].
ALTER TABLE rental_facts ADD COLUMN main_room_hundredths INTEGER CHECK (main_room_hundredths IS NULL OR (main_room_hundredths > 0 AND main_room_hundredths <= living_area_hundredths));
ALTER TABLE rental_facts ADD COLUMN ceiling_height_cm INTEGER CHECK (ceiling_height_cm IS NULL OR ceiling_height_cm BETWEEN 100 AND 1500);
ALTER TABLE rental_facts ADD COLUMN habitable_volume_hundredths INTEGER CHECK (habitable_volume_hundredths IS NULL OR habitable_volume_hundredths > 0);
-- Le règlement sanitaire local lu par l'agent : référence, jour de lecture, respecté ou non (JSON) ; sans lui, jamais « louable ».
ALTER TABLE rental_facts ADD COLUMN local_rules TEXT CHECK (local_rules IS NULL OR length(local_rules) BETWEEN 2 AND 400);
