/**
 * Le cadrage pièce par pièce (HX12) [R277].
 *
 * Pour chaque bien, l'appli tire de sa fiche (sorte et nombre de pièces) la liste des photos à faire, chacune avec une
 * consigne de cadrage. L'agent ne repart pas tant qu'une photo de la liste n'est ni acceptée ni dite sans objet, avec
 * une raison d'une liste fermée : la pièce n'existe pas, ou l'accès en a été refusé.
 */

export interface Shot {
  /** La clé de la photo dans la liste, stable : `sejour`, `chambre-2`. */
  key: string;
  label: string;
  /** La consigne de cadrage, en une phrase. */
  advice: string;
}

export const SKIP_REASONS = ['piece_absente', 'acces_refuse'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** Au plus tant de chambres dans la liste, même si la fiche en dit plus. */
export const MAX_BEDROOMS = 12;

const WIDE = 'Placez-vous dans l’angle opposé à la porte, téléphone droit à hauteur de poitrine, en mode paysage.';

const s = (key: string, label: string, advice: string): Shot => ({ key, label, advice });

/** La liste des photos à faire pour un bien, tirée de sa sorte et de son nombre de pièces. */
export function shotPlan(kind: string, rooms: number | null): Shot[] {
  switch (kind) {
    case 'home': {
      // Le nombre de pièces compte le séjour et les chambres : une chambre de moins que les pièces, au moins une.
      const bedrooms = Math.min(MAX_BEDROOMS, Math.max(1, (rooms ?? 2) - 1));
      return [
        s('facade', 'Façade ou entrée', 'Reculez jusqu’à voir toute la façade, sans plaque de rue ni numéro dans le cadre.'),
        s('sejour', 'Séjour', WIDE),
        s('cuisine', 'Cuisine', 'Depuis l’entrée de la cuisine, plan de travail et fenêtre dans le cadre.'),
        ...Array.from({ length: bedrooms }, (_, i) => s(`chambre-${i + 1}`, `Chambre ${i + 1}`, WIDE)),
        s('salle-d-eau', 'Salle de bains ou salle d’eau', 'Depuis la porte, téléphone droit, miroir hors de l’axe pour ne pas vous y voir.'),
        s('exterieur', 'Jardin, balcon ou vue', 'Le plus bel extérieur du bien ; sinon la vue depuis la plus belle fenêtre.'),
      ];
    }
    case 'land':
      return [
        s('vue-ensemble', 'Vue d’ensemble', 'Depuis l’accès, tout le terrain dans le cadre, horizon au tiers haut.'),
        s('acces', 'Accès', 'Le chemin ou la route d’accès, sans plaque de rue ni numéro.'),
        s('limites', 'Limites', 'Un coin du terrain, la clôture ou le bornage visible.'),
      ];
    case 'building':
      return [
        s('facade', 'Façade', 'Reculez jusqu’à voir toute la façade, sans plaque de rue ni numéro dans le cadre.'),
        s('parties-communes', 'Parties communes', 'Hall ou escalier, éclairage allumé.'),
        s('lot-type', 'Un lot type', WIDE),
      ];
    default:
      return [
        s('facade', 'Façade ou vitrine', 'Face à la vitrine, sans enseigne d’un tiers ni plaque de rue dans le cadre.'),
        s('espace-principal', 'Espace principal', WIDE),
        s('reserve', 'Réserve ou arrière', 'Depuis la porte, toute la surface dans le cadre.'),
      ];
  }
}

export type ShotState = 'a_faire' | 'faite' | 'sans_objet';

export interface ShotStatus extends Shot {
  state: ShotState;
}

export interface DepartureCheck {
  /** Vrai seulement quand chaque photo de la liste est acceptée ou dite sans objet. */
  canLeave: boolean;
  shots: ShotStatus[];
  /** Les photos qui manquent encore, dans l'ordre de la liste. */
  missing: string[];
}

/**
 * Peut-on repartir ? Le téléphone et le serveur font le même calcul, à partir des photos acceptées et des photos dites
 * sans objet [R277].
 */
export function departureCheck(plan: readonly Shot[], accepted: Iterable<string>, skipped: Iterable<string>): DepartureCheck {
  const ok = new Set(accepted);
  const none = new Set(skipped);
  const shots = plan.map((p): ShotStatus => ({ ...p, state: ok.has(p.key) ? 'faite' : none.has(p.key) ? 'sans_objet' : 'a_faire' }));
  const missing = shots.filter((x) => x.state === 'a_faire').map((x) => x.key);
  return { canLeave: missing.length === 0, shots, missing };
}
