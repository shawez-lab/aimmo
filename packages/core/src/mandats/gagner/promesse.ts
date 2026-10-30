/**
 * Aucune promesse de mandats [R145] : aucun texte d'AIMMO ne promet des mandats à un agent. Le contrôle lit le texte
 * sans accents ni majuscules, phrase par phrase, et refuse ce qui garantit, chiffre ou annonce des mandats à venir :
 * « mandats garantis », « 5 mandats par mois », « vous signerez plus de mandats », « l'outil vous apporte des mandats ».
 * Nommer les mandats sans rien promettre reste permis : « Gagner des mandats », « mandat signé », « mandats par source ».
 */

const plain = (t: string): string =>
  t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, ' ');

const PROMISES: readonly RegExp[] = [
  // Une garantie ou une certitude, avant ou après le mot.
  /\bmandats?\b[^.!?]{0,40}\b(garanti|assure|certain|promis|offert|livre|fourni)/,
  /\b(garanti|garantit|garantissons|assure|assurons|promet|promettons|promis|fourni|livre|livrons)\w*\b[^.!?]{0,40}\bmandats?\b/,
  // Un nombre de mandats annoncé par période, ou en hausse.
  /\b\d+\s*(nouveaux\s+)?mandats?\b[^.!?]{0,20}\b(par|chaque|\/)\s*(jour|semaine|mois|trimestre|an|annee)\b/,
  /\b\d+\s*%\s*(de\s+)?(mandats?|plus\s+de\s+mandats?)\b/,
  /\b(\d+|deux|trois|quatre|cinq|dix|double|doubler|triple|tripler)\b[^.!?]{0,20}\bmandats?\b[^.!?]{0,20}\b(en\s+plus|de\s+plus|supplementaires?)\b/,
  /\b(doubl|tripl|multipli)\w*\b[^.!?]{0,30}\bmandats?\b/,
  // Un futur adressé à l'agent : « vous signerez des mandats », « tu auras plus de mandats ».
  /\b(vous|tu)\s+(aurez|auras|obtiendrez|obtiendras|signerez|signeras|rentrerez|rentreras|recevrez|recevras|decrocherez|decrocheras|gagnerez|gagneras)\b[^.!?]{0,30}\bmandats?\b/,
  // Un outil qui « apporte » ou « ramène » des mandats.
  /\b(apporte|apportent|apportera|ramene|ramenent|ramenera|donne|donnent|donnera|genere|generent|generera)\b[^.!?]{0,20}\bmandats?\b/,
  // Une garantie de résultat sans le mot.
  /\b(resultats?|succes)\s+(garanti|assure)/,
];

/** `true` si le texte promet des mandats à un agent [R145]. */
export function promisesMandates(text: string): boolean {
  const t = plain(text);
  return PROMISES.some((p) => p.test(t));
}
