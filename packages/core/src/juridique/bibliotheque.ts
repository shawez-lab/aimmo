/**
 * La bibliothèque de l'assistant juridique (HX03) : les seuls textes sur lesquels il a le droit de répondre [R250].
 *
 * Chaque texte porte sa référence exacte, sa date, ce qu'il dit en une ou deux phrases, et la date à laquelle un humain
 * a vérifié sur Légifrance que la version citée est bien celle en vigueur. Un texte jamais vérifié, ou vérifié il y a
 * trop longtemps, sert encore, mais chaque réponse qui le cite le dit en toutes lettres [R252].
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
  /** La date du texte, AAAA-MM-JJ. */
  textDate: string;
  /** Ce que dit le texte, sans rien y ajouter. Seuls ses nombres peuvent être écrits dans une réponse [R251]. */
  summary: string;
  /**
   * Quand le texte couvre une question : chaque groupe doit avoir au moins un de ses termes dans la question (sans
   * accents, en minuscules, mots entiers).
   */
  match: readonly (readonly string[])[];
  /** Adresse Légifrance de l'article, si elle est connue. */
  url: string | null;
  /** Date à laquelle un humain a vérifié la version en vigueur, AAAA-MM-JJ ; null : jamais. */
  checkedOn: string | null;
  /** Qui a relu ce texte pour le réseau (l'avocat) ; null : personne encore. */
  validatedBy: string | null;
}

const RETRACT = ['retractation', 'retracter', 'se retracter', 'retracte', 'renoncer', 'annuler'];

export const DEFAULT_LEGAL_LIBRARY: readonly LegalSource[] = [
  {
    id: 'hoguet-6',
    title: 'Loi n° 70-9 du 2 janvier 1970 (loi Hoguet)',
    article: 'article 6',
    textDate: '1970-01-02',
    summary:
      'Les conventions conclues avec l’agent immobilier doivent être rédigées par écrit. Aucune rémunération ni commission n’est due à l’agent, ni ne peut être exigée ou acceptée, avant que l’opération ait été effectivement conclue et constatée dans un seul acte écrit contenant l’engagement des parties.',
    match: [
      ['mandat', 'honoraires', 'remuneration', 'commission'],
      ['ecrit', 'avant', 'quand', 'moment', 'payer', 'paye', 'payes', 'percevoir', 'toucher', 'verser', 'verse', 'dus', 'exiger', 'acompte', 'avance'],
    ],
    url: null,
    checkedOn: null,
    validatedBy: null,
  },
  {
    id: 'cch-l271-1',
    title: 'Code de la construction et de l’habitation',
    article: 'article L271-1',
    textDate: '2015-08-06',
    summary:
      'L’acquéreur non professionnel d’un immeuble à usage d’habitation peut se rétracter dans un délai de 10 jours à compter du lendemain de la première présentation de la lettre lui notifiant l’acte (promesse ou compromis).',
    match: [RETRACT, ['acquereur', 'acheteur', 'compromis', 'promesse', 'avant-contrat', 'avant contrat']],
    url: null,
    checkedOn: null,
    validatedBy: null,
  },
  {
    id: 'cch-l271-4',
    title: 'Code de la construction et de l’habitation',
    article: 'article L271-4',
    textDate: '2005-06-08',
    summary:
      'En cas de vente de tout ou partie d’un immeuble bâti, un dossier de diagnostic technique, fourni par le vendeur, est annexé à la promesse de vente ou, à défaut, à l’acte authentique de vente.',
    match: [['diagnostic', 'diagnostics', 'ddt', 'dpe', 'amiante', 'plomb', 'termites'], ['vente', 'vendre', 'vendeur', 'compromis', 'promesse', 'acte', 'fournir', 'annexer', 'annexe']],
    url: null,
    checkedOn: null,
    validatedBy: null,
  },
  {
    id: 'copro-46',
    title: 'Loi n° 65-557 du 10 juillet 1965 (copropriété)',
    article: 'article 46',
    textDate: '1965-07-10',
    summary:
      'Toute promesse et tout acte de vente d’un lot de copropriété mentionnent la superficie de la partie privative de ce lot. Si la superficie réelle est inférieure de plus d’un vingtième à celle exprimée, le vendeur supporte une diminution du prix proportionnelle, à la demande de l’acquéreur intentée dans un délai d’un an à compter de l’acte authentique.',
    match: [['carrez', 'superficie', 'surface', 'metrage', 'mesurage'], ['copropriete', 'lot', 'appartement', 'vente', 'privative', 'erreur', 'inferieure', 'carrez']],
    url: null,
    checkedOn: null,
    validatedBy: null,
  },
  {
    id: 'conso-l221-18',
    title: 'Code de la consommation',
    article: 'article L221-18',
    textDate: '2016-03-14',
    summary:
      'Le consommateur dispose d’un délai de 14 jours pour exercer son droit de rétractation d’un contrat conclu à distance ou hors établissement, sans avoir à motiver sa décision.',
    match: [RETRACT, ['hors etablissement', 'distance', 'domicile', 'mandat', 'en ligne', 'chez lui', 'chez le client']],
    url: null,
    checkedOn: null,
    validatedBy: null,
  },
  {
    id: 'civil-1589',
    title: 'Code civil',
    article: 'article 1589',
    textDate: '1804-03-06',
    summary: 'La promesse de vente vaut vente lorsqu’il y a consentement réciproque des deux parties sur la chose et sur le prix.',
    match: [['promesse', 'compromis', 'offre acceptee', 'offre signee'], ['vaut vente', 'engage', 'engagement', 'definitif', 'valeur', 'oblige', 'revenir']],
    url: null,
    checkedOn: null,
    validatedBy: null,
  },
];
