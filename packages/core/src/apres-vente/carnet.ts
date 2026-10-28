/**
 * Carnet du propriétaire, un an après (M11, F06, « Jamais vu ») [R09, R10, R13, R65].
 *
 * Un an après l'achat, l'acquéreur devenu propriétaire reçoit, s'il a donné son accord à l'acte, le carnet de son bien :
 * - la fourchette de valeur calculée par le code depuis les ventes DVF (E01, E02), avec sa source et la date des
 *   dernières ventes ; sinon « non communiquée », avec la raison ;
 * - les ventes comparables publiées sur les douze derniers mois : surface, prix au m², mois, jamais une adresse [R09] ;
 * - l'échéance de son diagnostic énergétique, calculée selon les règles de validité ; sinon « non communiqué ».
 * Rien ne lui est demandé : aucun formulaire, aucune question. Aucun réseau ne donne cela au propriétaire, sans rien lui
 * vendre : c'est le premier contact de son futur mandat, sans jamais le lui demander.
 *
 * Chaque chiffre du carnet vient de la base ou des ventes publiques ; le code relit le carnet contre ses sources avant
 * de le ranger, et refuse tout carnet dont un chiffre n'a pas de source [R10] ou dont une tournure démarche (liste
 * fermée). Le carnet passe par la relance d'un an (F04) : jamais sans l'accord donné à l'acte [R65].
 *
 * Décidé, lecture prudente :
 * - les faits du bien vendu (type, surface, position, diagnostic) sont lus par une interface, `BiensVendus`, que M10
 *   (N06) branchera ; sans faits, pas de carnet ;
 * - validité du diagnostic énergétique : 10 ans, jusqu'à la veille de l'anniversaire ; ceux faits du 1er janvier 2013
 *   au 31 décembre 2017 ont cessé de valoir le 31 décembre 2022, ceux du 1er janvier 2018 au 30 juin 2021 le
 *   31 décembre 2024 ;
 * - les ventes de l'année : leur nombre, et les 10 plus récentes ;
 * - le carnet est rangé une fois par client et par dossier, lisible par son lien seulement, qui ne dit aucun nom ; un
 *   carnet fait reste tel quel, même si la relance qui le porte part plus tard.
 */
import type { SqlDatabase } from '../db/sql.ts';
import { Fourchette, type EnergyClass, type EstimatedKind, type RangeResult, type SalesSource } from '../estimation/fourchette.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { ClosedSale } from './demandes-avis.ts';
import { checkAfterSaleUnsubscribeBase, newAfterSaleToken } from './relances-apres-vente.ts';

/** Ce que M10 sait du bien vendu, sans adresse ni nom. */
export interface SoldPropertyFacts {
  kind: EstimatedKind | 'land' | 'building' | 'commercial' | 'business_walls' | 'business';
  surface: number | null;
  lat: number | null;
  lon: number | null;
  postalCode: string | null;
  energy: { energyClass: EnergyClass; diagnosedOn: string } | null;
}

export interface BiensVendus {
  factsOf(networkId: string, fileId: string): Promise<SoldPropertyFacts | null>;
}

export interface CarnetComparable {
  surface: number;
  pricePerM2: number;
  month: string;
}

/** Le contenu du carnet : chaque chiffre avec sa source. */
export interface Carnet {
  reference: string;
  city: string | null;
  value:
    | { known: true; low: number; high: number; comparables: number; latestSale: string; source: string; recentMissing: boolean }
    | { known: false; reason: string };
  /** Toutes les ventes comparables des douze derniers mois ; `yearSales` en montre les 10 plus récentes. */
  yearCount: number;
  yearSales: CarnetComparable[];
  energy: { known: true; energyClass: EnergyClass; diagnosedOn: string; validUntil: string; expired: boolean } | { known: false };
  /** Le jour où le carnet a été fait, `AAAA-MM-JJ`. */
  madeOn: string;
}

