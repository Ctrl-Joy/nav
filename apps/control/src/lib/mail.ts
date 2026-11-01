// Outgoing email over SMTP (any provider, or your own server). Without NAV_SMTP_URL, messages are written as
// .eml files to <dataDir>/outbox and logged, so every flow still works on a laptop.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '@nav/shared/config';

let transport: Transporter | null = null;

export interface Mail { to: string | string[]; subject: string; text: string; html?: string }

export async function sendMail(m: Mail): Promise<void> {
  const to = Array.isArray(m.to) ? m.to : [m.to];
  if (!to.length) return;
  if (!config.smtpUrl) {
    const dir = path.join(config.dataDir, 'outbox');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 7)}.eml`);
    await writeFile(file, `From: ${config.mailFrom}\nTo: ${to.join(', ')}\nSubject: ${m.subject}\nContent-Type: text/plain; charset=utf-8\n\n${m.text}\n`);
    console.log(`[mail] (no SMTP configured) "${m.subject}" to ${to.join(', ')} → ${file}`);
    return;
  }
  transport ??= nodemailer.createTransport(config.smtpUrl);
  await transport.sendMail({ from: config.mailFrom, to, subject: m.subject, text: m.text, html: m.html });
}

/** Plain, readable layout shared by every NAV email. */
export function layout(title: string, lines: string[], action?: { label: string; url: string }): { text: string; html: string } {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const text = [title, '', ...lines, ...(action ? ['', `${action.label}: ${action.url}`] : []), '', '— NAV'].join('\n');
  const html = `<div style="font-family:Inter,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#18181b">
<h2 style="font-size:18px;margin:0 0 16px">${esc(title)}</h2>${lines.map((l) => `<p style="margin:0 0 12px;line-height:1.5">${esc(l)}</p>`).join('')}
${action ? `<p style="margin:20px 0"><a href="${esc(action.url)}" style="background:#09090b;color:#fff;padding:10px 16px;text-decoration:none;border-radius:4px">${esc(action.label)}</a></p>` : ''}
<p style="color:#71717a;font-size:12px;margin-top:24px">NAV</p></div>`;
  return { text, html };
}
