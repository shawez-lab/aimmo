# Règles que le code garantit

Chaque règle a un numéro. Une règle « en service » a au moins un test qui porte son numéro, par exemple `[R01]` : les vérifications automatiques refusent toute modification qui casse ce lien. Les nombres cités sont des réglages, modifiables sans toucher au code.

| Règle | Ce que le code garantit | En service | Tâche |
| --- | --- | --- | --- |
| R01 | Horaires. Un message que le système prend l'initiative d'envoyer, relance, alerte, rappel ou demande d'avis, part seulement du lundi au samedi, de 8 h à 20 h, heure de Paris. Une réponse à un message reçu il y a moins de 60 minutes dans la même conversation part tout de suite, à toute heure, dimanche compris. | oui | S05 |
| R02 | Exclusions. Aucun message automatique, ni envoi ni réponse, sur aucun canal, à une personne marquée exclue : la liste d'exclusion de Shawez, toute personne qui a dit stop, non ou vendu, et tout client dont la fiche dit qu'il est suivi par quelqu'un d'autre. La liste est une donnée de la base, jamais écrite dans le code. | oui | S05 |
| R03 | Accord préalable. Aucun premier contact que la personne n'a pas demandé, par téléphone, SMS, WhatsApp ou mail, sans accord préalable enregistré avec sa date et sa preuve. | oui | S05 |
| R04 | Arrêt. Une demande d'arrêt reçue sur un canal marque aussitôt la personne « ne plus écrire » sur tous les canaux. | oui | S05 |
| R05 | Anti-doublon. Jamais deux fois le même message ni le même bien à la même personne, sur aucun canal. | oui | S06 |
| R06 | Mention de l'assistant. Le premier message automatique d'une conversation porte la mention légale de l'assistant. Aucun autre texte destiné à un client ne parle de l'IA. | oui | S06 |
| R07 | Vocabulaire. Dans tout texte destiné à un client ou au public : « agent immobilier », jamais « mandataire » ; « offert », jamais « gratuit ». | oui | S06 |
| R08 | Ton. Tutoiement sur Instagram, vouvoiement avec le prénom ailleurs. Pas de « Salut » à chaque message. Ni parenthèses ni formules administratives. | oui | S06 |
| R09 | Contenu public. Jamais le nom d'un client ni une adresse exacte dans un contenu public. | oui | S06 |
| R10 | Chiffres. Aucun prix, aucune surface, aucune date inventés : chaque chiffre d'un message vient de la base ou d'une source publique citée. | oui | S06 |
| R11 | Plafonds. Au plus 2 demandes d'avis par jour, entre 9 h et 19 h, jamais à un collègue, un associé ou un proche. Au plus 5 messages aux partenaires par jour ouvré. | oui | S05 |
| R12 | Jamais de silence. Si l'IA ne répond pas ou si son plafond de coût est atteint, un texte de secours part à sa place, dans le respect de R01 à R04. | oui | S06 |
| R13 | Journal. Chaque envoi et chaque refus d'envoi sont écrits au journal avec la règle appliquée, sans donnée personnelle en clair. | oui | S06, S07 |
| R14 | Aucune décision sur les personnes. Aucune note ni aucun tri automatique des candidats à un poste ou à une location, de la solvabilité d'un acquéreur ou d'un locataire, ni de la performance d'un agent. Les contacts sont attribués aux agents par des règles fixes. | non | M03, M14, M15 |
| R15 | Données minimales. Aucune pièce d'identité, aucun document anti-blanchiment, aucune coordonnée bancaire n'est envoyé à une IA ni rangé dans la fiche client : ils vivent seulement dans le coffre de la conformité. | oui | S03 |
| R16 | Accès. Un agent ne voit que ses clients, ses biens et ses chiffres ; des biens des autres agents, seulement ceux en vente, qui forment le fichier commun du réseau, sans aucune donnée de client. Chaque lecture d'une fiche, et chaque refus, est écrit au journal avant que la donnée soit rendue. | oui | S08 |
| R17 | Pas d'effacement. Le code n'efface aucune donnée, sauf par la procédure d'effacement prévue par la Conformité, demande de la personne ou durée de conservation dépassée, elle-même écrite au journal. | oui | S04 |
| R18 | Réception unique. Un message reçu deux fois, même en même temps, sur le même canal avec le même identifiant, n'est rangé et traité qu'une fois et ne produit qu'une réponse. | oui | C01, C06 |
| R19 | Discrétion du bien. Dans tout message à un client, jamais l'adresse exacte d'un bien ni le nom de son vendeur. | oui | C04 |
| R20 | Bien non reconnu. Sans correspondance sûre avec un seul bien, la réponse est simple et honnête et ne cite aucune donnée de bien. | oui | C03, C04 |
| R21 | Relais. L'assistant se tait dans une conversation dès qu'un humain y a répondu, et passe la main à l'agent après 5 échanges au plus. | oui | C05 |
| R22 | Fenêtre de Meta. Sur Instagram, Facebook et WhatsApp, aucun message automatique ne part plus de 24 heures après le dernier message du client. | oui | C05 |
| R23 | Rien de sensible déduit. La qualification d'un contact ne range que ses champs prévus, catégorie, bien, commune, budget ou prix, délai, financement déclaré, critères ; jamais la santé, l'origine, la religion, une situation familiale non déclarée ni un critère discriminant. | oui | Q01 |
| R24 | Financement déclaré, note expliquée. Le financement n'est rangé que tel que la personne l'a déclaré, jamais évalué ; chaque note de contact porte sa raison en une ligne et ne dépend ni du financement, ni de la solvabilité, ni d'aucun critère discriminant. | oui | Q01, Q02 |
| R25 | Attribution. Un contact est attribué à l'agent de sa commune par des règles fixes écrites dans le code, les mêmes pour tous, sans IA ; une personne exclue ou qui a demandé l'arrêt n'est jamais attribuée ni recontactée. | oui | Q03, Q04 |
| R26 | Bascule prudente. Une automatisation existante ne fait partir aucun message par le socle tant qu'elle est en mode essai ou en ombre ; elle passe ensuite à 10 % des envois pendant 7 jours, puis à tous si les écarts tiennent, et revient d'elle-même en ombre au premier écart non expliqué ou à la première panne. | non | B01, B04 |
| R27 | Aucun prix inventé. Une fourchette ne s'appuie que sur des ventes réelles de la source, chacune avec sa date ; sans 5 ventes comparables au moins, pas de fourchette, et la raison est dite. | oui | E01 |
| R28 | Date des données. Toute estimation dit la date des dernières ventes utilisées, signale quand les plus récentes manquent encore, et dit clairement quand DVF ne couvre pas le département (Bas-Rhin, Haut-Rhin, Moselle, Mayotte). | oui | E01 |
| R29 | Ventes anonymes. Les données publiques de ventes ne servent jamais à identifier une personne : une vente citée n'a ni nom, ni numéro de voie. | oui | E02 |
| R30 | Avis validé. Aucun avis de valeur ne part sans la validation de l'agent qui suit le bien. | oui | E04 |
| R31 | Estimation en ligne. Sans visite, seule la fourchette de la commune est donnée, jamais le prix d'un bien précis. | oui | E05 |
| R32 | Pas de double réservation. Deux rendez-vous d'un agent ne se chevauchent jamais, et le temps de trajet entre deux rendez-vous sur place est toujours laissé. | oui | V01, V02 |
| R33 | Disponibilités de l'agent. Aucun créneau n'est proposé hors des disponibilités que l'agent a fixées, ni sur un événement occupé de son agenda. | oui | V01 |
| R34 | Brief vrai. Le brief d'un rendez-vous ne porte que des données de la base ou d'une source citée ; ce qui manque est dit, rien n'est inventé. | oui | V05 |
| R35 | Plan du jour par règles écrites. L'ordre du plan du jour suit des règles écrites dans le code, les mêmes pour tous, chaque ligne avec sa raison ; jamais une note de l'IA sur les personnes. | oui | G01 |
| R36 | Base légale de la prospection. Le plan du jour et le suivi de valeur ne portent que des personnes qui ont une demande récente ou un accord en cours ; jamais une personne exclue ou qui a demandé l'arrêt. | oui | G01, G04, G05 |
| R37 | Sources interdites. Aucune liste achetée, aucune donnée de ventes publiques utilisée pour retrouver un propriétaire. | oui | G03 |
| R38 | Source du mandat. Chaque mandat signé a sa source renseignée. | oui | G03 |
| R39 | Registre des mandats. Chaque mandat signé reçoit à son inscription un numéro unique, dans l'ordre chronologique, sans trou ; chaque ligne porte l'empreinte de la précédente, et toute modification après coup est détectée par le contrôle d'intégrité. Le numéro figure sur l'exemplaire du mandant. | oui | D01, D04 |
| R40 | Documents sans invention. Un document est rempli depuis la base selon un modèle daté et versionné, gardé avec lui ; un champ qui manque rend le document incomplet ; l'IA ne rédige aucune clause. | oui | D02 |
| R41 | Identification avant signature. Aucun mandat signé sans contrôle complet : champs obligatoires, honoraires au barème, mandants égaux aux propriétaires, identité de chaque vendeur vérifiée. | oui | D03 |
| R42 | Diffusion sous mandat. Aucune annonce ni diffusion d'un bien sans mandat signé, numéroté et en cours, ni pendant le délai de rétractation sauf demande écrite du vendeur. | oui | D05 |
| R43 | Mentions de l'annonce. Aucune annonce publiée sans toutes ses mentions obligatoires, calculées et placées par le code : prix honoraires inclus en plus grand, prix hors honoraires et honoraires TTC en pourcentage quand l'acquéreur les paie, classes énergie et climat, logement très énergivore, dépenses annuelles avec leur année, copropriété, renvoi vers Géorisques en zone concernée, numéro de carte professionnelle. Une mention qui manque bloque la publication. | oui | P02 |
| R44 | Prix publié. Le prix publié est celui du mandat en vigueur, avenants signés compris, et le même sur tous les canaux. | oui | P02, P04 |
| R45 | Diagnostic avant publication. Aucune annonce publiée sans diagnostic énergétique du bien. | oui | P02 |
| R46 | Rien qui situe ni qui exclue. Jamais d'adresse exacte en public, ni dans le texte, la page, la fiche, l'export ou la vidéo ; aucun critère discriminant dans le texte d'une annonce. | oui | P03, P05, P06 |
| R47 | Annonce sans invention. Le texte d'une annonce ne porte que des faits de la fiche du bien, chacun relié à sa source ; aucune annonce n'est publiée sans la validation de l'agent du bien. | oui | P03 |
| R48 | Aménagement virtuel. Une image modifiée par l'IA, pièce meublée ou travaux simulés, porte la mention « aménagement virtuel » sur l'image. | oui | P06 |
| R49 | Alertes demandées. Une alerte de bien ne part qu'à un acquéreur qui l'a demandée (accord en cours pour les alertes), avec un lien de désinscription, après le contrôle central. | oui | T03 |
| R50 | Recherche sans discrimination. La fiche acquéreur et le rapprochement ne portent aucun critère discriminant (origine, religion, situation de famille, handicap, nationalité, etc., liste fermée) ; seuls des critères sur le bien et le projet comptent. | oui | T01, T02 |
| R51 | Rapprochement par règles écrites. Les acquéreurs proposés pour un bien le sont par le code, selon leurs critères et des tolérances écrites en réglage, chacun avec ses raisons ; jamais par une note de l'IA sur les personnes, ni par le financement ou la solvabilité de l'acquéreur [R14]. | oui | T02 |
| R52 | Compte rendu sans nom. Le compte rendu de visite remis au vendeur ne porte ni le nom ni les coordonnées de l'acquéreur, et part seulement après la validation de l'agent. | oui | T06 |
| R53 | Point au vendeur vérifié. Le point de la semaine ne porte que des chiffres lus dans la base ; une donnée absente est écrite « non communiquée » ; il ne parle jamais de baisse de prix. | oui | T07 |
| R54 | Visite sécurisée. Aucune visite confirmée tant que le visiteur n'a pas confirmé son identité et son téléphone ; l'agent dispose d'une alerte en un geste. | oui | T05 |
| R56 | Offres transmises. Toute offre reçue est enregistrée dans le registre chaîné du bien et transmise au vendeur ; une offre non transmise est signalée, et toute modification du registre après coup est détectée. | oui | O01, O03, O06 |
| R57 | Aucune décision automatique sur une offre. Aucun programme n'accepte, ne refuse, ne contre-propose une offre ni ne négocie un prix : seule une réponse du vendeur, rapportée par l'agent avec sa preuve, change l'état d'une offre. | oui | O03, O04, O06 |
| R58 | Identité avant compromis. Aucun compromis préparé tant que l'identité de chaque acquéreur n'est pas vérifiée. | non | O07 |
| R59 | Validité des offres. La durée de validité d'une offre est suivie ; l'agent est prévenu avant l'échéance, et une offre échue ne peut plus être acceptée. | oui | O03, O05 |