const REASONS: Record<string, string> = {
  type: 'ce type de bien ne se compare pas aux ventes publiées',
  adresse: 'la position ou la surface du bien manque',
  hors_zone: 'les ventes publiées de ce département ne sont pas encore chargées',
  dvf_non_couvert: 'les ventes publiées ne couvrent pas ce département',
  donnees_absentes: 'les ventes publiées ne sont pas disponibles',
  peu_de_ventes: 'trop peu de ventes comparables ont été publiées',
};

/**
 * Jusqu'à quand vaut un diagnostic énergétique fait ce jour-là : 10 ans, jusqu'à la veille de l'anniversaire, comme le
 * porte le diagnostic ; ceux faits du 1er janvier 2013 au 31 décembre 2017 ont cessé de valoir le 31 décembre 2022, ceux
 * du 1er janvier 2018 au 30 juin 2021 le 31 décembre 2024.
 */
export function energyValidUntil(diagnosedOn: string): string {
  if (diagnosedOn >= '2013-01-01' && diagnosedOn < '2018-01-01') return '2022-12-31';
  if (diagnosedOn >= '2018-01-01' && diagnosedOn < '2021-07-01') return '2024-12-31';
  const y = Number(diagnosedOn.slice(0, 4)) + 10;
  const md = diagnosedOn.slice(5);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const anniversary = `${y}-${md === '02-29' && !leap ? '03-01' : md}`;
  return new Date(Date.parse(`${anniversary}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const monthText = (ym: string): string => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const dayText = (d: string): string => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const euros = (n: number): string => `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} €`;

/** Les tournures de démarchage, refusées dans un carnet (liste fermée). */
export const SOLICITATION =
  /vendre maintenant|vendez|mettre en vente|mise en vente|estimation gratuite|estimation offerte|faites estimer|faire estimer|profitez|c.est le moment|n.attendez pas|offre spéciale|promotion|gratuit|contactez-nous pour vendre|bon moment pour vendre/i;

/** Le carnet en texte, pour la page du lien. Aucun nom, aucune adresse [R09]. */
export function carnetText(c: Carnet): string {
  const lines: string[] = [];
  lines.push(`Le carnet de votre bien${c.city ? ` à ${c.city}` : ''}, référence ${c.reference}, un an après votre achat.`);
  if (c.value.known) {
    lines.push(
      `Valeur : entre ${euros(c.value.low)} et ${euros(c.value.high)}, calculée d'après ${c.value.comparables} ventes comparables publiées, la plus récente en ${monthText(c.value.latestSale)}. Source : ${c.value.source}.${c.value.recentMissing ? ' Les ventes des derniers mois ne sont pas encore publiées.' : ''}`,
    );
  } else {
    lines.push(`Valeur : non communiquée, car ${c.value.reason}.`);
  }
  if (c.yearSales.length > 0) {
    lines.push(
      c.yearCount > c.yearSales.length
        ? `Ventes comparables publiées sur les douze derniers mois : ${c.yearCount}, dont les ${c.yearSales.length} plus récentes :`
        : `Ventes comparables publiées sur les douze derniers mois : ${c.yearCount}.`,
    );
    for (const s of c.yearSales) lines.push(`- ${s.surface} m², ${euros(s.pricePerM2)} le m², ${monthText(s.month)}`);
  } else {
    lines.push('Ventes comparables publiées sur les douze derniers mois : non communiquées.');
  }
  if (c.energy.known) {
    lines.push(
      c.energy.expired
        ? `Diagnostic énergétique : classe ${c.energy.energyClass}, fait le ${dayText(c.energy.diagnosedOn)}, il n'est plus valable depuis le ${dayText(c.energy.validUntil)}.`
        : `Diagnostic énergétique : classe ${c.energy.energyClass}, fait le ${dayText(c.energy.diagnosedOn)}, valable jusqu'au ${dayText(c.energy.validUntil)}.`,
    );
  } else {
    lines.push('Diagnostic énergétique : non communiqué.');
  }
  lines.push('Ce carnet ne vous demande rien. Votre agent immobilier reste là pour toute question sur votre bien.');
  return lines.join('\n');
}

/** Les nombres d'un texte, groupes de milliers réunis. */
function numbersIn(text: string): string[] {
  return (text.match(/\d{1,3}(?: \d{3})+|\d+/g) ?? []).map((n) => String(Number(n.replace(/ /g, ''))));
}

