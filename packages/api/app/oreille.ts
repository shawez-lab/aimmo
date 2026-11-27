/**
 * « À l'oreille » : la clé d'un mot tel qu'il s'entend en français, pour chercher un nom ou une commune qu'on a
 * entendu au téléphone ou dicté, sans savoir l'écrire. « Dupond », « Dupont » et « dupon » ont la même clé ; « filip »
 * trouve « Philippe », « kétini » trouve « Quetigny ».
 *
 * Ce n'est ni une traduction ni une devinette : une suite fixe de remplacements, la même pour ce qui est tapé et pour
 * ce qui est cherché, sans réseau et sans rien envoyer. Elle ne remplace pas la recherche exacte : elle s'y ajoute, et
 * l'écran dit ce qu'elle a trouvé. Elle peut rapprocher deux noms qui s'entendent pareil ; elle n'écarte jamais un nom
 * que la recherche exacte trouve.
 *
 * Le morceau est posé tel quel dans les scripts servis à part qui cherchent (`/app/clients.js`) : il ne pèse rien dans
 * l'application [R201].
 */
export const OREILLE_JS = `
  /* La clé d'un texte tel qu'il s'entend en français, mot par mot. */
  function sound(text) {
    return String(text || '').toLowerCase().replace(/ç/g, 's').replace(/œ/g, 'e').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').split(/[^a-z]+/).filter(Boolean).map(function (w) {
      w = w.replace(/ph/g, 'f').replace(/sch|sh/g, 'ch').replace(/ch(?=[rl])/g, 'k').replace(/ch/g, 'C')
        .replace(/cqu|ck|qu|q/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
        .replace(/gn/g, 'n').replace(/dj/g, 'j').replace(/gu(?=[eiy])/g, 'G').replace(/ge(?=[ao])/g, 'j').replace(/g(?=[eiy])/g, 'j').replace(/G/g, 'g')
        .replace(/bv/g, 'v').replace(/w/g, 'v').replace(/z/g, 's').replace(/x/g, 'ks').replace(/y/g, 'i')
        .replace(/(?:ain|ein|aim)(?![aeiou])/g, 'in').replace(/ean(?![aeiou])/g, 'an').replace(/[ae][nm](?![aeiounm])/g, 'an').replace(/om(?=[bp])/g, 'on').replace(/im(?=[bp])/g, 'in')
        .replace(/eau|au/g, 'o').replace(/ai|ei/g, 'e').replace(/oeu|eu/g, 'e').replace(/ou/g, 'u')
        .replace(/h/g, '').replace(/C/g, 'ch').replace(/(.)\\1+/g, '$1');
      /* Les lettres muettes de la fin : « Dupont », « Charles », « Jacques », « Philippe ». */
      if (w.length > 2) w = w.replace(/e$/, '');
      if (w.length > 2) w = w.replace(/[tdsp]$/, '');
      if (w.length > 2) w = w.replace(/e$/, '');
      return w;
    }).join(' ');
  }
  /*
   * Ce qui est tapé s'entend-il au début d'un mot de ce texte ? Seulement des lettres, et trois sons au moins : un
   * chiffre ne s'entend pas, et deux lettres rapprocheraient tout.
   */
  function heardIn(key, typed) {
    if (!/^[a-zà-ÿœ' -]+$/i.test(typed)) return false;
    var said = sound(typed);
    return said.replace(/ /g, '').length > 2 && (' ' + key).indexOf(' ' + said) !== -1;
  }
`;
