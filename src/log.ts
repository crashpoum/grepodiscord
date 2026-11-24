const levels = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof levels)[number];
const min = levels.indexOf((process.env.LOG_LEVEL as Level) ?? 'info');
function emit(l: Level, msg: string, extra?: unknown) {
  if (levels.indexOf(l) < (min < 0 ? 1 : min)) return;
  const line = `${new Date().toISOString()} ${l.toUpperCase()} ${msg}`;
  const out = l === 'error' || l === 'warn' ? console.error : console.log;
  extra === undefined ? out(line) : out(line, extra);
}
export const log = {
  debug: (m: string, e?: unknown) => emit('debug', m, e),
  info: (m: string, e?: unknown) => emit('info', m, e),
  warn: (m: string, e?: unknown) => emit('warn', m, e),
  error: (m: string, e?: unknown) => emit('error', m, e),
};
