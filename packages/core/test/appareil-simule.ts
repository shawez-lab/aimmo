// Un appareil simulé pour les tests des clés d'accès (HX56, BR05) : une vraie paire de clés P-256, signée comme un téléphone.
import type { AssertionPayload, Challenge } from '../src/securite/index.ts';
import { sha256, toBase64Url } from '../src/securite/webauthn.ts';

export const RP = 'app.aimmo.test';
export const ORIGIN = 'https://app.aimmo.test';

type CryptoKeyPair = { publicKey: Parameters<typeof crypto.subtle.exportKey>[1]; privateKey: Parameters<typeof crypto.subtle.sign>[1] };

/** Un appareil simulé : une vraie paire de clés P-256, signée comme le fait un téléphone. */
export class FakeAuthenticator {
  count = 0;
  constructor(
    readonly keys: CryptoKeyPair,
    readonly credentialId: Uint8Array,
    readonly flags = 0x05,
  ) {}

  static async create(seed: number, flags = 0x05): Promise<FakeAuthenticator> {
    const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    return new FakeAuthenticator(keys, new Uint8Array(16).fill(seed), flags);
  }

  async authData(withCredential: boolean, rpId = RP, flags = this.flags): Promise<Uint8Array> {
    const head = new Uint8Array(37);
    head.set(await sha256(rpId), 0);
    head[32] = flags | (withCredential ? 0x40 : 0);
    new DataView(head.buffer).setUint32(33, this.count);
    if (!withCredential) return head;
    const out = new Uint8Array(37 + 18 + this.credentialId.length + 1);
    out.set(head, 0);
    out[53] = 0;
    out[54] = this.credentialId.length;
    out.set(this.credentialId, 55);
    out[out.length - 1] = 0xa0; // une clé COSE vide : seule la clé SPKI compte ici
    return out;
  }

  async register(c: Challenge, over: { origin?: string; type?: string; flags?: number } = {}) {
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: over.type ?? 'webauthn.create', challenge: c.challenge, origin: over.origin ?? ORIGIN }));
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', this.keys.publicKey));
    return {
      challengeId: c.challengeId,
      credentialId: toBase64Url(this.credentialId),
      publicKey: toBase64Url(spki),
      clientDataJSON: toBase64Url(clientDataJSON),
      authenticatorData: toBase64Url(await this.authData(true, RP, over.flags ?? this.flags)),
      label: 'Téléphone',
    };
  }

  async sign(c: Challenge, over: { origin?: string; type?: string; rpId?: string; challenge?: string; flags?: number; keepCount?: boolean } = {}): Promise<AssertionPayload> {
    if (!over.keepCount) this.count += 1;
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: over.type ?? 'webauthn.get', challenge: over.challenge ?? c.challenge, origin: over.origin ?? ORIGIN }));
    const authenticatorData = await this.authData(false, over.rpId ?? RP, over.flags ?? this.flags);
    const hash = await sha256(clientDataJSON);
    const signed = new Uint8Array([...authenticatorData, ...hash]);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, signed));
    return {
      challengeId: c.challengeId,
      credentialId: toBase64Url(this.credentialId),
      clientDataJSON: toBase64Url(clientDataJSON),
      authenticatorData: toBase64Url(authenticatorData),
      signature: toBase64Url(rawToDer(raw)),
    };
  }
}

function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0 && !(b[i + 1]! & 0x80)) i += 1;
    const v = b.slice(i);
    return v[0]! & 0x80 ? new Uint8Array([0, ...v]) : v;
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return new Uint8Array([0x30, r.length + s.length + 4, 0x02, r.length, ...r, 0x02, s.length, ...s]);
}
