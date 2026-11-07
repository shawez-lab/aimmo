/**
 * La boîte d'envoi du téléphone (HX12) [R276].
 *
 * Sans réseau, chaque saisie de la visite est rangée sur le téléphone avec son identifiant, tiré une fois pour toutes,
 * et son numéro d'ordre. Au retour du réseau, tout part dans l'ordre. Une saisie ne quitte la boîte que sur une réponse
 * du serveur qui la nomme : reçue, déjà reçue, ou refusée (gardée alors à part, pour que l'agent la voie). Une coupure
 * pendant l'envoi ne perd rien ; le même envoi rejoué ne fait jamais de doublon, puisque le serveur reconnaît
 * l'identifiant.
 *
 * Le rangement est une interface : IndexedDB dans le navigateur, une liste en mémoire dans les tests.
 */

export const OP_KINDS = ['visite.note', 'visite.photo', 'visite.sans_objet'] as const;
export type OpKind = (typeof OP_KINDS)[number];

/** Une saisie faite hors ligne. */
export interface PendingOp {
  opId: string;
  seq: number;
  kind: OpKind;
  appointmentId: string;
  /** L'heure du téléphone au moment de la saisie. */
  writtenAt: string;
  payload: Record<string, unknown>;
}

export interface RefusedOp extends PendingOp {
  code: string;
  rule: string | null;
}

/** Ce que la boîte garde sur le téléphone. */
export interface OutboxState {
  deviceId: string;
  nextSeq: number;
  pending: PendingOp[];
  refused: RefusedOp[];
}

export interface OutboxStorage {
  load(): Promise<OutboxState | null>;
  save(state: OutboxState): Promise<void>;
}

/** La réponse du serveur, saisie par saisie. */
export interface OpResult {
  opId: string;
  outcome: 'applique' | 'refuse';
  /** Vrai quand le serveur avait déjà reçu cette saisie : rien n'a été refait. */
  again: boolean;
  code?: string | null;
  rule?: string | null;
}

export type Transport = (batch: { deviceId: string; ops: PendingOp[] }) => Promise<{ results: OpResult[] }>;

/** Au plus tant de saisies par envoi. */
export const BATCH_SIZE = 50;

export interface FlushReport {
  /** Vrai si le réseau a manqué pendant l'envoi : ce qui n'a pas de réponse reste dans la boîte. */
  offline: boolean;
  sent: number;
  refused: number;
  left: number;
}

export class Outbox {
  private state: OutboxState | null = null;
  private flushing: Promise<FlushReport> | null = null;

  constructor(
    private readonly storage: OutboxStorage,
    private readonly options: { newId?: () => string; now?: () => Date } = {},
  ) {}

  private newId(): string {
    return (this.options.newId ?? (() => crypto.randomUUID()))();
  }

  private async current(): Promise<OutboxState> {
    if (this.state) return this.state;
    const loaded = await this.storage.load();
    this.state = loaded ?? { deviceId: this.newId(), nextSeq: 1, pending: [], refused: [] };
    if (!loaded) await this.storage.save(this.state);
    return this.state;
  }

  /** Ranger une saisie : elle est sur le téléphone avant que la fonction rende la main. */
  async add(kind: OpKind, appointmentId: string, payload: Record<string, unknown>): Promise<PendingOp> {
    const s = await this.current();
    const op: PendingOp = { opId: this.newId(), seq: s.nextSeq, kind, appointmentId, writtenAt: (this.options.now ?? (() => new Date()))().toISOString(), payload };
    const next: OutboxState = { ...s, nextSeq: s.nextSeq + 1, pending: [...s.pending, op] };
    await this.storage.save(next);
    this.state = next;
    return op;
  }

  async pending(): Promise<PendingOp[]> {
    return [...(await this.current()).pending];
  }

  async refused(): Promise<RefusedOp[]> {
    return [...(await this.current()).refused];
  }

  /** Tout envoyer, dans l'ordre, par lots. Deux appels en même temps n'en font qu'un. */
  flush(transport: Transport): Promise<FlushReport> {
    if (!this.flushing) this.flushing = this.doFlush(transport).finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async doFlush(transport: Transport): Promise<FlushReport> {
    let sent = 0;
    let refused = 0;
    for (;;) {
      const s = await this.current();
      const batch = [...s.pending].sort((a, b) => a.seq - b.seq).slice(0, BATCH_SIZE);
      if (batch.length === 0) return { offline: false, sent, refused, left: 0 };
      let results: OpResult[];
      try {
        const r = await transport({ deviceId: s.deviceId, ops: batch });
        results = Array.isArray(r?.results) ? r.results : [];
      } catch {
        return { offline: true, sent, refused, left: s.pending.length };
      }
      const byId = new Map<string, OpResult>();
      const asked = new Set(batch.map((o) => o.opId));
      for (const r of results) if (r && typeof r.opId === 'string' && asked.has(r.opId)) byId.set(r.opId, r);
      const now = await this.current();
      const keep: PendingOp[] = [];
      const newlyRefused: RefusedOp[] = [];
      for (const op of now.pending) {
        const r = byId.get(op.opId);
        if (!r) keep.push(op);
        else if (r.outcome === 'applique') sent++;
        else if (r.outcome === 'refuse') {
          refused++;
          newlyRefused.push({ ...op, code: typeof r.code === 'string' ? r.code : 'refuse', rule: typeof r.rule === 'string' ? r.rule : null });
        } else keep.push(op);
      }
      const next: OutboxState = { ...now, pending: keep, refused: [...now.refused, ...newlyRefused] };
      await this.storage.save(next);
      this.state = next;
      // Une réponse qui ne nomme aucune saisie du lot : on s'arrête là, rien n'est perdu, la suite repartira.
      if (byId.size === 0) return { offline: false, sent, refused, left: keep.length };
    }
  }
}

/** Un rangement en mémoire, pour les tests et pour un navigateur sans IndexedDB. */
export class MemoryOutboxStorage implements OutboxStorage {
  saved: OutboxState | null = null;
  async load(): Promise<OutboxState | null> {
    return this.saved ? structuredClone(this.saved) : null;
  }
  async save(state: OutboxState): Promise<void> {
    this.saved = structuredClone(state);
  }
}
