import 'reflect-metadata';
import { Mongoose, Types } from 'mongoose';
import { ExtractionJobSchema } from './extraction-job.schema.js';
import { MaterialSchema } from './material.schema.js';

const database = new Mongoose();
const Job = database.model('ExtractionSchemaTest', ExtractionJobSchema);
const Material = database.model('MaterialExtractionSchemaTest', MaterialSchema);
const identity = () => ({ owner: new Types.ObjectId(), course: new Types.ObjectId(), material: new Types.ObjectId(), materialVersion: 1 });

it('starts a versioned, owned task queued with bounded attempt settings', async () => {
    const job = new Job(identity());
    await expect(job.validate()).resolves.toBeUndefined();
    expect(job.state).toBe('queued');
    expect(job.attempts).toBe(0);
    expect(job.maxAttempts).toBe(3);
    expect(job.runAfter).toBeInstanceOf(Date);
    expect(job.leaseUntil).toBeNull();
});
it.each(['owner', 'course', 'material', 'materialVersion'])('requires the %s reference', async (key) => {
    const fields: Record<string, unknown> = identity(); delete fields[key];
    await expect(new Job(fields).validate()).rejects.toHaveProperty(`errors.${key}`);
});
it.each([
    { materialVersion: 0 }, { materialVersion: 1.5 }, { attempts: -1 },
    { attempts: 0.5 }, { maxAttempts: 0 }, { maxAttempts: 11 },
    { state: 'invented' }, { errorCode: 'private-provider-exception' },
])('rejects invalid version, retry, status or error values: %j', async (fields) => {
    await expect(new Job({ ...identity(), ...fields }).validate()).rejects.toThrow();
});
it('defines material/version uniqueness, lease recovery indexes and no TTL', () => {
    const indexes = ExtractionJobSchema.indexes();
    expect(indexes).toContainEqual([{ material: 1, materialVersion: 1 }, expect.objectContaining({ unique: true })]);
    expect(indexes.some(([keys]) => keys.state === 1 && keys.leaseUntil === 1)).toBe(true);
    expect(indexes.some(([, options]) => options.expireAfterSeconds !== undefined)).toBe(false);
});
it('keeps existing material defaults compatible and accepts the planned processing states', async () => {
    const fields = { owner: new Types.ObjectId(), course: new Types.ObjectId(), title: 'Notes', originalFilename: 'notes.txt', mediaType: 'text/plain', sizeBytes: 5, storageKey: 'materials/test.txt', state: 'ready' };
    const original = new Material(fields);
    expect(original.processingStatus).toBe('not_started');
    expect(original.processedAt).toBeNull();
    await expect(original.validate()).resolves.toBeUndefined();
    for (const processingStatus of ['queued', 'processing', 'ready', 'failed']) {
        await expect(new Material({ ...fields, processingStatus }).validate()).resolves.toBeUndefined();
    }
    await expect(new Material({ ...fields, processingStatus: 'invented' }).validate()).rejects.toThrow();
});
