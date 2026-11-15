import type { Types } from 'mongoose';
import type { PdfTextSpan } from '../extraction/extraction.types.js';

export type ScheduleChunk = { _id: Types.ObjectId; text: string; page?: number | null; charStart?: number; spans?: PdfTextSpan[] };
export type Source = { chunk: Types.ObjectId; start: number; end: number; quote: string };
type Cell = { x: number; y: number; width: number; sources: Source[]; text: string };
const dateHeader = /^(?:date|due date|deadline)$/i;
const eventHeader = /^(?:event|assessment|assignment|due|deliverables?|graded activities|materials & deliverables)$/i;

export const scheduleHeading = /^(?:(?:course |weekly )?schedule|(?:course |syllabus )outline|(?:important )?dates)\s*:?$/i;
const weekday = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i;
const numericDate = /^(\d{1,2}\/\d{1,2}(?:\/\d{4})?)(?=\s|$)/;
const eventName = /\b(?:quiz|exam|midterm|retake|lab|assignment|project|report)\b/i;

export function scheduleRows(chunks: ScheduleChunk[]) {
    const pages = new Map<number, ScheduleChunk[]>();
    for (const chunk of chunks) {
        if (chunk.page == null || chunk.charStart == null) continue;
        const page = pages.get(chunk.page) ?? [];
        page.push(chunk); pages.set(chunk.page, page);
    }
    const result: { title: string; raw: string; sources: Source[]; contextSources: Source[] }[] = [];
    for (const page of pages.values()) {
        page.sort((a, b) => a.charStart! - b.charStart!);
        let length = 0;
        if (page.some(chunk => { const gap = chunk.charStart !== length; length += chunk.text.length; return gap; })) continue;
        const cells: Cell[] = [];
        for (const [index, chunk] of page.entries()) for (const span of chunk.spans ?? []) {
            const [a, b, c, d, x, y] = span.transform;
            if (a <= 0 || d <= 0 || Math.abs(b) > .01 || Math.abs(c) > .01 || span.width <= 0 ||
                span.start < chunk.charStart! || span.start >= chunk.charStart! + chunk.text.length || span.end > length) continue;
            const sources: Source[] = [];
            for (let i = index; i < page.length && page[i].charStart! < span.end; i++) {
                const part = page[i], start = Math.max(0, span.start - part.charStart!);
                const end = Math.min(part.text.length, span.end - part.charStart!);
                if (end > start) sources.push({ chunk: part._id, start, end, quote: part.text.slice(start, end) });
            }
            cells.push({ x, y, width: span.width, sources, text: sources.map(source => source.quote).join('').trim() });
        }
        cells.sort((a, b) => b.y - a.y || a.x - b.x);
        const rows: Cell[][] = [];
        for (const cell of cells) {
            const row = rows.at(-1);
            if (row && row[0].y - cell.y <= 2) row.push(cell);
            else rows.push([cell]);
        }
        let header: Cell[] = [], date = -1, event = -1, previousY = 0;
        let section = false, days: Cell[] = [], weekMode = false;
        const active = new Map<number, { raw: string; source: Cell }>();
        let week: Cell | undefined;
        for (const row of rows) {
            row.sort((a, b) => a.x - b.x);
            if (row.length === 1 && scheduleHeading.test(row[0].text)) {
                section = true; header = []; days = []; weekMode = false; active.clear(); week = undefined;
                continue;
            }
            const dayColumns = row.filter(cell => weekday.test(cell.text));
            if (section && dayColumns.length >= 2) {
                days = dayColumns; active.clear(); previousY = row[0].y; continue;
            }
            const weekHeader = row.find(cell => /^week$/i.test(cell.text));
            const activity = row.find(cell => eventHeader.test(cell.text));
            if (section && weekHeader && activity) {
                header = row; date = row.indexOf(weekHeader); event = row.indexOf(activity);
                weekMode = true; days = []; week = undefined; previousY = row[0].y; continue;
            }
            if (section && row.length === 1 && /^(?:grading(?: policy)?|(?:course )?policies|attendance|requirements|resources|academic integrity)\s*:?$/i.test(row[0].text)) {
                section = false; header = []; days = []; active.clear(); week = undefined; continue;
            }
            if (days.length) {
                if (previousY - row[0].y > 48) { days = []; active.clear(); continue; }
                previousY = row[0].y;
                if (row.some(cell => cell.x < days[0].x - 4 && /^\d+$/.test(cell.text))) active.clear();
                for (const cell of row) {
                    const column = days.findIndex((col, i) => cell.x >= col.x - 4 &&
                        (!days[i + 1] || cell.x + cell.width <= days[i + 1].x - 4));
                    if (column < 0) continue;
                    const match = cell.text.match(numericDate);
                    if (match) active.set(column, { raw: match[1], source: cell });
                    const current = active.get(column);
                    const title = cell.text.replace(numericDate, '').replace(/^\s*[-–:]\s*/, '').trim();
                    if (current && eventName.test(title) && !/^no (?:class|lab|exam|quiz)/i.test(title)) result.push({
                        title: title.replace(/\s+-\s+.*$/, ''), raw: current.raw,
                        sources: [...new Set([...cell.sources, ...current.source.sources])], contextSources: days[column].sources,
                    });
                }
                continue;
            }
            if (weekMode && header.length) {
                if (previousY - row[0].y > 48) { header = []; week = undefined; continue; }
                previousY = row[0].y;
                // Centered cells can have a different left edge than their header.
                // Use the nearest column center; reject ties and crossing cells.
                const centers = header.map(col => col.x + col.width / 2);
                const buckets = header.map(() => [] as Cell[]);
                for (const cell of row) {
                    const x = cell.x + cell.width / 2;
                    const ranked = centers.map((center, index) => ({ index, distance: Math.abs(center - x) })).sort((a,b) => a.distance-b.distance);
                    if (ranked[1].distance - ranked[0].distance > 4) buckets[ranked[0].index].push(cell);
                }
                const first = buckets[date][0];
                if (first) week = /^\d{1,2}(?:\s*[–-]|$)/.test(first.text) ? first : undefined;
                if (!week || buckets[event].length !== 1) continue;
                const cell = buckets[event][0];
                for (const entry of cell.text.split(/,\s*(?=(?:LA|A)\d)/i)) {
                    const explicit = entry.match(/\b(Midterm Exam|Final Exam|Exam \d+|Quiz \d+)\s*\((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Za-z]{3} \d{1,2})\)/i);
                    const title = explicit?.[1] ?? (entry.match(/\b(?:Exam|Quiz|Lab) \d+\b/i)?.[0] ?? (/^(?:LA|A)\d+$/i.test(entry.trim()) ? entry.trim() : null));
                    if (title) result.push({ title, raw: explicit?.[2] ?? 'Week ' + week.text.match(/^\d+/)![0],
                        sources: [...cell.sources, ...week.sources], contextSources: [...header[date].sources, ...header[event].sources] });
                }
                continue;
            }
            const dates = row.filter(cell => dateHeader.test(cell.text));
            const events = row.filter(cell => eventHeader.test(cell.text));
            if (dates.length && events.length) {
                header = dates.length === 1 && events.length === 1 &&
                    row.every((cell, i) => !i || row[i - 1].x + row[i - 1].width < cell.x) ? row : [];
                date = header.indexOf(dates[0]); event = header.indexOf(events[0]); previousY = row[0].y;
                continue;
            }
            if (!header.length) continue;
            if (previousY - row[0].y > 48) { header = []; continue; }
            previousY = row[0].y;
            const columns = header.map(col => row.filter(cell => Math.abs(cell.x - col.x) <= 4));
            if (columns[date].length !== 1 || columns[event].length !== 1 ||
                columns.some(col => col.length > 1) || columns.flat().length !== row.length) continue;
            const due = columns[date][0], item = columns[event][0];
            if ([due, item].some(cell => header.some(col => col.x > cell.x + 4 && col.x < cell.x + cell.width))) continue;
            const sources = [...item.sources, ...due.sources];
            if (sources.length > 10) continue;
            result.push({ title: item.text, raw: due.text, sources, contextSources: [...header[date].sources, ...header[event].sources] });
        }
    }
    return result;
}
