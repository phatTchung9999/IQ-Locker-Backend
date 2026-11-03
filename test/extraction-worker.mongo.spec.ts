import 'reflect-metadata';
import 'dotenv/config';
import { Mongoose, Types } from 'mongoose';
import { Readable } from 'node:stream';
import { ExtractionJobSchema } from '../src/model/extraction-job.schema.js';
import { MaterialSchema } from '../src/model/material.schema.js';
import { CourseSchema } from '../src/model/course.schema.js';
import { FolderSchema } from '../src/model/folder.schema.js';
import { FolderService } from '../src/service/folder.service.js';
import { ExtractionWorkerService } from '../src/extraction/extraction-worker.service.js';
import { ExtractionFailure } from '../src/extraction/extraction.types.js';

describe.skipIf(process.env.IQLOCKER_MONGO_TEST !== '1')('Extraction worker MongoDB leases (disposable collections)', () => {
    const database = new Mongoose();
    const prefix = `iqlocker_phase15_worker_${new Types.ObjectId()}`;
    const Course = database.model('WorkerTestCourse', CourseSchema.clone(), `${prefix}_courses`);
    const Folder = database.model('WorkerTestFolder', FolderSchema.clone(), `${prefix}_folders`);
    const Material = database.model('WorkerTestMaterial', MaterialSchema.clone(), `${prefix}_materials`);
    const Job = database.model('WorkerTestJob', ExtractionJobSchema.clone(), `${prefix}_jobs`);
    const folders = new FolderService(Course as any, Folder as any, Material as any);
    const storage = { download: vi.fn(async () => Readable.from(Buffer.from('notes'))) };
    const result = { extractorVersion: 1, pages: [{ page: null, text: 'notes' }], textChars: 5 };
    const parser = { extract: vi.fn(async (_bytes: Buffer, _type: string, _signal: AbortSignal) => result) };
    const writer = { save: vi.fn(async () => {}) };
    const worker = () => new ExtractionWorkerService(Job as any, Material as any, folders, storage as any, parser as any, writer);
    async function seed() {
        const owner = new Types.ObjectId();
        const course = await Course.create({ owner, name: 'Worker test' });
        const material = await Material.create({ owner, course: course._id, title: 'Notes', originalFilename: 'notes.txt', mediaType: 'text/plain', sizeBytes: 5, storageKey: `materials/${new Types.ObjectId()}.txt`, state: 'ready', processingStatus: 'queued' });
        const job = await Job.create({ owner, course: course._id, material: material._id, materialVersion: 1 });
        return { job, material };
    }
    beforeAll(async () => {
        await database.connect(process.env.MONGO_URI ?? 'mongodb://localhost:27017/Stream', { serverSelectionTimeoutMS: 8000 });
        await Promise.all([Course.init(), Folder.init(), Material.init(), Job.init()]);
    }, 20000);
    beforeEach(async () => {
        vi.stubEnv('EXTRACTION_PROCESSING_ENABLED', 'true');
        vi.clearAllMocks();
        await Promise.all([Job.deleteMany({}), Material.deleteMany({}), Course.deleteMany({})]);
    });
    afterEach(() => vi.unstubAllEnvs());
    afterAll(async () => {
        try {
            if (database.connection.readyState === 1) for (const model of [Course, Folder, Material, Job]) {
                if (!model.collection.name.startsWith(prefix)) throw new Error('Invalid disposable collection');
                await model.collection.drop();
            }
        } finally { await database.disconnect(); }
    });
    it('allows one concurrent claim and publishes only the owned material version', async () => {
        const { job, material } = await seed();
        let release!: () => void;
        parser.extract.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(result); }));
        const first = worker(), second = worker();
        const pending = first.runOnce();
        await vi.waitFor(() => expect(parser.extract).toHaveBeenCalled());
        expect(await second.runOnce()).toBe(false);
        expect((await Job.findById(job._id))!.attempts).toBe(1);
        release(); await pending;
        expect(writer.save).toHaveBeenCalledWith(result, expect.objectContaining({ owner: material.owner, _id: material._id }), expect.objectContaining({ materialVersion: 1 }), expect.anything());
        expect((await Job.findById(job._id))!.state).toBe('ready');
        expect((await Material.findById(material._id))!.processingStatus).toBe('ready');
    });
    it('retries transient storage failures but bounds attempts and preserves originals', async () => {
        const { job, material } = await seed();
        storage.download.mockRejectedValueOnce(new Error('provider detail must stay private'));
        const service = worker(); await service.runOnce();
        let stored = (await Job.findById(job._id))!;
        expect(stored.state).toBe('queued'); expect(stored.errorCode).toBe('storage_unavailable'); expect(stored.attempts).toBe(1);
        expect(stored.runAfter.getTime()).toBeGreaterThan(Date.now());
        await Job.updateOne({ _id: job._id }, { $set: { attempts: 2, runAfter: new Date(0) } });
        storage.download.mockRejectedValueOnce(new Error('still offline')); await service.runOnce();
        stored = (await Job.findById(job._id))!;
        expect(stored.state).toBe('failed'); expect(stored.attempts).toBe(3);
        expect((await Material.findById(material._id))!.state).toBe('ready');
        expect(writer.save).not.toHaveBeenCalled();
    });
    it('reports no readable text without automatic retries or losing the original', async () => {
        const { job, material } = await seed();
        parser.extract.mockRejectedValueOnce(new ExtractionFailure('no_readable_text'));
        await worker().runOnce();
        expect(await Job.findById(job._id)).toMatchObject({ state: 'failed', errorCode: 'no_readable_text', attempts: 1 });
        expect((await Material.findById(material._id))!.state).toBe('ready');
        expect(writer.save).not.toHaveBeenCalled();
    });
    it('recovers an expired claim after restart and stops retrying at the attempt limit', async () => {
        const { job } = await seed();
        await Job.updateOne({ _id: job._id }, { $set: { state: 'processing', attempts: 1, leaseToken: 'old', leaseUntil: new Date(0) } });
        const restarted = worker(); await restarted.runOnce();
        expect(await Job.findById(job._id)).toMatchObject({ state: 'queued', errorCode: 'timeout' });
        await Job.updateOne({ _id: job._id }, { $set: { state: 'processing', attempts: 3, leaseToken: 'exhausted', leaseUntil: new Date(0) } });
        await worker().runOnce();
        expect(await Job.findById(job._id)).toMatchObject({ state: 'failed', errorCode: 'attempts_exhausted' });
        expect(parser.extract).not.toHaveBeenCalled();
    });
    it('rejects stale lease results and results for deleted materials', async () => {
        for (const change of ['lease', 'delete']) {
            const { job, material } = await seed();
            parser.extract.mockImplementationOnce(async () => {
                if (change === 'lease') await Job.updateOne({ _id: job._id }, { $set: { leaseToken: 'another-worker' } });
                else { await Job.deleteOne({ _id: job._id }); await Material.deleteOne({ _id: material._id }); }
                return result;
            });
            await worker().runOnce();
            expect(writer.save).not.toHaveBeenCalled();
            if (change === 'lease') await Job.deleteOne({ _id: job._id });
            else expect(await Material.findById(material._id)).toBeNull();
        }
    });
    it('rolls back ready status if the result writer fails', async () => {
        const { job, material } = await seed();
        writer.save.mockRejectedValueOnce(new Error('transaction writer unavailable'));
        await worker().runOnce();
        expect((await Job.findById(job._id))!.state).toBe('queued');
        expect((await Material.findById(material._id))!.processingStatus).toBe('queued');
        expect((await Material.findById(material._id))!.processedAt).toBeNull();
    });
});
