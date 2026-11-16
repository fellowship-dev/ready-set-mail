// The plain page every login-free email link answers with (unsubscribe, confirm, turn off one lifecycle email): no external assets, never cached,
// no referrer.
import { lightColors as c } from '../../packages/ui/src/tokens/tokens';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function page(title: string, message: string, status = 200, extraHtml = ''): Response {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>` +
      `<body style="font-family:Arial,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:${c['ink-1']};"><h1 style="font-size:20px;">${esc(title)}</h1><p style="line-height:1.6;">${esc(message)}</p>${extraHtml}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } },
  );
}