/** Les nombres que les sources du carnet autorisent. */
function sourceNumbers(c: Carnet): Set<string> {
  const out: (string | number)[] = [];
  const day = (d: string) => [Number(d.slice(0, 4)), Number(d.slice(5, 7)), Number(d.slice(8, 10))];
  out.push(...(c.reference.match(/\d+/g) ?? []), ...(c.city?.match(/\d+/g) ?? []));
  if (c.value.known) out.push(c.value.low, c.value.high, c.value.comparables, Number(c.value.latestSale.slice(0, 4)), ...(c.value.source.match(/\d+/g) ?? []));
  out.push(c.yearCount, c.yearSales.length);
  for (const s of c.yearSales) out.push(s.surface, s.pricePerM2, Number(s.month.slice(0, 4)));
  if (c.energy.known) out.push(...day(c.energy.diagnosedOn), ...day(c.energy.validUntil));
  // « douze derniers mois » s'écrit en toutes lettres ; « m² » porte son exposant, qui n'est pas un chiffre ASCII.
  return new Set(out.map((n) => String(Number(n))));
}

export type CarnetProblem = { rule: 'R10' | 'R09' | 'demarchage'; detail: string };

/** Relit le carnet contre ses sources : chaque chiffre a la sienne [R10], aucune tournure ne démarche, aucune adresse [R09]. */
export function checkCarnet(c: Carnet): CarnetProblem[] {
  const text = carnetText(c);
  const problems: CarnetProblem[] = [];
  const allowed = sourceNumbers(c);
  for (const n of numbersIn(text)) if (!allowed.has(n)) problems.push({ rule: 'R10', detail: n });
  if (SOLICITATION.test(text)) problems.push({ rule: 'demarchage', detail: 'tournure de démarchage' });
  if (/\b\d{1,4}\s?(?:bis|ter)?,?\s+(?:rue|avenue|boulevard|place|chemin|allée|impasse|route|quai)\b/i.test(text)) problems.push({ rule: 'R09', detail: 'adresse' });
  return problems;
}

/**
 * Relit un carnet contre ses sources : refait le carnet depuis les faits du bien et les ventes publiques, et exige le
 * même contenu, puis chaque chiffre du texte dans ce contenu, et aucune tournure de démarchage [R10].
 */
export async function verifyCarnet(c: Carnet, sale: Pick<ClosedSale, 'reference' | 'city'>, facts: SoldPropertyFacts, sales: SalesSource, now: Date): Promise<CarnetProblem[]> {
  const again = await buildCarnet(sale, facts, sales, now);
  if (JSON.stringify(again) !== JSON.stringify(c)) return [{ rule: 'R10', detail: 'le carnet ne correspond pas à ses sources' }];
  return checkCarnet(c);
}

