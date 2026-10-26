# Règles que le code garantit

Chaque règle a un numéro. Une règle « en service » a au moins un test qui porte son numéro, par exemple `[R01]` : les vérifications automatiques refusent toute modification qui casse ce lien. Les nombres cités sont des réglages, modifiables sans toucher au code.

| Règle | Ce que le code garantit | En service | Tâche |
| --- | --- | --- | --- |
| R01 | Horaires. Un message que le système prend l'initiative d'envoyer, relance, alerte, rappel ou demande d'avis, part seulement du lundi au samedi, de 8 h à 20 h, heure de Paris. Une réponse à un message reçu il y a moins de 60 minutes dans la même conversation part tout de suite, à toute heure, dimanche compris. | oui | S05 |
| R02 | Exclusions. Aucun message automatique, ni envoi ni réponse, sur aucun canal, à une personne marquée exclue : la liste d'exclusion de Shawez, toute personne qui a dit stop, non ou vendu, et tout client dont la fiche dit qu'il est suivi par quelqu'un d'autre. La liste est une donnée de la base, jamais écrite dans le code. | oui | S05 |
| R03 | Accord préalable. Aucun premier contact que la personne n'a pas demandé, par téléphone, SMS, WhatsApp ou mail, sans accord préalable enregistré avec sa date et sa preuve. | oui | S05 |
| R04 | Arrêt. Une demande d'arrêt reçue sur un canal marque aussitôt la personne « ne plus écrire » sur tous les canaux. | oui | S05 |
| R05 | Anti-doublon. Jamais deux fois le même message ni le même bien à la même personne, sur aucun canal. | non | S06 |
| R06 | Mention de l'assistant. Le premier message automatique d'une conversation porte la mention légale de l'assistant. Aucun autre texte destiné à un client ne parle de l'IA. | non | S06 |
| R07 | Vocabulaire. Dans tout texte destiné à un client ou au public : « agent immobilier », jamais « mandataire » ; « offert », jamais « gratuit ». | non | S06 |
| R08 | Ton. Tutoiement sur Instagram, vouvoiement avec le prénom ailleurs. Pas de « Salut » à chaque message. Ni parenthèses ni formules administratives. | non | S06 |
| R09 | Contenu public. Jamais le nom d'un client ni une adresse exacte dans un contenu public. | non | S06 |
| R10 | Chiffres. Aucun prix, aucune surface, aucune date inventés : chaque chiffre d'un message vient de la base ou d'une source publique citée. | non | S06 |
| R11 | Plafonds. Au plus 2 demandes d'avis par jour, entre 9 h et 19 h, jamais à un collègue, un associé ou un proche. Au plus 5 messages aux partenaires par jour ouvré. | oui | S05 |
| R12 | Jamais de silence. Si l'IA ne répond pas ou si son plafond de coût est atteint, un texte de secours part à sa place, dans le respect de R01 à R04. | non | S06 |
| R13 | Journal. Chaque envoi et chaque refus d'envoi sont écrits au journal avec la règle appliquée, sans donnée personnelle en clair. | non | S06, S07 |
| R14 | Aucune décision sur les personnes. Aucune note ni aucun tri automatique des candidats à un poste ou à une location, de la solvabilité d'un acquéreur ou d'un locataire, ni de la performance d'un agent. Les contacts sont attribués aux agents par des règles fixes. | non | M03, M14, M15 |
| R15 | Données minimales. Aucune pièce d'identité, aucun document anti-blanchiment, aucune coordonnée bancaire n'est envoyé à une IA ni rangé dans la fiche client : ils vivent seulement dans le coffre de la conformité. | oui | S03 |
| R16 | Accès. Un agent ne voit que ses clients, ses biens et ses chiffres. Chaque lecture d'une fiche est écrite au journal. | non | S08 |
| R17 | Pas d'effacement. Le code n'efface aucune donnée, sauf par la procédure d'effacement prévue par la Conformité, demande de la personne ou durée de conservation dépassée, elle-même écrite au journal. | oui | S04 |
