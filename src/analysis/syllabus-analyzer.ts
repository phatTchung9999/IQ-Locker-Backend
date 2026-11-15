import { scheduleRows } from './schedule-rows.js';
import type { ScheduleChunk, Source } from './schedule-rows.js';
type Context = { referenceDate: string; termYear: number | null; weekOneStart: string | null; weekCounting: string | null };
const months = 'January February March April May June July August September October November December'.split(' ');
const weekdays = 'Monday Tuesday Wednesday Thursday Friday Saturday Sunday'.split(' ');
const shortMonths = months.map(month => month.slice(0, 3));
const calendar = new RegExp('\\b(' + [...months, ...shortMonths].join('|') + ') (\\d{1,2})(?:, (\\d{4}))?\\b', 'i');
function day(year: number, month: number, date: number) {
    const value = [String(year).padStart(4, '0'), String(month).padStart(2, '0'), String(date).padStart(2, '0')].join('-');
    const parsed = new Date(value + 'T00:00:00Z');
    return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value ? value : null;
}
const addDays = (date: string, days: number) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
export function analyzeSyllabus(chunks: ScheduleChunk[], context: Context) {
    const lines = chunks.flatMap(chunk => Array.from(chunk.text.matchAll(/[^\r\n]+/g), match => ({
        chunk: chunk._id, start: match.index, end: match.index + match[0].length, quote: match[0],
    })));
    const termSource = lines.find(line => /\bcourse term:\s*(?:fall|spring|summer|winter) \d{4}\b/i.test(line.quote));
    const weekSource = lines.find(line => /Week 1 starts Monday,/i.test(line.quote) && /Each week runs Monday through Sunday/i.test(line.quote));
    const weekMatch = weekSource?.quote.match(calendar);
    const inferredStart = weekMatch?.[3] ? day(+weekMatch[3], months.findIndex(m => m.toLowerCase() === weekMatch[1].toLowerCase()) + 1, +weekMatch[2]) : null;
    const mondayStart = inferredStart && new Date(inferredStart + 'T00:00:00Z').getUTCDay() === 1 ? inferredStart : null;
    const start = context.weekCounting === 'consecutive_seven_day_weeks' ? context.weekOneStart : mondayStart;
    const term = context.termYear ?? (termSource ? Number(termSource.quote.match(/\bcourse term:\s*(?:fall|spring|summer|winter) (\d{4})\b/i)?.[1]) : null);
    const proseRows = lines.flatMap(source => {
        const line = source.quote.trim();
        if (/^(?:Important )?Dates\s*:/i.test(line)) return [];
        const table = line.match(/^([^|]+)\|\s*(exam|assignment)\s*\|\s*(.+)$/i);
        const prose = line.replace(/^(?:Reminder|Schedule|Assessment section):\s*/i, '').match(/^(.+?)(?:\s+due\s+|:\s*|\s+(?=(?:January|February|March|April|May|June|July|August|September|October|November|December) \d))(.+)$/i);
        if (!table && !prose) return [];
        const title = (table?.[1] ?? prose![1]).trim();
        if (!title || title.length > 200 || (!table && !/\b(?:exam|midterm|final|quiz|due)\b/i.test(line))) return [];
        const kind = table ? table[2].toLowerCase() : /\b(?:exam|midterm|final|quiz)\b/i.test(title) ? 'exam' : 'assignment';
        const raw = (table?.[3] ?? prose![2]).trim().replace(/\.$/, '');
        return [{ title, kind, raw, sources: [source], contextSources: [] as Source[] }];
    });
    let datesSection = false;
    const inlineRows = lines.flatMap(source => {
        const text = source.quote.trim();
        const heading = /^(?:Important )?Dates\s*:/i.test(text);
        const continuation = /^(?:First day|Drop|Withdraw|Last class|No class|Final|Midterm|Quiz)\b/i.test(text);
        datesSection = heading || (datesSection && continuation);
        if (!datesSection) return [];
        return Array.from(source.quote.matchAll(/\b(Final(?: exam)?|Midterm(?: exam)?|Quiz \d+)\s*[-–:]\s*(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+)?(?:finals week,\s*)?(\d{1,2}\/\d{1,2}(?:\/\d{4})?|[A-Za-z]{3,9} \d{1,2}\s*[-–]\s*\d{1,2})/gi),
            match => ({ title: match[1], kind: 'exam',
                raw: match[2], sources: [{ ...source, start: source.start + match.index,
                    end: source.start + match.index + match[0].length, quote: match[0] }], contextSources: [] as Source[] }));
    });
    const structured = scheduleRows(chunks).map(row => ({
        ...row, kind: /\b(?:exam|midterm|final|quiz)\b/i.test(row.title) ? 'exam' : 'assignment',
    }));
    const rows = [...proseRows, ...inlineRows, ...structured].flatMap(({ title, kind, raw, sources, contextSources }) => {
        if (!title || title.length > 200) return [];
        const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const named = raw.match(calendar);
        const numeric = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
        const week = raw.match(/^(?:(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) of )?Week ([1-9]\d?)$/i);
        if (!iso && !named && !week && !numeric) return [];
        let date: string | null = null, time: string | null = null, timezone: string | null = null, dateBasis: string | null = null;
        let dateRange: { start: string; end: string } | null = null;
        const flags: string[] = [];
        const window = raw.match(/^([A-Za-z]+) (\d{1,2})\s*[-–]\s*(\d{1,2})$/);
        if (window && named) {
            const month = months.findIndex(m => m.toLowerCase().startsWith(window[1].toLowerCase())) + 1;
            const year = term ?? Number(context.referenceDate.slice(0, 4));
            const first = day(year, month, +window[2]), last = day(year, month, +window[3]);
            if (first && last && first <= last) dateRange = { start: first, end: last };
            dateBasis = term ? 'course_term' : 'current_year';
            flags.push('assumed_year', dateRange ? 'date_range' : 'invalid_date');
            if (termSource && context.termYear == null) contextSources.push(termSource);
        } else if (week) {
            if (!start) flags.push('relative_date');
            else {
                const offset = (+week[2] - 1) * 7;
                dateBasis = 'course_week';
                if (weekSource && start === mondayStart) contextSources.push(weekSource);
                if (week[1]) {
                    const firstDay = (new Date(start + 'T00:00:00Z').getUTCDay() + 6) % 7;
                    const weekday = weekdays.findIndex(d => d.toLowerCase() === week[1].toLowerCase());
                    date = addDays(start, offset + (weekday - firstDay + 7) % 7); flags.push('inferred_week_date');
                } else { dateRange = { start: addDays(start, offset), end: addDays(start, offset + 6) }; flags.push('date_range'); }
            }
        } else {
            date = numeric ? day(Number(numeric[3] ?? term ?? context.referenceDate.slice(0, 4)), +numeric[1], +numeric[2]) : iso ? day(+iso[1], +iso[2], +iso[3]) : day(Number(named![3] ?? term ?? context.referenceDate.slice(0, 4)), months.findIndex(m => m.toLowerCase().startsWith(named![1].toLowerCase())) + 1, +named![2]);
            dateBasis = iso || named?.[3] || numeric?.[3] ? 'explicit' : term ? 'course_term' : 'current_year';
            if (dateBasis !== 'explicit') flags.push('assumed_year');
            if (dateBasis === 'course_term' && termSource && context.termYear == null) contextSources.push(termSource);
            if (!date) flags.push('invalid_date');
            const clock = raw.match(/\bat (1[0-2]|[1-9]):([0-5]\d) (AM|PM)(?: ([A-Za-z_]+\/[A-Za-z_]+))?$/i);
            if (clock) {
                time = String(+clock[1] % 12 + (clock[3].toUpperCase() === 'PM' ? 12 : 0)).padStart(2, '0') + ':' + clock[2];
                if (clock[4]) { try { new Intl.DateTimeFormat('en', { timeZone: clock[4] }); timezone = clock[4]; } catch { flags.push('invalid_timezone'); } }
                else flags.push('missing_timezone');
            } else if (named && raw.slice(named.index! + named[0].length).trim()) flags.push('unresolved_time');
        }
        return [{ kind, title, originalDateText: [raw], date, time, timezone, dateRange, dateBasis, flags, sources, contextSources }];
    });
    const grouped = new Map<string, typeof rows[number]>();
    for (const row of rows) {
        const key = row.kind + ':' + row.title.toLowerCase().replace(/\s+/g, ' ').replace(/^(final|midterm) exam$/, '$1');
        const existing = grouped.get(key);
        if (!existing) { grouped.set(key, row); continue; }
        if (existing.sources.length + row.sources.length > 10) throw new Error('Evidence limit exceeded');
        existing.sources.push(...row.sources);
        existing.contextSources = [...new Set([...existing.contextSources, ...row.contextSources])];
        existing.originalDateText = [...new Set([...existing.originalDateText, ...row.originalDateText])];
        if (existing.date !== row.date || existing.time !== row.time || existing.timezone !== row.timezone ||
            JSON.stringify(existing.dateRange) !== JSON.stringify(row.dateRange) || (!row.date && !row.dateRange && existing.originalDateText.length > 1)) {
            existing.date = existing.time = existing.timezone = existing.dateBasis = null; existing.dateRange = null;
            existing.flags = ['conflicting_dates'];
        } else existing.flags = [...new Set([...existing.flags, ...row.flags])];
    }
    if (grouped.size > 100) throw new Error('Suggestion limit exceeded');
    return [...grouped.values()];
}
