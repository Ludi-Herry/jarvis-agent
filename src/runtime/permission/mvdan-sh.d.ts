/**
 * Minimal ambient types for `mvdan-sh` (the JS build of mvdan/sh — a real POSIX/Bash parser).
 * The package ships no types; its AST nodes are dynamic (GopherJS) objects whose fields we read
 * by name, so a node is typed as an indexable record and each field access is cast explicitly via
 * small helpers (str/arr/obj) — no `any`, no bypass markers.
 */
declare module 'mvdan-sh' {
  export interface ShNode {
    readonly [key: string]: unknown;
  }
  export interface Parser {
    Parse(src: string, name: string): ShNode;
  }
  export interface Syntax {
    NewParser(...opts: unknown[]): Parser;
    Variant(lang: unknown): unknown;
    LangBash: unknown;
    LangPOSIX: unknown;
    /** Pre-order walk; `fn` is called with each node, then with `null` when leaving it. */
    Walk(node: ShNode, fn: (node: ShNode | null) => boolean): void;
    NodeType(node: ShNode): string;
  }
  const mod: { syntax: Syntax };
  export default mod;
}
