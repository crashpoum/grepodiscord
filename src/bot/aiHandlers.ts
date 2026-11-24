/** /report (Gemini report/screenshot parser), the "Parse report" message action and /newspaper (batch 2). */
import {
  ActionRowBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, type APIEmbed, type Attachment, type ChatInputCommandInteraction,
  type Client, type MessageContextMenuCommandInteraction, type ModalSubmitInteraction,
} from 'discord.js';
import { config } from '../config.js';
import { Gemini, GeminiError, type Part } from '../ai/gemini.js';
import { UserError } from '../gdServices.js';
import { fmt, t, type Lang } from '../i18n.js';
import { log } from '../log.js';
import { newspaperDue, newspaperEmbed, newspaperPrompt, templateArticle, weekFacts } from '../newspaper.js';
import { matchTown, normalizeReport, REPORT_SCHEMA, reportEmbed, reportPrompt, reportTime, type ParsedReport } from '../reports.js';
import { resolveTown, type Ctx } from '../services.js';
import { dayIn, shiftDay } from '../targets.js';
import { worldTz } from '../time.js';
import { md } from '../war.js';
import { classifyError, logError, safeEmbed } from './errors.js';
import { guildSides } from './insights.js';
import { isAdmin, say, worldOf } from './opsHandlers.js';

const PRIVATE = { flags: MessageFlags.Ephemeral } as const;
const now = () => Math.floor(Date.now() / 1000);
let fallbackAi: Gemini | null = null;
/** The shared Gemini client (ctx.ai), or a key-less one that always answers "no key". */
export const aiOf = (ctx: Ctx): Gemini => ctx.ai ?? (fallbackAi ??= new Gemini({ apiKey: '' }));
const langOf = (ctx: Ctx, guildId: string | null): Lang => (guildId ? ctx.store.getGuild(guildId, config.defaultLang).lang : config.defaultLang);

// ---------------------------------------------------------------- report parsing
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_TEXT = 12_000;
const cooldown = new Map<string, number>();
const COOLDOWN_MS = 20_000;

export interface ReportInput { guildId: string; userId: string; world: string; text?: string | null; image?: Pick<Attachment, 'url' | 'contentType' | 'size' | 'name'> | null; townId?: number | null; lang: Lang }

async function imagePart(a: NonNullable<ReportInput['image']>, f: typeof fetch = fetch): Promise<Part> {
  const type = (a.contentType ?? '').split(';')[0].trim().toLowerCase() || (/\.(png)$/i.test(a.name ?? '') ? 'image/png' : /\.(jpe?g)$/i.test(a.name ?? '') ? 'image/jpeg' : '');
  if (!IMAGE_TYPES.includes(type)) throw new UserError('rep.badImage');
  if (a.size > MAX_IMAGE) throw new UserError('rep.imageTooBig', { mb: 8 });
  const res = await f(a.url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new UserError('rep.badImage');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE) throw new UserError('rep.imageTooBig', { mb: 8 });
  return { inline_data: { mime_type: type, data: buf.toString('base64') } };
}

/** Parse with Gemini, link towns, store for the guild. Throws UserError / GeminiError (localized by the caller). */
export async function parseAndStore(ctx: Ctx, x: ReportInput, f: typeof fetch = fetch): Promise<{ id: number; parsed: ParsedReport; embed: APIEmbed }> {
  const ai = aiOf(ctx);
  if (!ai.available) throw new GeminiError('noKey', 'GEMINI_API_KEY is not set');
  const text = x.text?.trim().slice(0, MAX_TEXT) ?? '';
  if (!text && !x.image) throw new UserError('rep.empty');
  const last = cooldown.get(x.userId) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) throw new UserError('rep.cooldown', { s: Math.ceil((COOLDOWN_MS - (Date.now() - last)) / 1000) });
  cooldown.set(x.userId, Date.now());
  const parts: Part[] = [];
  if (x.image) parts.push(await imagePart(x.image, f));
  parts.push({ text: text ? `Report text:\n${text}` : 'Extract the report shown in the image.' });
  const raw = await ai.json(parts, { system: reportPrompt(x.lang), schema: REPORT_SCHEMA, temperature: 0, maxOutputTokens: 4096 });
  const parsed = normalizeReport(raw);
  if (!parsed.isReport) throw new UserError('rep.notReport');
  const snap = await ctx.worlds.ensure(x.world).catch(() => undefined);
  const attTown = snap ? matchTown(snap, parsed.attacker.town, parsed.attacker.player) : null;
  let defTown = snap ? matchTown(snap, parsed.defender.town, parsed.defender.player) : null;
  if (x.townId && snap?.towns.get(x.townId)) defTown = snap.towns.get(x.townId)!;
  const row = {
    guildId: x.guildId, world: x.world, kind: parsed.kind, reportTime: reportTime(parsed.time, worldTz(x.world)),
    attPlayer: parsed.attacker.player, attAlliance: parsed.attacker.alliance, attTown: parsed.attacker.town, attTownId: attTown?.id ?? null,
    defPlayer: parsed.defender.player, defAlliance: parsed.defender.alliance, defTown: defTown?.name ?? parsed.defender.town, defTownId: defTown?.id ?? null,
    data: parsed, source: (x.image ? 'image' : 'text') as 'image' | 'text', createdBy: x.userId, createdAt: Date.now(),
  };
  const id = ctx.store.addReport(row);
  log.info(`report #${id} stored for guild ${x.guildId} (${parsed.kind}, ${row.source})`);
  return { id, parsed, embed: reportEmbed({ id, world: x.world, reportTime: row.reportTime, createdBy: x.userId, source: row.source }, parsed, x.lang, snap) };
}

