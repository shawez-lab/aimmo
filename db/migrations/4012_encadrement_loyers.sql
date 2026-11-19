-- AU015 · Encadrement des loyers (loi ELAN, art. 140) : dans une commune où la direction a rangé la règle
-- « encadrement_loyers » en vigueur, les faits de la mise en location portent ce que l'agent a lu dans l'arrêté
-- préfectoral pour ce logement : sa référence, le jour de lecture, le loyer de référence et le loyer de référence majoré
-- au m², le complément de loyer et sa justification. JSON contrôlé par le code ; null hors encadrement.
ALTER TABLE rental_facts ADD COLUMN rent_control TEXT CHECK (rent_control IS NULL OR length(rent_control) BETWEEN 2 AND 1200);
