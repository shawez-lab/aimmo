/**
 * Un petit document inventé pour faire tourner le script de l'application de l'agent dans les tests, sans
 * navigateur. Il ne sait pas lire du HTML : un texte posé reste un texte, ce qui est exactement ce que le script doit
 * faire.
 */
export class FakeElement {
  hidden = true;
  value = '';
  checked = false;
  className = '';
  children: FakeElement[] = [];
  attributes: Record<string, string> = {};
  listeners: Record<string, (e: unknown) => void> = {};
  private text = '';

  constructor(
    readonly tagName: string,
    readonly id: string | null = null,
  ) {}

  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.children = [];
    this.text = v;
  }
  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
  insertBefore(child: FakeElement, before: FakeElement): FakeElement {
    const at = this.children.indexOf(before);
    this.children.splice(at < 0 ? this.children.length : at, 0, child);
    return child;
  }
  removeChild(child: FakeElement): FakeElement {
    this.children = this.children.filter((c) => c !== child);
    return child;
  }
  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
  }
  addEventListener(name: string, f: (e: unknown) => void): void {
    this.listeners[name] = f;
  }
  /** Un clic du script sur l'élément (un lien de téléchargement, par exemple) : compté, et son écouteur appelé. */
  clicks = 0;
  click(): void {
    this.clicks += 1;
    this.listeners.click?.({});
  }
  /** L'élément qui a le focus, dans le dernier document créé par `fakeDocument`. */
  static active: FakeElement | null = null;
  focus(): void {
    FakeElement.active = this;
  }
  /** Tous les éléments en dessous, en profondeur. */
  all(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
}

/** Les éléments de la page qui portent un `id`, tels que le script les cherche. */
export function fakeDocument(ids: readonly string[]) {
  const els: Record<string, FakeElement> = {};
  for (const id of ids) els[id] = new FakeElement('div', id);
  const listeners: Record<string, () => void> = {};
  FakeElement.active = null;
  const document = {
    get activeElement() {
      return FakeElement.active;
    },
    getElementById: (id: string) => els[id],
    createElement: (tag: string) => new FakeElement(tag),
    addEventListener: (n: string, f: () => void) => (listeners[n] = f),
  };
  return { els, listeners, document };
}

/** Les `id` de la page servie, lus dans son HTML. */
export const pageIds = (html: string): string[] => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