/** Same localized error handling as slash commands, for modal / context-menu replies. */
async function replyError(i: ChatInputCommandInteraction | ModalSubmitInteraction | MessageContextMenuCommandInteraction, lang: Lang, e: unknown, where: string) {
  const c = classifyError(e);
  logError(where, e, c);
  const payload = { embeds: [{ description: t(lang, c.key, c.vars), color: 0xed4245 }] };
  if (i.deferred || i.replied) await i.editReply(payload).catch(() => undefined);
  else await i.reply({ ...payload, ...PRIVATE }).catch(() => undefined);
}

export async function handleReport(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang) {
  if (!i.guildId) throw new UserError('err.guildOnly');
  const sub = i.options.getSubcommand();
  const world = worldOf(ctx, i);
  if (sub === 'parse') {
    if (!aiOf(ctx).available) throw new GeminiError('noKey', 'GEMINI_API_KEY is not set');
    const text = i.options.getString('text');
    const image = i.options.getAttachment('image');
    const townQ = i.options.getString('town');
    let townId: number | null = null;
    if (townQ) {
      const snap = await ctx.worlds.ensure(world);
      const tw = resolveTown(snap, townQ);
      if (!tw) throw new UserError('err.notFound', { q: townQ, world });
      townId = tw.id;
    }
    if (!text && !image) {
      // Nothing given: open a modal so a multi-line report can be pasted as-is.
      const modal = new ModalBuilder().setCustomId(`report:modal:${world}:${townId ?? 0}:${i.options.getBoolean('private') ? 1 : 0}`).setTitle(t(lang, 'rep.modalTitle').slice(0, 45))
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('text').setLabel(t(lang, 'rep.modalLabel').slice(0, 45)).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)));
      return void (await i.showModal(modal));
    }
    await i.deferReply(i.options.getBoolean('private') ? PRIVATE : {});
    const r = await parseAndStore(ctx, { guildId: i.guildId, userId: i.user.id, world, text, image, townId, lang });
    return void (await i.editReply({ embeds: [safeEmbed(r.embed)] }));
  }
  await i.deferReply(PRIVATE);
  if (sub === 'show') {
    const id = i.options.getInteger('id', true);
    const r = ctx.store.getReport(i.guildId, id);
    if (!r) return say(i, t(lang, 'rep.notFound', { id }), { color: 0xfee75c });
    const snap = ctx.worlds.get(r.world);
    return say(i, '', { embed: reportEmbed(r, normalizeReport(toRaw(r.data as ParsedReport)), lang, snap) });
  }
  if (sub === 'delete') {
    const id = i.options.getInteger('id', true);
    const r = ctx.store.getReport(i.guildId, id);
    if (!r) return say(i, t(lang, 'rep.notFound', { id }), { color: 0xfee75c });
    if (r.createdBy !== i.user.id && !isAdmin(i)) throw new UserError('rep.notYours');
    ctx.store.removeReport(i.guildId, id);
    return say(i, t(lang, 'rep.deleted', { id }));
  }
  // search
  const townQ = i.options.getString('town', true);
  const kind = i.options.getString('kind');
  const page = i.options.getInteger('page') ?? 1;
  const snap = await ctx.worlds.ensure(world);
  // Autocomplete gives "id:<n>"; free text must match a town name exactly (stored names are matched too).
  const tw = /^id:\d+$/.test(townQ) ? resolveTown(snap, townQ) : matchTown(snap, townQ, null);
  const name = tw?.name ?? townQ.trim();
  const { rows, total } = ctx.store.searchReports(i.guildId, { townId: tw?.id ?? null, townName: name, kind, limit: 10, offset: (page - 1) * 10 });
  const icon: Record<string, string> = { attack: '⚔️', defense: '🛡️', spy: '🕵️', support: '🤝', conquest: '🏛️', other: '📜' };
  const lines = rows.map((r) => {
    const d = r.data as ParsedReport;
    const lost = (us: ParsedReport['attackerUnits'] | undefined) => (us ?? []).reduce((s, u) => s + (u.lost ?? 0), 0);
    const when = r.reportTime ? `<t:${r.reportTime}:R>` : `<t:${Math.floor(r.createdAt / 1000)}:R>`;
    return `**#${r.id}** ${icon[r.kind] ?? '📜'} ${when} · ${md(r.attTown ?? '?')} (${md(r.attPlayer ?? '?')}) → ${md(r.defTown ?? '?')} (${md(r.defPlayer ?? '?')})`
      + ` · ${t(lang, 'rep.lostShort', { a: fmt(lost(d?.attackerUnits), lang), d: fmt(lost(d?.defenderUnits), lang) })} · <@${r.createdBy}>`;
  });
  return say(i, '', { embed: {
    title: t(lang, 'rep.searchTitle', { town: name, world }),
    description: lines.length ? lines.join('\n') : t(lang, 'rep.searchNone'),
    color: 0x9b59b6,
    footer: { text: t(lang, 'rep.searchFooter', { total, page, pages: Math.max(1, Math.ceil(total / 10)) }) },
  } });
}

