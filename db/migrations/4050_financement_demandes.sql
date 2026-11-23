-- AU083 · Deux banques sur le même dossier : chaque étape déclarée dit à quelle demande de financement elle appartient
-- (le nom de la banque ou du courtier, tel que l'acquéreur le dit), pour que les suites ne se mélangent pas. Vide pour
-- les étapes rangées avant : elles forment une seule demande, comme avant. Ni montant, ni taux, ni note [R14].
-- En ajout seul [R17].
ALTER TABLE sale_file_financing ADD COLUMN request_label TEXT NOT NULL DEFAULT '' CHECK (length(request_label) <= 60);
