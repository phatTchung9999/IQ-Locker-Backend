import 'reflect-metadata';
import 'dotenv/config';
import { Mongoose, Types } from 'mongoose';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Readable } from 'node:stream';
import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { CourseSchema } from '../src/model/course.schema.js';
import { FolderSchema } from '../src/model/folder.schema.js';
import { MaterialSchema, StorageUsageSchema } from '../src/model/material.schema.js';
import { ExtractionJobSchema } from '../src/model/extraction-job.schema.js';
import { ExtractedTextSchema, ExtractedTextChunkSchema } from '../src/model/extracted-text.schema.js';
import { FolderService } from '../src/service/folder.service.js';
import { CourseService } from '../src/service/course.service.js';
import { MaterialService } from '../src/service/material.service.js';
import { ExtractedTextService } from '../src/extraction/extracted-text.service.js';
import { ExtractionParserService } from '../src/extraction/extraction-parser.service.js';
import { ExtractionWorkerService } from '../src/extraction/extraction-worker.service.js';

describe.skipIf(process.env.IQLOCKER_MONGO_TEST !== '1')('Private extracted text lifecycle (disposable collections and fake blobs)', () => {
    const database = new Mongoose();
    const prefix = `iqlocker_text_test_${new Types.ObjectId()}`;
    const Course = database.model('TextTestCourse', CourseSchema.clone(), `${prefix}_courses`);
    const Folder = database.model('TextTestFolder', FolderSchema.clone(), `${prefix}_folders`);
    const Material = database.model('TextTestMaterial', MaterialSchema.clone(), `${prefix}_materials`);
    const Usage = database.model('TextTestUsage', StorageUsageSchema.clone(), `${prefix}_usage`);
    const Job = database.model('TextTestJob', ExtractionJobSchema.clone(), `${prefix}_jobs`);
    const Result = database.model('TextTestResult', ExtractedTextSchema.clone(), `${prefix}_results`);
    const Chunk = database.model('TextTestChunk', ExtractedTextChunkSchema.clone(), `${prefix}_chunks`);
    const models = [Course, Folder, Material, Usage, Job, Result, Chunk];
    const folders = new FolderService(Course as any, Folder as any, Material as any);
    const courses = new CourseService(Course as any, folders);
    const text = new ExtractedTextService(Result as any, Chunk as any, Material as any, Job as any);
    const blobs = new Map<string, Buffer>();
    const storage = { ensureReady: async () => {}, upload: async (key: string, bytes: Buffer) => { blobs.set(key, bytes); }, remove: async (key: string) => { blobs.delete(key); }, download: async (key: string) => Readable.from(blobs.get(key)!) };
    const materials = new MaterialService(Material as any, Usage as any, folders, storage as any, Job as any, text);
    const parser = new ExtractionParserService();
    const worker = (engine: any = parser) => new ExtractionWorkerService(Job as any, Material as any, folders, storage as any, engine, text);
    const owner = new Types.ObjectId(), other = new Types.ObjectId();
    let course: string;
    const file = (value: string | Buffer, pdf = false) => ({ buffer: Buffer.isBuffer(value) ? value : Buffer.from(value), originalname: pdf ? 'notes.pdf' : 'notes.txt', mimetype: pdf ? 'application/pdf' : 'text/plain' } as Express.Multer.File);
    beforeAll(async () => {
        await database.connect(process.env.MONGO_URI ?? 'mongodb://localhost:27017/Stream', { serverSelectionTimeoutMS: 8000 });
        await Promise.all(models.map(model => model.init()));
    }, 20000);
    beforeEach(async () => {
        vi.stubEnv('EXTRACTION_PROCESSING_ENABLED', 'true');
        for (const model of models) await model.deleteMany({});
        blobs.clear(); course = (await courses.create(owner, { name: 'Source test' })).id;
    });
    afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
    afterAll(async () => {
        await parser.onModuleDestroy();
        try { if (database.connection.readyState === 1) for (const model of models) {
            if (!model.collection.name.startsWith(prefix)) throw new Error('Invalid test collection');
            await model.collection.drop();
        } } finally { await database.disconnect(); }
    });
    it('extracts uploaded TXT, stores exact source references, privately reads and deletes derived data', async () => {
        const original = '<script>untrusted data</script>\r\n' + 'Café 😀 '.repeat(900);
        const material = await materials.upload(owner, course, undefined, file(original));
        await expect(text.read(owner, course, material.id)).rejects.toBeInstanceOf(ConflictException);
        expect(await worker().runOnce()).toBe(true);
        const response = await text.read(owner, course, material.id);
        expect(response.chunks.map(c => c.text).join('')).toBe(original);
        expect(response.chunks[0]).toMatchObject({ page: null, charStart: 0, lineStart: 1 });
        expect(response).not.toHaveProperty('owner'); expect(response).not.toHaveProperty('storageKey');
        expect((await Material.findById(material.id))!.processingStatus).toBe('ready');
        expect((await Job.findOne({ material: material.id }))!.state).toBe('ready');
        await expect(text.read(other, course, material.id)).rejects.toBeInstanceOf(NotFoundException);
        const different = (await courses.create(owner, { name: 'Other' })).id;
        await expect(text.read(owner, different, material.id)).rejects.toBeInstanceOf(NotFoundException);
        await materials.delete(owner, course, material.id);
        expect(await Result.countDocuments({})).toBe(0); expect(await Chunk.countDocuments({})).toBe(0);
        expect(await Job.countDocuments({})).toBe(0); expect(blobs.size).toBe(0);
        await expect(text.read(owner, course, material.id)).rejects.toBeInstanceOf(NotFoundException);
    }, 30000);
    it('extracts a real PDF with source page references', async () => {
        const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
        pdf.addPage().drawText('Course syllabus page one', { font });
        pdf.addPage().drawText('Exam reference page two', { font });
        const material = await materials.upload(owner, course, undefined, file(Buffer.from(await pdf.save()), true));
        await worker().runOnce();
        const response = await text.read(owner, course, material.id);
        expect(response.pageCount).toBe(2);
        expect(response.chunks.map(c => c.page)).toEqual([1, 2]);
        expect(response.chunks[1].text).toContain('Exam reference page two');
    }, 30000);
    it('paginates bounded chunks using a stable extraction ID and rejects invalid requests', async () => {
        const material = await materials.upload(owner, course, undefined, file('x'.repeat(90000)));
        await worker().runOnce();
        const first = await text.read(owner, course, material.id);
        expect(first.chunks).toHaveLength(20); expect(first.nextOffset).toBe(20);
        const second = await text.read(owner, course, material.id, '20', first.extractionId);
        expect(second.chunks).toHaveLength(3); expect(second.nextOffset).toBeNull();
        expect(first.chunks.map(c => c.text).join('') + second.chunks.map(c => c.text).join('')).toBe('x'.repeat(90000));
        await expect(text.read(owner, course, material.id, '20')).rejects.toBeInstanceOf(BadRequestException);
        await expect(text.read(owner, course, material.id, '-1')).rejects.toBeInstanceOf(BadRequestException);
        await expect(text.read(owner, course, material.id, '20', new Types.ObjectId().toString())).rejects.toBeInstanceOf(ConflictException);
    }, 30000);
    it('rolls back all source text and ready flags if chunk persistence fails', async () => {
        const material = await materials.upload(owner, course, undefined, file('notes'));
        vi.spyOn(Chunk, 'insertMany').mockImplementationOnce(() => { throw new Error('Simulated chunk outage'); });
        await worker().runOnce();
        expect(await Result.countDocuments({})).toBe(0); expect(await Chunk.countDocuments({})).toBe(0);
        expect((await Material.findById(material.id))!.processingStatus).toBe('queued');
        expect((await Material.findById(material.id))!.state).toBe('ready');
        expect((await Job.findOne({ material: material.id }))!.state).toBe('queued');
        expect(blobs.size).toBe(1);
    }, 30000);
    it('never publishes stale-version or deleted results during parsing', async () => {
        for (const change of ['version', 'delete']) {
            const material = await materials.upload(owner, course, undefined, file('notes'));
            const engine = { extract: async () => {
                if (change === 'version') await Material.collection.updateOne({ _id: new Types.ObjectId(material.id) }, { $set: { version: 2 } });
                else await materials.delete(owner, course, material.id);
                return { extractorVersion: 1, pages: [{ page: null, text: 'notes' }], textChars: 5 };
            } };
            await worker(engine).runOnce();
            expect(await Result.countDocuments({ material: material.id })).toBe(0);
            expect(await Chunk.countDocuments({ material: material.id })).toBe(0);
        }
    }, 30000);
    it('replaces the same version idempotently inside a transaction and rejects stale leases', async () => {
        const material = await materials.upload(owner, course, undefined, file('notes'));
        await Job.updateOne({ material: material.id }, { $set: { state: 'processing', leaseToken: 'test-lease', leaseUntil: new Date(Date.now() + 180000) } });
        const original = (await Material.findById(material.id))!;
        const job = (await Job.findOne({ material: material.id }).select('+leaseToken'))!;
        const result = { extractorVersion: 1, pages: [{ page: null, text: 'notes' }], textChars: 5 };
        for (let n = 0; n < 2; n++) await folders.withCourse(owner, course, async (_, session) => { await text.save(result, original, job, session); });
        expect(await Result.countDocuments({ material: material.id })).toBe(1);
        expect(await Chunk.countDocuments({ material: material.id })).toBe(1);
        await Job.updateOne({ _id: job._id }, { $set: { leaseToken: 'replacement' } });
        await expect(folders.withCourse(owner, course, async (_, session) => text.save(result, original, job, session))).rejects.toMatchObject({ code: 'timeout' });
    }, 30000);
    it('coordinates deletion that starts while result publication is in flight', async () => {
        const material = await materials.upload(owner, course, undefined, file('notes'));
        let inserted!: () => void, release!: () => void;
        const staged = new Promise<void>(resolve => { inserted = resolve; });
        const unblock = new Promise<void>(resolve => { release = resolve; });
        const original = Chunk.insertMany.bind(Chunk);
        vi.spyOn(Chunk, 'insertMany').mockImplementationOnce((async (...args: any[]) => {
            const value = await (original as any)(...args);
            inserted(); await unblock; return value;
        }) as any);
        const processing = worker().runOnce();
        await staged;
        const deletion = materials.delete(owner, course, material.id);
        try {
            await vi.waitFor(async () => expect((await Material.findById(material.id))!.state).toBe('deleting'));
        } finally { release(); }
        await Promise.all([processing, deletion]);
        expect(await Material.findById(material.id)).toBeNull();
        expect(await Result.countDocuments({ material: material.id })).toBe(0);
        expect(await Chunk.countDocuments({ material: material.id })).toBe(0);
        expect(await Job.countDocuments({ material: material.id })).toBe(0);
    }, 30000);

    it('reuses an eligible failed job under concurrent retry requests then extracts successfully', async () => {
        const material = await materials.upload(owner, course, undefined, file('retry notes'));
        await worker({ extract: async () => { throw new (await import('../src/extraction/extraction.types.js')).ExtractionFailure('parser_failed'); } }).runOnce();
        const originalJob = (await Job.findOne({ material: material.id }))!;
        expect((await materials.read(owner, course, material.id)).canRetryExtraction).toBe(true);
        await expect(materials.retryExtraction(other, course, material.id)).rejects.toBeInstanceOf(NotFoundException);
        const retries = await Promise.allSettled([materials.retryExtraction(owner, course, material.id), materials.retryExtraction(owner, course, material.id)]);
        expect(retries.filter(value => value.status === 'fulfilled')).toHaveLength(1);
        expect(await Job.countDocuments({ material: material.id })).toBe(1);
        const queued = (await Job.findById(originalJob._id))!;
        expect(queued.attempts).toBe(1); expect(queued.state).toBe('queued');
        await worker().runOnce();
        expect((await Job.findById(originalJob._id))!.attempts).toBe(2);
        expect((await text.read(owner, course, material.id)).chunks[0].text).toBe('retry notes');
        await expect(materials.retryExtraction(owner, course, material.id)).rejects.toBeInstanceOf(ConflictException);
    }, 30000);

});
