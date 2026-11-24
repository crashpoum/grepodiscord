import { describe, expect, it } from 'vitest';
import { ENTRY_POINT, ensureEntryPoint } from '../src/web/entryPoint.js';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function fakeDiscord(initial: any[]) {
  const cmds = initial.map((c) => ({ ...c }));
  const calls: string[] = [];
  const f = (async (u: string, init?: RequestInit) => {
    const url = new URL(String(u));
    const m = init?.method ?? 'GET';
    calls.push(`${m} ${url.pathname}`);
    if (url.pathname === '/api/v10/oauth2/token') {
      const auth = String((init?.headers as Record<string, string>).Authorization);
      const body = new URLSearchParams(String(init?.body));
      if (auth !== `Basic ${Buffer.from('app1:s3').toString('base64')}`) return json({ error: 'invalid_client' }, 401);
      expect(body.get('grant_type')).toBe('client_credentials');
      expect(body.get('scope')).toBe('applications.commands.update');
      return json({ access_token: 'cc', token_type: 'Bearer' });
    }
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer cc');
    if (m === 'PUT') throw new Error('never bulk-overwrite');
    if (url.pathname === '/api/v10/applications/app1/commands' && m === 'GET') return json(cmds);
    if (url.pathname === '/api/v10/applications/app1/commands' && m === 'POST') { const c = { id: 'new', ...JSON.parse(String(init!.body)) }; cmds.push(c); return json(c, 201); }
    const pm = /commands\/(\w+)$/.exec(url.pathname);
    if (pm && m === 'PATCH') { const i = cmds.findIndex((c) => c.id === pm[1]); cmds[i] = { ...cmds[i], ...JSON.parse(String(init!.body)) }; return json(cmds[i]); }
    return json({}, 404);
  }) as typeof fetch;
  return { f, cmds, calls };
}

describe('Activity Entry Point command', () => {
  it('skips with a clear message when the Activity credentials are not set', async () => {
    const r = await ensureEntryPoint(fakeDiscord([]).f, '', '');
    expect(r.status).toBe('skipped');
    expect(r.message).toContain('ACTIVITY_CLIENT_ID');
  });
  it('creates it once (type 4, handler 2, Greek name), then is idempotent; other commands untouched', async () => {
    const d = fakeDiscord([{ id: 'o1', type: 1, name: 'other', description: 'x' }]);
    const a = await ensureEntryPoint(d.f, 'app1', 's3');
    expect(a.status).toBe('created');
    const ep = d.cmds.find((c) => c.type === 4)!;
    expect(ep).toMatchObject({ name: 'launch', handler: 2, integration_types: [0, 1], contexts: [0, 1, 2], name_localizations: { el: 'εκκίνηση' } });
    expect(ep.description_localizations.el).toBeTruthy();
    expect((await ensureEntryPoint(d.f, 'app1', 's3')).status).toBe('unchanged');
    expect(d.cmds.map((c) => c.id)).toEqual(['o1', 'new']);
    expect(d.calls.filter((c) => c.startsWith('POST /api/v10/applications'))).toHaveLength(1);
  });
  it('edits the default "Launch" entry point in place instead of adding a second one', async () => {
    const d = fakeDiscord([{ id: 'def', type: 4, name: 'launch', description: 'Launch an activity', handler: 2, integration_types: [0, 1], contexts: [0, 1, 2] }]);
    const r = await ensureEntryPoint(d.f, 'app1', 's3');
    expect(r.status).toBe('updated');
    expect(d.cmds).toHaveLength(1);
    expect(d.cmds[0]).toMatchObject({ id: 'def', ...ENTRY_POINT });
  });
  it('reports a bad secret clearly', async () => {
    await expect(ensureEntryPoint(fakeDiscord([]).f, 'app1', 'wrong')).rejects.toThrow(/invalid_client.*ACTIVITY_CLIENT_SECRET/);
  });
});
