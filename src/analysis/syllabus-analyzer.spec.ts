import { readFileSync } from 'node:fs';
import { Types } from 'mongoose';
import { analyzeSyllabus } from './syllabus-analyzer.js';

const fixtures = new URL('../../../plan/Phase_2/fixtures/', import.meta.url);
const expected = JSON.parse(readFileSync(new URL('expected.json', fixtures), 'utf8'));
for (const [file, rows] of Object.entries(expected) as [string, any[]][]) {
    it('matches the approved syllabus baseline: ' + file, () => {
        const text = readFileSync(new URL(file, fixtures), 'utf8');
        const chunk = { _id: new Types.ObjectId(), text };
        const result = analyzeSyllabus([chunk], { referenceDate: '2026-11-12', termYear: null, weekOneStart: null, weekCounting: null });
        const source = (ref: { start: number; end: number; quote: string }) => {
            expect(text.slice(ref.start, ref.end)).toBe(ref.quote);
            return { quote: ref.quote, line: text.slice(0, ref.start).split('\n').length };
        };
        const actual = result.map(({ sources, contextSources, ...row }) => ({ ...row, status: 'pending',
            sources: sources.map(source), contextSources: contextSources.map(source) }));
        expect(actual).toHaveLength(rows.length);
        rows.forEach((row, index) => expect(actual[index]).toMatchObject(row));
    });
}
