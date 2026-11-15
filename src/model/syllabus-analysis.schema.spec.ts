import { model, Types } from 'mongoose';
import { SyllabusAnalysisSchema } from './syllabus-analysis.schema.js';

const Analysis = model('SyllabusAnalysisSchemaTest', SyllabusAnalysisSchema);
const input = () => ({
    owner: new Types.ObjectId(), course: new Types.ObjectId(), material: new Types.ObjectId(),
    extraction: new Types.ObjectId(), materialVersion: 1, analyzerVersion: 1, referenceDate: '2026-11-12',
});
it('captures snapshot identity and leaves queued results absent', async () => {
    const doc = new Analysis(input());
    await expect(doc.validate()).resolves.toBeUndefined();
    expect(doc.state).toBe('queued');
    expect(doc.suggestions).toBeUndefined();
    expect(doc.attempts).toBe(0);
});
it('distinguishes completed analysis with no deadlines from a queued job', async () => {
    const doc = new Analysis({ ...input(), state: 'ready', suggestions: [] });
    await expect(doc.validate()).resolves.toBeUndefined();
    expect(doc.suggestions).toHaveLength(0);
});
it('requires source evidence and valid time syntax in suggestions', async () => {
    const doc = new Analysis({ ...input(), suggestions: [{ kind: 'exam', title: 'Final', time: '25:00', sources: [] }] });
    await expect(doc.validate()).rejects.toMatchObject({ errors: { 'suggestions.0.time': expect.anything(), 'suggestions.0.sources': expect.anything() } });
});
