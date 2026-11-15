import { SyllabusAnalysisSchema } from '../src/model/syllabus-analysis.schema.js';
import 'reflect-metadata';
import 'dotenv/config';
import { Mongoose, Types } from 'mongoose';
import { Readable } from 'node:stream';
import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ExtractedTextSchema, ExtractedTextChunkSchema } from '../src/model/extracted-text.schema.js';
import { ExtractedTextService } from '../src/extraction/extracted-text.service.js';
import { ExtractionJobSchema } from '../src/model/extraction-job.schema.js';
import { MaterialSchema, StorageUsageSchema } from '../src/model/material.schema.js';
import { CourseSchema } from '../src/model/course.schema.js';
import { FolderSchema } from '../src/model/folder.schema.js';
import { FolderService } from '../src/service/folder.service.js';
import { CourseService } from '../src/service/course.service.js';
import { MaterialService } from '../src/service/material.service.js';

describe.skipIf(process.env.IQLOCKER_MONGO_TEST !== '1')('Material MongoDB transactions (disposable collections)', () => {
    const database = new Mongoose();
    const prefix = `iqlocker_phase14_test_${new Types.ObjectId()}`;
    const Course = database.model('MaterialTestCourse', CourseSchema.clone(), `${prefix}_courses`);
    const Folder = database.model('MaterialTestFolder', FolderSchema.clone(), `${prefix}_folders`);
    const Material = database.model('MaterialTestMaterial', MaterialSchema.clone(), `${prefix}_materials`);
    const Usage = database.model('MaterialTestUsage', StorageUsageSchema.clone(), `${prefix}_usage`);
    const Analysis = database.model('TestAnalysis', SyllabusAnalysisSchema.clone(), `${prefix}_analyses`);
    const Job = database.model('MaterialTestJob', ExtractionJobSchema.clone(), `${prefix}_jobs`);
    const Extraction = database.model('MaterialTestExtraction', ExtractedTextSchema.clone(), `${prefix}_extractions`);
    const Chunk = database.model('MaterialTestChunk', ExtractedTextChunkSchema.clone(), `${prefix}_chunks`);
    const extractedText = new ExtractedTextService(Extraction as any, Chunk as any, Material as any, Job as any);
    const folders = new FolderService(Course as any, Folder as any, Material as any);
    const courses = new CourseService(Course as any, folders);
    const blobs = new Map<string, Buffer>();
    const storage = { ensureReady: async () => {}, upload: async (key: string, buffer: Buffer) => { blobs.set(key, buffer); },
        download: async (key: string) => Readable.from(blobs.get(key)!), remove: vi.fn(async (key: string) => { blobs.delete(key); }) };
    const materials = new MaterialService(Material as any, Usage as any, folders, storage as any, Job as any, extractedText, Analysis);
    const owner = new Types.ObjectId(), other = new Types.ObjectId();
    const file = (text = 'notes') => ({ originalname: 'notes.txt', mimetype: 'text/plain', buffer: Buffer.from(text) } as Express.Multer.File);
    beforeAll(async () => {
        await database.connect(process.env.MONGO_URI ?? 'mongodb://localhost:27017/Stream', { serverSelectionTimeoutMS: 8000 });
        await Promise.all([Course.init(), Folder.init(), Material.init(), Usage.init(), Job.init(), Analysis.init(), Extraction.init(), Chunk.init()]);
    }, 20000);
    afterAll(async () => {
        delete process.env.MATERIAL_ACCOUNT_LIMIT_BYTES;
        try { if (database.connection.readyState === 1) for (const model of [Course, Folder, Material, Usage, Job, Analysis, Extraction, Chunk]) {
            if (!model.collection.name.startsWith(prefix)) throw new Error('Invalid test collection');
            await model.collection.drop().catch((error) => { if (error.code !== 26) throw error; });
        } } finally { await database.disconnect(); }
    }, 20000);
    afterEach(() => { delete process.env.MATERIAL_ACCOUNT_LIMIT_BYTES; });
    it('persists a private material, inherits classification, protects parents and cleans up quota', async () => {
        const course = (await courses.create(owner, { name: 'Disposable materials' })).id;
        const lecture = (await folders.list(owner, course)).folders[1];
        const folder = await folders.create(owner, course, { name: 'Week 1', parent: lecture.id });
        const material = await materials.upload(owner, course, folder.id, file());
        expect(material.processingStatus).toBe('queued');
        expect(await Job.findOne({ material: material.id })).toMatchObject({ state: 'queued', materialVersion: 1 });
        expect((await Job.findOne({ material: material.id }))!.owner.toString()).toBe(owner.toString());
        expect(material.materialType).toBe('lecture'); expect(material.state).toBe('ready'); expect(material).not.toHaveProperty('storageKey');
        await expect(materials.content(other, course, material.id)).rejects.toBeInstanceOf(NotFoundException);
        await expect(folders.delete(owner, course, folder.id)).rejects.toBeInstanceOf(ConflictException);
        await expect(courses.delete(owner, course)).rejects.toBeInstanceOf(ConflictException);
        expect((await materials.rename(owner, course, material.id, { title: 'Lecture One' })).title).toBe('Lecture One');
        const { stream } = await materials.content(owner, course, material.id);
        const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks).toString()).toBe('notes');
        await materials.delete(owner, course, material.id);
        expect(await Job.countDocuments({ material: material.id })).toBe(0);
        expect((await Usage.findById(owner))!.bytes).toBe(0);
        await folders.delete(owner, course, folder.id); await courses.delete(owner, course);
    }, 30000);
    it('enforces one account quota during simultaneous uploads to different courses', async () => {
        const quotaOwner = new Types.ObjectId();
        process.env.MATERIAL_ACCOUNT_LIMIT_BYTES = '15';
        const first = (await courses.create(quotaOwner, { name: 'Quota A' })).id;
        const second = (await courses.create(quotaOwner, { name: 'Quota B' })).id;
        const results = await Promise.allSettled([materials.upload(quotaOwner, first, undefined, file('0123456789')), materials.upload(quotaOwner, second, undefined, file('0123456789'))]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect((await Usage.findById(quotaOwner))!.bytes).toBe(10);
        expect(await Material.countDocuments({ owner: quotaOwner })).toBe(1);
    }, 30000);
    it('prevents orphan materials during concurrent folder/course deletion and uploads', async () => {
        for (const kind of ['folder', 'course']) {
            const course = (await courses.create(owner, { name: `Race ${kind}` })).id;
            const folder = kind === 'folder' ? await folders.create(owner, course, { name: 'Race folder' }) : null;
            const results = await Promise.allSettled([materials.upload(owner, course, folder?.id, file()), folder ? folders.delete(owner, course, folder.id) : courses.delete(owner, course)]);
            expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
            for (const record of await Material.find({ course })) {
                expect(await Course.exists({ _id: record.course })).toBeTruthy();
                if (record.folder) expect(await Folder.exists({ _id: record.folder })).toBeTruthy();
            }
        }
    }, 30000);
    it('recovers a failed final metadata save and ambiguous upload through a durable journal', async () => {
        const course = (await courses.create(owner, { name: 'Recovery' })).id;
        const finalize = vi.spyOn(Material, 'findOneAndUpdate').mockImplementationOnce(() => { throw new Error('Simulated finalization outage'); });
        try { await expect(materials.upload(owner, course, undefined, file())).rejects.toThrow('Simulated finalization outage'); }
        finally { finalize.mockRestore(); }
        const pending = await Material.findOne({ course }); expect(pending!.state).toBe('cleanup_pending');
        expect(blobs.has(pending!.storageKey)).toBe(true);
        await Material.updateOne({ _id: pending!._id }, { $set: { retryAt: new Date(0) } });
        const restarted = new MaterialService(Material as any, Usage as any, folders, storage as any, Job as any, extractedText, Analysis);
        await restarted.recover();
        expect(await Material.exists({ _id: pending!._id })).toBeNull(); expect(blobs.has(pending!.storageKey)).toBe(false);
        expect((await Usage.findById(owner))!.bytes).toBe(0);
    }, 30000);
    it('retries storage deletion without exposing content or double-releasing quota', async () => {
        const deletionOwner = new Types.ObjectId();
        const course = (await courses.create(deletionOwner, { name: 'Delete retry' })).id;
        const material = await materials.upload(deletionOwner, course, undefined, file());
        storage.remove.mockRejectedValueOnce(new Error('Offline'));
        await expect(materials.delete(deletionOwner, course, material.id)).rejects.toBeInstanceOf(ServiceUnavailableException);
        await expect(materials.content(deletionOwner, course, material.id)).rejects.toBeInstanceOf(ConflictException);
        await Material.updateOne({ _id: material.id }, { $set: { retryAt: new Date(0) } });
        const secondWorker = new MaterialService(Material as any, Usage as any, folders, storage as any, Job as any, extractedText, Analysis);
        await Promise.all([materials.recover(), secondWorker.recover()]);
        expect((await Usage.findById(deletionOwner))!.bytes).toBe(0); expect(await Material.exists({ _id: material.id })).toBeNull();
    }, 30000);
    it('atomically rolls back material readiness when enqueue fails and recovers cleanup after restart', async () => {
        const jobOwner = new Types.ObjectId();
        const course = (await courses.create(jobOwner, { name: 'Enqueue rollback' })).id;
        const enqueue = vi.spyOn(Job, 'findOneAndUpdate').mockImplementationOnce(() => { throw new Error('Simulated enqueue outage'); });
        try { await expect(materials.upload(jobOwner, course, undefined, file())).rejects.toThrow('Simulated enqueue outage'); }
        finally { enqueue.mockRestore(); }
        const pending = await Material.findOne({ course });
        expect(pending!.state).toBe('cleanup_pending');
        expect(pending!.processingStatus).toBe('not_started');
        expect(await Job.countDocuments({ course })).toBe(0);
        await Material.updateOne({ _id: pending!._id }, { $set: { retryAt: new Date(0) } });
        const restarted = new MaterialService(Material as any, Usage as any, folders, storage as any, Job as any, extractedText, Analysis);
        await restarted.recover();
        expect(await Material.countDocuments({ course })).toBe(0);
        expect(await Job.countDocuments({ course })).toBe(0);
        expect((await Usage.findById(jobOwner))!.bytes).toBe(0);
    }, 30000);
    it('catches up existing documents concurrently without duplicates, and coordinates deletion', async () => {
        const jobOwner = new Types.ObjectId();
        const course = (await courses.create(jobOwner, { name: 'Catch-up race' })).id;
        const material = await materials.upload(jobOwner, course, undefined, file());
        await Job.deleteMany({ material: material.id });
        await Material.updateOne({ _id: material.id }, { $set: { processingStatus: 'not_started' } });
        const second = new MaterialService(Material as any, Usage as any, folders, storage as any, Job as any, extractedText, Analysis);
        await Promise.all([materials.catchUpExtractionJobs(), second.catchUpExtractionJobs()]);
        expect(await Job.countDocuments({ material: material.id })).toBe(1);
        expect((await Material.findById(material.id))!.processingStatus).toBe('queued');
        await Job.deleteMany({ material: material.id });
        await Material.updateOne({ _id: material.id }, { $set: { processingStatus: 'not_started' } });
        await Promise.all([second.catchUpExtractionJobs(), materials.delete(jobOwner, course, material.id)]);
        expect(await Job.countDocuments({ material: material.id })).toBe(0);
        expect(await Material.findById(material.id)).toBeNull();
    }, 30000);

});