/** Stored reports are already normalized; map back to the model's field names so normalizeReport() can re-validate. */
function toRaw(p: ParsedReport) {
  return {
    is_report: p.isReport, kind: p.kind, time: p.time, attacker: p.attacker, defender: p.defender, attacker_units: p.attackerUnits, defender_units: p.defenderUnits,
    buildings: p.buildings, resources: p.resources, wall_before: p.wallBefore, wall_after: p.wallAfter, morale: p.morale, luck: p.luck, night_bonus: p.nightBonus, god: p.god, summary: p.summary,
  };
}

export async function handleReportModal(ctx: Ctx, i: ModalSubmitInteraction) {
  const m = /^report:modal:([a-z]{2,3}\d+):(\d+):([01])$/.exec(i.customId);
  if (!m || !i.guildId) return;
  const lang = langOf(ctx, i.guildId);
  try {
    await i.deferReply(m[3] === '1' ? PRIVATE : {});
    const r = await parseAndStore(ctx, { guildId: i.guildId, userId: i.user.id, world: m[1], text: i.fields.getTextInputValue('text'), townId: Number(m[2]) || null, lang });
    await i.editReply({ embeds: [safeEmbed(r.embed)] });
  } catch (e) { await replyError(i, lang, e, 'report modal'); }
}

