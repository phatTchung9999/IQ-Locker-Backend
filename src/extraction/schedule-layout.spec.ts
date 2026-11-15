import { sourceChunks } from './source-chunks.js';
import 'reflect-metadata';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Types } from 'mongoose';
import { ExtractionParserService } from './extraction-parser.service.js';
import { analyzeSyllabus } from '../analysis/syllabus-analyzer.js';

it('reproduces a column-ordered PDF schedule losing event-to-date relationships in flat text', async () => {
    const document = await PDFDocument.create();
    const page = document.addPage();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const rows = [
        ['Date', 'Topic', 'Due'],
        ['2026-12-08', 'Review', 'Quiz 1'],
        ['2026-12-15', 'Assessment', 'Final exam'],
    ];
    // Paint by column, independently of the visual reading order.
    for (const [column, x] of [50, 190, 350].entries()) {
        rows.forEach((row, index) => page.drawText(row[column], { x, y: 700 - index * 24, font, size: 12 }));
    }
    const bytes = await document.save();
    const parser = new ExtractionParserService();
    try {
        const extracted = await parser.extract(Buffer.from(bytes), 'application/pdf');
        const text = extracted.pages[0].text;
        expect(text).toMatch(/2026-12-08[\s\S]*2026-12-15[\s\S]*Quiz 1[\s\S]*Final exam/);
        expect(analyzeSyllabus([{ _id: new Types.ObjectId(), text }], {
            referenceDate: '2026-11-13', termYear: null, weekOneStart: null, weekCounting: null,
        })).toEqual([]);

        const chunks = sourceChunks(extracted, 'application/pdf');
        expect(chunks.map(chunk => chunk.text).join('')).toBe(text);
        const suggestions = analyzeSyllabus(chunks.map(chunk => ({ ...chunk, _id: new Types.ObjectId() })), {
            referenceDate: '2026-11-13', termYear: null, weekOneStart: null, weekCounting: null,
        });
        expect(suggestions).toMatchObject([
            { title: 'Quiz 1', date: '2026-12-08', sources: [{ quote: 'Quiz 1' }, { quote: '2026-12-08' }] },
            { title: 'Final exam', date: '2026-12-15', sources: [{ quote: 'Final exam' }, { quote: '2026-12-15' }] },
        ]);
        const cells = chunks.flatMap(chunk => (chunk.spans ?? []).map(span => ({
            text: text.slice(span.start, span.end).trim(), x: span.transform[4], y: span.transform[5],
        })));
        const baselines = [...new Set(cells.map(cell => cell.y))].sort((a, b) => b - a);
        expect(baselines.map(y => cells.filter(cell => cell.y === y).sort((a, b) => a.x - b.x)
            .map(cell => cell.text))).toEqual(rows);
    } finally { await parser.onModuleDestroy(); }
});

it('keeps page-relative coordinates when a span crosses a citation chunk boundary', () => {
    const text = 'a'.repeat(3998) + 'Final exam';
    const span = { start: 3998, end: text.length, transform: [12, 0, 0, 12, 50, 700], width: 60, height: 12 };
    const chunks = sourceChunks({ extractorVersion: 1, pages: [{ page: 1, text, spans: [span] }], textChars: text.length }, 'application/pdf');
    expect(chunks.map(chunk => chunk.text).join('')).toBe(text);
    expect(chunks.map(chunk => chunk.spans)).toEqual([[span], []]);
    expect(text.slice(span.start, span.end)).toBe('Final exam');
});

it.each([
    { heading: 'Course Outline', rows: [[['Event', 50], ['Date', 220], ['Topic', 350]], [['Final exam', 50], ['12/15/2026', 220], ['Assessment', 350]]], title: 'Final exam', date: '2026-12-15' },
    { heading: 'Schedule:', rows: [[['Tuesday', 100], ['Thursday', 320]], [['9/8', 100], ['9/10', 320]], [['Quiz 1', 320]]], title: 'Quiz 1', date: '2026-09-10' },
    { heading: 'Syllabus Outline', rows: [[['Week', 50], ['Topics', 150], ['Graded Activities', 320]], [['6', 60], ['Exam 1', 155], ['Exam 1', 340]]], title: 'Exam 1', date: null },
    { heading: 'Course Schedule', rows: [[['Week', 50], ['Topics', 150], ['Materials & Deliverables', 320]], [['6 – Oct 14, 16', 50], ['Transport', 150], ['Midterm Exam (Fri Oct 16)', 320]]], title: 'Midterm Exam', date: '2026-10-16' },
])('reads the $heading layout from a generated PDF', async ({ heading, rows, title, date }) => {
    const doc = await PDFDocument.create(), page = doc.addPage();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText(heading, { x: 50, y: 740, font });
    rows.forEach((row, i) => row.forEach(([label, x]) =>
        page.drawText(String(label), { x: Number(x), y: 710 - i * 22, font, size: 11 })));
    const parser = new ExtractionParserService();
    try {
        const result = await parser.extract(Buffer.from(await doc.save()), 'application/pdf');
        const chunks = sourceChunks(result, 'application/pdf').map(chunk => ({ ...chunk, _id: new Types.ObjectId() }));
        const suggestions = analyzeSyllabus(chunks, { referenceDate: '2026-11-13', termYear: null, weekOneStart: null, weekCounting: null });
        expect(suggestions).toHaveLength(1);
        expect(suggestions[0]).toMatchObject({ title, date });
    } finally { await parser.onModuleDestroy(); }
});

it('finds an explicit exam in a Dates line without treating administrative dates as assignments', () => {
    const text = 'Dates: First day - Tue 09/08  Drop - Tue 09/15  Final - Tue 12/15';
    expect(analyzeSyllabus([{ _id: new Types.ObjectId(), text }], {
        referenceDate: '2026-11-13', termYear: null, weekOneStart: null, weekCounting: null,
    })).toMatchObject([{ title: 'Final', date: '2026-12-15', kind: 'exam' }]);
});

it('keeps a finals-week window unresolved and stops at the next section', () => {
    const text = 'Dates: First day - Tue 09/08\nNo class - Tue 10/06  Final - finals week, Dec 10 - 15, time TBA\nGrading\nQuiz 2 - Tue 12/15';
    const result = analyzeSyllabus([{ _id: new Types.ObjectId(), text }], {
        referenceDate: '2026-11-13', termYear: null, weekOneStart: null, weekCounting: null,
    });
    expect(result).toMatchObject([{ title: 'Final', date: null, time: null,
        dateRange: { start: '2026-12-10', end: '2026-12-15' } }]);
});

it('does not parse a single-line Dates block twice and lose its exam period', () => {
    const text = 'Dates: Final - finals week, Dec 10 - 15, time TBA';
    const result = analyzeSyllabus([{ _id: new Types.ObjectId(), text }], {
        referenceDate: '2026-11-14', termYear: null, weekOneStart: null, weekCounting: null,
    });
    expect(result).toMatchObject([{ title: 'Final', date: null, time: null,
        dateRange: { start: '2026-12-10', end: '2026-12-15' } }]);
});
