/**
 * preview-policy — batch 3 §C10/§C11: the pure decision behind the drawer preview tab's address
 * bar. The server/app never guesses; every input lands in exactly one bucket:
 *  - `loopback`         — http(s)://127.0.0.1|localhost|[::1] any port: open directly (local dev
 *                         preview is the real need).
 *  - `external-confirm` — any other http(s) host: the UI must first show the honest confirmation
 *                         line (the site may refuse framing via X-Frame-Options/CSP).
 *  - `reject`           — non-http(s)/empty/control characters: refused with the real reason.
 *
 * Pure function, no I/O (project AGENTS.md: decision points are pure + unit tested). Exported for
 * the GUI app to reuse (`import … from '../../../preview-policy.js`, same posture as live-types).
 */

export type GuiPreviewSource =
  | { kind: 'loopback'; normalized: string }
  | { kind: 'external-confirm'; normalized: string }
  | { kind: 'reject'; reason: string };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const hasControlChar = (text: string): boolean => {
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
};

export function resolvePreviewSource(url: string): GuiPreviewSource {
  if (typeof url !== 'string') return { kind: 'reject', reason: '预览地址必须是文本' };
  const input = url.trim();
  if (input === '') return { kind: 'reject', reason: '预览地址为空' };
  if (hasControlChar(input)) return { kind: 'reject', reason: '预览地址含有控制字符' };
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { kind: 'reject', reason: '预览地址无法解析为 URL；需要 http(s)://主机[:端口]/路径' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'reject', reason: `仅支持 http/https 预览；收到协议 ${parsed.protocol.replace(/:$/u, '') || '(未知)'}` };
  }
  const normalized = parsed.href;
  if (LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return { kind: 'loopback', normalized };
  return { kind: 'external-confirm', normalized };
}
