/**
 * La bibliothèque de l'assistant juridique (HX03) : les seuls textes sur lesquels il a le droit de répondre [R250].
 *
 * Chaque texte porte sa référence exacte, le texte qui a créé l'article et sa date, ce qu'il dit en quelques phrases, et
 * la date à laquelle un humain a vérifié sur Légifrance que le résumé suit la version en vigueur. Un article a souvent
 * été modifié depuis sa création : tant que `checkedOn` est vide, chaque réponse qui le cite dit que sa version n'a
 * jamais été vérifiée [R252].
 *
 * Les textes de départ ci-dessous n'ont pas encore été relus par l'avocat du réseau (H54) : `checkedOn` et
 * `validatedBy` restent vides tant que ce n'est pas fait. On n'ajoute ici que des textes dont la teneur est sûre ; un
 * sujet absent de la bibliothèque donne « je ne sais pas, voyez votre avocat », jamais une réponse de mémoire.
 */

export interface LegalSource {
  /** Identifiant stable, cité par l'IA. */
  id: string;
  /** Le texte, tel qu'on le cite : « Code de la construction et de l'habitation ». */
  title: string;
  /** L'article. */
  article: string;
  /** Le texte qui a créé l'article : « loi n° 2000-1208 du 13 décembre 2000 (SRU) ». */
  origin: string;
  /** La date de ce texte d'origine, AAAA-MM-JJ. La version en vigueur peut être plus récente : voir `checkedOn`. */
  textDate: string;
  /** Le texte qui a donné au résumé sa teneur actuelle (souvent le même que `origin`), et sa date, AAAA-MM-JJ. */
  wording: string;
  wordingDate: string;
  /** Ce que dit le texte, sans rien y ajouter. Seuls ses nombres, avec leur unité, peuvent être écrits dans une réponse [R251]. */
  summary: string;
  /**
   * Quand le texte couvre une question : chaque groupe doit avoir au moins un de ses termes dans la question (sans
   * accents, en minuscules, mots entiers).
   */
  match: readonly (readonly string[])[];
  /** Les termes qui montrent que la question sort du texte : un seul présent, le texte ne la couvre pas. */
  exclude: readonly string[];
  /** Adresse Légifrance de l'article, si elle est connue. */
  url: string | null;
  /** Date à laquelle un humain a vérifié la version en vigueur, AAAA-MM-JJ ; null : jamais. */
  checkedOn: string | null;
  /** Qui a relu ce texte pour le réseau (l'avocat) ; null : personne encore. */
  validatedBy: string | null;
}

const RETRACT = ['retractation', 'retracter', 'se retracter', 'retracte'];
const AFTER_DEED = ['apres l acte', 'acte authentique signe', 'apres la signature de l acte'];