/** Fait le carnet d'un bien, depuis ses faits et les ventes publiques. */
export async function buildCarnet(sale: Pick<ClosedSale, 'reference' | 'city'>, facts: SoldPropertyFacts, sales: SalesSource, now: Date): Promise<Carnet> {
  const fourchette = new Fourchette(sales, undefined, () => now);
  const r: RangeResult = await fourchette.estimate({ kind: facts.kind, surface: facts.surface, lat: facts.lat, lon: facts.lon, postalCode: facts.postalCode, energyClass: facts.energy?.energyClass ?? null });
  const madeOn = now.toISOString().slice(0, 10);
  const yearAgo = `${Number(madeOn.slice(0, 4)) - 1}-${madeOn.slice(5, 7)}`;
  const value: Carnet['value'] =
    r.ok && r.data.source
      ? { known: true, low: r.low, high: r.high, comparables: r.comparables.length, latestSale: r.latestUsedSale, source: r.data.source, recentMissing: r.data.recentMissing }
      : { known: false, reason: REASONS[r.ok ? 'donnees_absentes' : r.reason] ?? REASONS['donnees_absentes']! };
  const inYear = r.ok ? r.comparables.filter((s) => s.month > yearAgo).sort((a, b) => b.month.localeCompare(a.month) || a.distance - b.distance) : [];
  const yearSales = inYear.slice(0, 10).map((s) => ({ surface: Math.round(s.surface), pricePerM2: Math.round(s.pricePerM2), month: s.month }));
  let energy: Carnet['energy'] = { known: false };
  if (facts.energy && /^\d{4}-\d{2}-\d{2}$/.test(facts.energy.diagnosedOn)) {
    const validUntil = energyValidUntil(facts.energy.diagnosedOn);
    energy = { known: true, energyClass: facts.energy.energyClass, diagnosedOn: facts.energy.diagnosedOn, validUntil, expired: validUntil < madeOn };
  }
  return { reference: sale.reference, city: sale.city, value, yearCount: inYear.length, yearSales, energy, madeOn };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class CarnetsProprietaire {
  private readonly now: () => Date;
  private readonly base: string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly biens: BiensVendus,
    private readonly sales: SalesSource,
    options: { now?: () => Date; base: string },
  ) {
    this.now = options.now ?? (() => new Date());
    const base = checkAfterSaleUnsubscribeBase(options.base);
    if (!base) throw new Error('Le lien du carnet est en https, sans chiffre, terminé par « / ».');
    this.base = base;
  }

  /**
   * Fait et range le carnet de ce client pour ce dossier, une seule fois, et rend un lien neuf vers lui ; `null` sans
   * faits du bien, ou si le carnet ne passe pas sa relecture contre ses sources : la relance part alors sans carnet.
   */
  async create(networkId: string, sale: ClosedSale, personId: string): Promise<string | null> {
    const facts = await this.biens.factsOf(networkId, sale.fileId);
    if (!facts) {
      await appendEvent(this.journal, { type: 'apres_vente.carnet', actor: 'system:apres-vente', subject: `sale_file:${sale.fileId}`, data: { status: 'sans_faits' } }, this.now);
      return null;
    }
    const carnet = await buildCarnet(sale, facts, this.sales, this.now());
    const problems = await verifyCarnet(carnet, sale, facts, this.sales, this.now());
    if (problems.length > 0) {
      await appendEvent(this.journal, { type: 'apres_vente.carnet', actor: 'system:apres-vente', subject: `sale_file:${sale.fileId}`, data: { status: 'refuse', rules: [...new Set(problems.map((p) => p.rule))] } }, this.now);
      return null;
    }
    // Le carnet se fait une fois ; chaque relance qui le porte reçoit son propre lien, pour qu'un essai refusé pour
    // l'heure ne laisse pas la relance suivante sans carnet.
    const { changes } = await this.db.run(
      'INSERT INTO owner_booklets (file_id, person_id, network_id, agent_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [sale.fileId, personId, networkId, sale.agentId, JSON.stringify(carnet), this.now().toISOString()],
    );
    if (changes === 1) {
      await appendEvent(this.journal, { type: 'apres_vente.carnet', actor: 'system:apres-vente', subject: `sale_file:${sale.fileId}`, data: { status: 'fait', value: carnet.value.known, energy: carnet.energy.known, yearSales: carnet.yearSales.length } }, this.now);
    }
    const token = newAfterSaleToken();
    await this.db.run('INSERT INTO owner_booklet_links (token_hash, file_id, person_id, created_at) VALUES (?, ?, ?, ?)', [await sha256(token), sale.fileId, personId, this.now().toISOString()]);
    return `${this.base}${token}`;
  }

  /** Le carnet, par son lien seulement ; `null` pour un lien inconnu. */
  async read(token: string): Promise<{ carnet: Carnet; text: string } | null> {
    if (typeof token !== 'string' || !/^[a-z]{32}$/.test(token)) return null;
    const row = await this.db.first<{ content: string }>(
      'SELECT b.content FROM owner_booklet_links l JOIN owner_booklets b ON b.file_id = l.file_id AND b.person_id = l.person_id WHERE l.token_hash = ?',
      [await sha256(token)],
    );
    if (!row) return null;
    const carnet = JSON.parse(row.content) as Carnet;
    return { carnet, text: carnetText(carnet) };
  }
}