/** Message action "Parse report": uses the message text and its first image. */
export async function handleReportContext(ctx: Ctx, i: MessageContextMenuCommandInteraction) {
  const lang = langOf(ctx, i.guildId);
  try {
    if (!i.guildId) throw new UserError('err.guildOnly');
    if (!aiOf(ctx).available) throw new GeminiError('noKey', 'GEMINI_API_KEY is not set');
    const world = ctx.store.getGuild(i.guildId).world;
    if (!world) throw new UserError('err.noWorld');
    const msg = i.targetMessage;
    const image = msg.attachments.find((a) => IMAGE_TYPES.includes((a.contentType ?? '').split(';')[0])) ?? null;
    const text = [msg.content, ...msg.embeds.map((e) => [e.title, e.description, ...(e.fields ?? []).map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join('\n'))].filter(Boolean).join('\n').trim();
    if (!text && !image) throw new UserError('rep.empty');
    await i.deferReply();
    const r = await parseAndStore(ctx, { guildId: i.guildId, userId: i.user.id, world, text: text || null, image, lang });
    await i.editReply({ embeds: [safeEmbed(r.embed)] });
  } catch (e) { await replyError(i, lang, e, 'report context menu'); }
}

// ---------------------------------------------------------------- newspaper
export async function buildNewspaper(ctx: Ctx, guildId: string, world: string, lang: Lang, at = now()): Promise<{ embed: APIEmbed; byAi: boolean; aiError: GeminiError | null }> {
  const snap = await ctx.worlds.ensure(world);
  const tz = worldTz(world);
  const today = dayIn(tz, at);
  const weekAgo = shiftDay(today, -7);
  const facts = weekFacts(snap, { now: at, ours: guildSides(ctx, guildId, snap, at).ours, oldP: ctx.store.dailyAt(world, 'p', weekAgo), oldA: ctx.store.dailyAt(world, 'a', weekAgo), today });
  const ai = aiOf(ctx);
  let aiError: GeminiError | null = null;
  if (ai.available) {
    try {
      const pr = newspaperPrompt(lang, facts);
      const body = await ai.generate([{ text: pr.user }], { system: pr.system, temperature: 0.8, maxOutputTokens: 4096 });
      return { embed: newspaperEmbed(facts, body, lang, true), byAi: true, aiError: null };
    } catch (e) {
      if (!(e instanceof GeminiError)) throw e;
      aiError = e;
      log.warn(`newspaper ${guildId}: AI failed (${e.kind}: ${e.message}); using the template`);
    }
  }
  return { embed: newspaperEmbed(facts, templateArticle(facts, lang), lang, false), byAi: false, aiError };
}

const DAYS = [0, 1, 2, 3, 4, 5, 6];
export async function handleNewspaper(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang) {
  if (!i.guildId) throw new UserError('err.guildOnly');
  if (!isAdmin(i)) throw new UserError('gdtoken.adminOnly');
  const sub = i.options.getSubcommand();
  await i.deferReply(PRIVATE);
  const dayName = (d: number) => t(lang, `news.day.${d}` as never);
  if (sub === 'channel') {
    const world = worldOf(ctx, i);
    const channel = i.options.getChannel('channel', true);
    const weekday = i.options.getInteger('day') ?? 0;
    const hour = i.options.getInteger('hour') ?? 20;
    if (!DAYS.includes(weekday)) throw new UserError('err.generic');
    ctx.store.setNewspaper({ guildId: i.guildId, channelId: channel.id, world, weekday, hour, createdBy: i.user.id });
    return say(i, t(lang, 'news.set', { channel: `<#${channel.id}>`, day: dayName(weekday), hour: String(hour).padStart(2, '0'), world, ai: t(lang, aiOf(ctx).available ? 'news.aiOn' : 'news.aiOff') }));
  }
  if (sub === 'off') return say(i, t(lang, ctx.store.disableNewspaper(i.guildId) ? 'news.offDone' : 'news.notSet'));
  if (sub === 'status') {
    const p = ctx.store.getNewspaper(i.guildId);
    if (!p) return say(i, t(lang, 'news.notSet'));
    const ai = aiOf(ctx);
    return say(i, t(lang, 'news.status', {
      state: t(lang, p.enabled ? 'news.on' : 'news.off'), channel: `<#${p.channelId}>`, day: dayName(p.weekday), hour: String(p.hour).padStart(2, '0'), world: p.world,
      last: p.lastSentDay ?? '-', error: p.lastError ?? '-', ai: ai.available ? t(lang, 'news.aiUsage', { model: ai.model, used: ai.usedToday(), cap: ai.rpd }) : t(lang, 'news.aiOff'),
    }));
  }
  // preview (private) / post (to the configured channel now)
  const p = ctx.store.getNewspaper(i.guildId);
  const world = sub === 'post' && p ? p.world : worldOf(ctx, i);
  const r = await buildNewspaper(ctx, i.guildId, world, lang);
  const note = r.aiError ? t(lang, 'news.aiFallback', { reason: t(lang, classifyError(r.aiError).key) }) : null;
  if (sub === 'preview') return void (await i.editReply({ content: note ?? undefined, embeds: [safeEmbed(r.embed)] }));
  if (!p) return say(i, t(lang, 'news.notSet'), { color: 0xfee75c });
  const ch = await i.client.channels.fetch(p.channelId).catch(() => null);
  if (!ch || !ch.isSendable()) return say(i, t(lang, 'war.noChannel', { channel: `<#${p.channelId}>` }), { color: 0xfee75c });
  await ch.send({ embeds: [safeEmbed(r.embed)] });
  return say(i, [t(lang, 'news.posted', { channel: `<#${p.channelId}>` }), note].filter(Boolean).join('\n'));
}

/** Scheduler hook (every few minutes): post due newspapers. Marks the day first so a crash never double-posts. */
export async function runNewspapers(client: Client, ctx: Ctx, ms = Date.now()) {
  for (const p of ctx.store.enabledNewspapers()) {
    const day = newspaperDue(p, worldTz(p.world), ms);
    if (!day) continue;
    ctx.store.markNewspaper(p.guildId, day, null);
    try {
      const ch = await client.channels.fetch(p.channelId).catch(() => null);
      if (!ch || !ch.isSendable()) { ctx.store.markNewspaper(p.guildId, null, 'channel not sendable'); continue; }
      const r = await buildNewspaper(ctx, p.guildId, p.world, langOf(ctx, p.guildId), Math.floor(ms / 1000));
      await ch.send({ embeds: [safeEmbed(r.embed)] });
      ctx.store.markNewspaper(p.guildId, null, r.aiError ? `AI: ${r.aiError.kind}` : null);
      log.info(`newspaper posted for guild ${p.guildId} (${r.byAi ? 'AI' : 'template'})`);
    } catch (e) {
      log.warn(`newspaper ${p.guildId} failed: ${e}`);
      ctx.store.markNewspaper(p.guildId, null, String(e).slice(0, 200));
    }
  }
}
