/**
 * Le mois scellé, puis publié, vérifiable par n'importe qui (IN02, « Jamais vu ») [R212, R213, R17, R13, R14].
 *
 * La direction scelle un mois fini : elle donne son comptage manuel, le code le compare et refuse un écart. Le sceau
 * fige le compte et enchaîne son empreinte à celle du sceau d'avant. Une annulation après coup ne réécrit rien : le mois
 * se dit changé depuis son sceau jusqu'à son nouveau sceau, et l'ancien reste lisible. La condition publique ne se lit
 * que sur des mois scellés, tous encore exacts, dans une chaîne saine.
 *
 * Ce qui est public : les comptes, les numéros du registre et les empreintes. Jamais un nom, une adresse, un agent ni un
 * identifiant interne. Chacun recalcule tout avec `proofLinesDigest` et `proofSealHash`, écrits sur la page ; un mandant
 * retrouve le numéro de son mandat dans son mois.
 */
import { decideAccess, type Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { sha256 } from '../documents/modeles.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { RegistreMandats } from '../mandats/registre.ts';
import { CompteurPreuve, PROOF_MONTHLY_TARGET, PROOF_REQUIRED_MONTHS, PROOF_START_MONTH, parisMonth, proofRuns, type ProofMonth } from './preuve.ts';

export const PROOF_SEAL_GENESIS = '0'.repeat(64);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface ProofLine {
  number: string;
  /** L'empreinte de la ligne du registre [R39]. */
  hash: string;
}

/** Un sceau, exactement tel qu'il est publié : tout ce qu'il faut pour le recalculer, rien de plus. */
export interface PublicProofSeal {
  seq: number;
  month: string;
  counted: number;
  simple: number;
  exclusive: number;
  untyped: number;
  terminated: number;
  withdrawn: number;
  cancelledError: number;
  lines: ProofLine[];
  linesDigest: string;
  sealedAt: string;
  prevHash: string;
  hash: string;
}

export interface PublicProofMonth {
  month: string;
  /** Le compte du dernier sceau, `null` pour un mois fini pas encore scellé. */
  counted: number | null;
  sealSeq: number | null;
  /** Vrai quand le mois a déjà porté un autre sceau : la correction se voit. */
  corrected: boolean;
  /** Vrai quand le registre ne dit plus ce que dit le sceau : le mois attend un nouveau sceau. */
  changedSinceSeal: boolean;
}

export interface PublicProof {
  startMonth: string;
  target: number;
  requiredMonths: number;
  months: PublicProofMonth[];
  seals: PublicProofSeal[];
  chainSound: boolean;
  registerSound: boolean;
  condition: { met: boolean; metOn: string | null };
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem =
  | { ok: false; rule: null; code: 'bad_input' | 'conflict' }
  | { ok: false; rule: 'R212'; code: 'month_not_finished' | 'register_broken' | 'not_inscribed' | 'already_sealed'; notInscribed?: number }
  | { ok: false; rule: 'R212'; code: 'count_mismatch'; counted: number; given: number };

interface SealRow {
  seq: number;
  month: string;
  counted: number;
  simple: number;
  exclusive: number;
  untyped: number;
  terminated: number;
  withdrawn: number;
  cancelled_error: number;
  lines: string;
  lines_digest: string;
  sealed_at: string;
  prev_hash: string;
  hash: string;
}

/** L'empreinte des lignes d'un mois : `numéro:empreinte`, une par ligne, triées par numéro. */
export const proofLinesDigest = (lines: readonly ProofLine[]): Promise<string> => sha256(lines.map((l) => `${l.number}:${l.hash}\n`).join(''));

/** L'empreinte d'un sceau : le tableau JSON de ses champs, dans cet ordre. */
export const proofSealHash = (s: Omit<PublicProofSeal, 'hash' | 'lines'>): Promise<string> => sha256(JSON.stringify([s.seq, s.month, s.counted, s.simple, s.exclusive, s.untyped, s.terminated, s.withdrawn, s.cancelledError, s.linesDigest, s.sealedAt, s.prevHash]));

const toPublic = (r: SealRow): PublicProofSeal => ({
  seq: Number(r.seq),
  month: r.month,
  counted: Number(r.counted),
  simple: Number(r.simple),
  exclusive: Number(r.exclusive),
  untyped: Number(r.untyped),
  terminated: Number(r.terminated),
  withdrawn: Number(r.withdrawn),
  cancelledError: Number(r.cancelled_error),
  lines: JSON.parse(r.lines) as ProofLine[],
  linesDigest: r.lines_digest,
  sealedAt: r.sealed_at,
  prevHash: r.prev_hash,
  hash: r.hash,
});

/** Ce que dit le registre aujourd'hui est-il encore ce que dit le sceau ? */
const sameFigures = (s: PublicProofSeal, m: ProofMonth, digest: string): boolean =>
  s.counted === m.counted && s.simple === m.simple && s.exclusive === m.exclusive && s.untyped === m.untyped && s.terminated === m.terminated && s.withdrawn === m.withdrawn && s.cancelledError === m.cancelledError && s.linesDigest === digest;

export class SceauxPreuve {
  private readonly now: () => Date;
  private readonly compteur: CompteurPreuve;
  private readonly registre: RegistreMandats;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.compteur = new CompteurPreuve(db, journal, { now: this.now });
    this.registre = new RegistreMandats(db, journal, { now: this.now });
  }

  private async rows(networkId: string): Promise<SealRow[]> {
    return this.db.all<SealRow>('SELECT seq, month, counted, simple, exclusive, untyped, terminated, withdrawn, cancelled_error, lines, lines_digest, sealed_at, prev_hash, hash FROM proof_seals WHERE network_id = ? ORDER BY seq', [networkId]);
  }

  /** Scelle un mois fini, si le comptage manuel est celui du registre [R212]. */
  async seal(viewer: Viewer, input: { month: unknown; manualCount: unknown }): Promise<{ ok: true; value: PublicProofSeal } | Refusal | Problem> {
    const d = viewer.role === 'direction' ? decideAccess(viewer, { kind: 'figures', networkId: viewer.networkId, agentId: viewer.userId }) : null;
    if (!d || !d.allowed) {
      const code = d && !d.allowed ? d.code : 'role';
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'proof_seal', code } }, this.now);
      return { ok: false, rule: 'R16', code };
    }
    const { month, manualCount } = input;
    if (typeof month !== 'string' || !MONTH.test(month) || typeof manualCount !== 'number' || !Number.isSafeInteger(manualCount) || manualCount < 0) return { ok: false, rule: null, code: 'bad_input' };
    if (month < PROOF_START_MONTH || month >= parisMonth(this.now())) return { ok: false, rule: 'R212', code: 'month_not_finished' };
    const live = await this.compteur.compute(viewer.networkId);
    if (!live.registerSound) return { ok: false, rule: 'R212', code: 'register_broken' };
    const figures = live.months.find((m) => m.month === month);
    if (!figures) return { ok: false, rule: 'R212', code: 'month_not_finished' };
    if (figures.notInscribed > 0) return { ok: false, rule: 'R212', code: 'not_inscribed', notInscribed: figures.notInscribed };
    if (figures.counted !== manualCount) return { ok: false, rule: 'R212', code: 'count_mismatch', counted: figures.counted, given: manualCount };

    const lines = await this.compteur.countedLines(viewer.networkId, month);
    const linesDigest = await proofLinesDigest(lines);
    const rows = (await this.rows(viewer.networkId)).map(toPublic);
    const latest = rows.filter((r) => r.month === month).at(-1);
    if (latest && sameFigures(latest, figures, linesDigest)) return { ok: false, rule: 'R212', code: 'already_sealed' };

    const last = rows.at(-1);
    const body = {
      seq: (last?.seq ?? 0) + 1,
      month,
      counted: figures.counted,
      simple: figures.simple,
      exclusive: figures.exclusive,
      untyped: figures.untyped,
      terminated: figures.terminated,
      withdrawn: figures.withdrawn,
      cancelledError: figures.cancelledError,
      linesDigest,
      sealedAt: this.now().toISOString(),
      prevHash: last?.hash ?? PROOF_SEAL_GENESIS,
    };
    const hash = await proofSealHash(body);
    try {
      await this.db.run(
        `INSERT INTO proof_seals (network_id, seq, month, counted, simple, exclusive, untyped, terminated, withdrawn, cancelled_error, lines, lines_digest, sealed_at, sealed_by, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [viewer.networkId, body.seq, month, body.counted, body.simple, body.exclusive, body.untyped, body.terminated, body.withdrawn, body.cancelledError, JSON.stringify(lines), linesDigest, body.sealedAt, `${String(viewer.role)}:${viewer.userId}`, body.prevHash, hash],
      );
    } catch {
      // Deux sceaux en même temps : le rang est pris, rien n'est écrit ; la direction recommence.
      return { ok: false, rule: null, code: 'conflict' };
    }
    await appendEvent(this.journal, { type: 'preuve.sceau', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { month, seq: body.seq, counted: body.counted, hash } }, this.now);
    return { ok: true, value: { ...body, lines, hash } };
  }

  /** La chaîne recalculée : chaque lien, chaque empreinte, chaque compte. */
  private async chainSound(seals: readonly PublicProofSeal[]): Promise<boolean> {
    let prev = PROOF_SEAL_GENESIS;
    for (const [i, s] of seals.entries()) {
      if (s.seq !== i + 1 || s.prevHash !== prev || s.counted !== s.lines.length) return false;
      if ((await proofLinesDigest(s.lines)) !== s.linesDigest) return false;
      if ((await proofSealHash(s)) !== s.hash) return false;
      prev = s.hash;
    }
    return true;
  }

  /** Ce que la page publique rend, sans droits : aucune donnée personnelle, aucun chiffre vivant que le sceau ne dise [R213]. */
  async publication(networkId: string): Promise<PublicProof> {
    const seals = (await this.rows(networkId)).map(toPublic);
    const live = await this.compteur.compute(networkId);
    const chainSound = await this.chainSound(seals);
    const registerSound = (await this.registre.check(networkId)).ok;
    const months: PublicProofMonth[] = [];
    for (const m of live.months) {
      if (!m.complete) continue;
      const mine = seals.filter((s) => s.month === m.month);
      const latest = mine.at(-1);
      const digest = await proofLinesDigest(await this.compteur.countedLines(networkId, m.month));
      months.push({
        month: m.month,
        counted: latest?.counted ?? null,
        sealSeq: latest?.seq ?? null,
        corrected: mine.length > 1,
        changedSinceSeal: latest ? !sameFigures(latest, m, digest) : false,
      });
    }
    const runs = proofRuns(months.map((m) => ({ month: m.month, complete: true, targetMet: m.counted !== null && m.counted >= PROOF_MONTHLY_TARGET && !m.changedSinceSeal })));
    return {
      startMonth: PROOF_START_MONTH,
      target: PROOF_MONTHLY_TARGET,
      requiredMonths: PROOF_REQUIRED_MONTHS,
      months,
      seals,
      chainSound,
      registerSound,
      condition: chainSound && registerSound ? runs.condition : { met: false, metOn: null },
    };
  }
}

const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const MONTH_NAMES = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const monthName = (m: string): string => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]!} ${m.slice(0, 4)}`;

/** Le corps de la page publique, en HTML sûr : le cadre vient de `renderPublicPage` [R201]. */
export function proofPageBody(p: PublicProof): string {
  const rows = p.months
    .map((m) => {
      const state = m.counted === null ? 'Pas encore scellé' : m.changedSinceSeal ? 'Changé depuis son sceau, nouveau sceau à venir' : m.corrected ? 'Corrigé, l’ancien sceau reste lisible' : 'Scellé';
      const seal = p.seals.find((s) => s.seq === m.sealSeq);
      return `<tr><th scope="row">${esc(monthName(m.month))}</th><td>${m.counted === null ? '—' : m.counted}</td><td>${esc(state)}</td><td><code>${seal ? esc(seal.hash.slice(0, 12)) : '—'}</code></td></tr>`;
    })
    .join('');
  const table = rows
    ? `<table><caption>Mandats de vente signés et inscrits au registre, par mois</caption><thead><tr><th scope="col">Mois</th><th scope="col">Mandats</th><th scope="col">État</th><th scope="col">Sceau</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p>Aucun mois fini pour l’instant : le compte commence en ${esc(monthName(p.startMonth))}.</p>`;
  const warning = !p.chainSound || !p.registerSound ? '<p role="alert"><strong>Un contrôle d’intégrité a échoué : ces chiffres sont à vérifier avant toute lecture.</strong></p>' : '';
  const condition = p.condition.met && p.condition.metOn ? `<p><strong>Condition remplie en ${esc(monthName(p.condition.metOn))}.</strong></p>` : '<p>Condition pas encore remplie.</p>';
  return (
    warning +
    `<p>L’objectif : ${p.target} mandats de vente signés par mois, ${p.requiredMonths} mois de suite, comptés à partir de ${esc(monthName(p.startMonth))}. Ce compte dit ce qui s’est passé, il ne promet rien pour la suite.</p>` +
    condition +
    table +
    `<h2>Vérifier soi-même</h2><p>Chaque mois fini est comparé à un comptage manuel, puis scellé. Un sceau ne se réécrit pas : une correction ajoute un sceau, et l’ancien reste lisible. Le fichier <a href="/preuve.json">preuve.json</a> donne tous les sceaux, sans aucun nom ni adresse.</p>` +
    `<ul><li>Empreinte du mois (<code>linesDigest</code>) : SHA-256 du texte <code>numéro:empreinte</code> de chaque ligne de <code>lines</code>, suivi d’un retour à la ligne.</li>` +
    `<li>Empreinte du sceau (<code>hash</code>) : SHA-256 du tableau JSON <code>[seq, month, counted, simple, exclusive, untyped, terminated, withdrawn, cancelledError, linesDigest, sealedAt, prevHash]</code>.</li>` +
    `<li><code>prevHash</code> est l’empreinte du sceau d’avant, 64 zéros pour le premier.</li>` +
    `<li>Vous avez signé un mandat ? Son numéro figure sur votre exemplaire : cherchez-le dans le mois de sa signature.</li></ul>`
  );
}
