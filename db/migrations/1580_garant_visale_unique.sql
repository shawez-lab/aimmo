-- Un seul garant Visale par dossier (W18) : l'unicité sur la personne ne le voit pas, sa personne étant vide.
CREATE UNIQUE INDEX IF NOT EXISTS rental_guarantors_visale_unique ON rental_guarantors (application_id) WHERE kind = 'visale';