export const DEFAULT_LEGAL_LIBRARY: readonly LegalSource[] = [
  {
    id: 'hoguet-6',
    title: 'Loi n° 70-9 du 2 janvier 1970 (loi Hoguet)',
    article: 'article 6',
    origin: 'loi n° 70-9 du 2 janvier 1970',
    textDate: '1970-01-02',
    wording: 'loi n° 70-9 du 2 janvier 1970',
    wordingDate: '1970-01-02',
    summary:
      'Les conventions conclues avec l’agent immobilier doivent être rédigées par écrit. Aucune somme représentative d’honoraires, de frais de recherche, de démarche, de publicité ou d’entremise n’est due à l’agent, ni ne peut être exigée ou acceptée par lui, avant que l’opération ait été effectivement conclue et constatée dans un seul acte écrit contenant l’engagement des parties.',
    match: [
      ['mandat', 'honoraires', 'remuneration', 'commission'],
      ['ecrit', 'payer', 'paye', 'payes', 'percevoir', 'toucher', 'verser', 'verse', 'dus', 'exiger', 'acompte', 'avance'],
    ],
    exclude: ['tva', 'bareme', 'affichage', 'location', 'bail', 'syndic'],
    url: null,
    checkedOn: null,
    validatedBy: null,
  },
  {
    id: 'cch-l271-1',
    title: 'Code de la construction et de l’habitation',
    article: 'article L271-1',
    origin: 'loi n° 2000-1208 du 13 décembre 2000 (SRU)',
    textDate: '2000-12-13',
    wording: 'loi n° 2015-990 du 6 août 2015 (délai porté à 10 jours)',
    wordingDate: '2015-08-06',
    summary:
      'L’acquéreur non professionnel d’un immeuble à usage d’habitation peut se rétracter dans un délai de 10 jours à compter du lendemain de la première présentation de la lettre lui notifiant l’acte (promesse ou compromis).',
    match: [RETRACT, ['acquereur', 'acheteur', 'compromis', 'promesse', 'avant-contrat', 'avant contrat']],
    exclude: ['condition suspensive', 'conditions suspensives', 'professionnel', 'sci', 'local commercial', 'terrain', ...AFTER_DEED],
    url: null,
    checkedOn: null,
    validatedBy: null,
  },
  {
    id: 'cch-l271-4',
    title: 'Code de la construction et de l’habitation',
    article: 'article L271-4',
    origin: 'ordonnance n° 2005-655 du 8 juin 2005',
    textDate: '2005-06-08',
    wording: 'ordonnance n° 2005-655 du 8 juin 2005',
    wordingDate: '2005-06-08',
    summary:
      'En cas de vente de tout ou partie d’un immeuble bâti, un dossier de diagnostic technique, fourni par le vendeur, est annexé à la promesse de vente ou, à défaut, à l’acte authentique de vente.',
    match: [['diagnostic', 'diagnostics', 'ddt'], ['vente', 'vendre', 'vendeur', 'compromis', 'promesse', 'fournir', 'annexer', 'annexe']],
    exclude: ['location', 'bail', 'locataire', 'duree de validite', 'validite', 'terrain'],
    url: null,
    checkedOn: null,
    validatedBy: null,
  },
  {
    id: 'copro-46',
    title: 'Loi n° 65-557 du 10 juillet 1965 (copropriété)',
    article: 'article 46',
    origin: 'loi n° 96-1107 du 18 décembre 1996 (loi Carrez)',
    textDate: '1996-12-18',
    wording: 'loi n° 96-1107 du 18 décembre 1996, seuil de 8 m² fixé par le décret n° 97-532 du 23 mai 1997',
    wordingDate: '1997-05-23',
    summary:
      'Toute promesse et tout acte de vente d’un lot de copropriété mentionnent la superficie de la partie privative de ce lot, sauf pour les caves, garages, emplacements de stationnement et les lots d’une superficie inférieure à 8 m² (seuil fixé par décret). Sans cette mention, l’acquéreur peut demander la nullité de l’acte au plus tard dans un délai d’un mois à compter de l’acte authentique. Si la superficie réelle est inférieure de plus d’un vingtième à celle exprimée, le vendeur supporte une diminution du prix proportionnelle, à la demande de l’acquéreur intentée dans un délai d’un an à compter de l’acte authentique.',
    match: [['carrez', 'superficie', 'surface', 'metrage', 'mesurage'], ['copropriete', 'lot', 'appartement', 'privative', 'carrez']],
    exclude: ['location', 'bail', 'boutin', 'habitable', 'maison individuelle'],
    url: null,
    checkedOn: null,
    validatedBy: null,
  },
  {
    id: 'conso-l221-18',
    title: 'Code de la consommation',
    article: 'article L221-18',
    origin: 'ordonnance n° 2016-301 du 14 mars 2016',
    textDate: '2016-03-14',
    wording: 'ordonnance n° 2016-301 du 14 mars 2016',
    wordingDate: '2016-03-14',
    summary:
      'Le consommateur dispose d’un délai de 14 jours pour exercer son droit de rétractation d’un contrat conclu à distance ou hors établissement, sans avoir à motiver sa décision.',
    match: [RETRACT, ['hors etablissement', 'distance', 'domicile', 'en ligne', 'chez lui', 'chez elle', 'chez le client']],
    exclude: ['exclusif', 'exclusivite', 'resilier', 'resiliation', 'en agence', 'professionnel', 'compromis', 'promesse'],
    url: null,
    checkedOn: null,
    validatedBy: null,
  },
  {
    id: 'civil-1589',
    title: 'Code civil',
    article: 'article 1589',
    origin: 'loi du 6 mars 1804 (titre de la vente du Code civil)',
    textDate: '1804-03-06',
    wording: 'loi du 6 mars 1804 (titre de la vente du Code civil)',
    wordingDate: '1804-03-06',
    summary: 'La promesse de vente vaut vente lorsqu’il y a consentement réciproque des deux parties sur la chose et sur le prix.',
    match: [['promesse', 'compromis', 'offre acceptee', 'offre signee'], ['vaut vente', 'engage', 'engagement', 'definitif', 'oblige']],
    exclude: ['condition suspensive', 'conditions suspensives', 'retractation', 'retracter', 'unilaterale', 'indemnite d immobilisation'],
    url: null,
    checkedOn: null,
    validatedBy: null,
  },
];
