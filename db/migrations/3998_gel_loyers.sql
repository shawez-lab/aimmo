-- AU016 · Gel des loyers des logements F et G : le dernier loyer du locataire précédent, ou la première mise en location.
-- Colonnes vides pour les faits d'avant [R17].
ALTER TABLE rental_facts ADD COLUMN previous_rent_cents INTEGER CHECK (previous_rent_cents IS NULL OR previous_rent_cents > 0);
ALTER TABLE rental_facts ADD COLUMN first_letting INTEGER CHECK (first_letting IS NULL OR first_letting IN (0, 1));
