import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { Types } from 'mongoose';
import { PDFDocument } from 'pdf-lib';
import { Readable } from 'node:stream';
import { courseModelFixture } from '../../test/fixtures/course-model.js';
import { ExtractedTextService } from '../extraction/extracted-text.service.js';
import { MaterialService } from './material.service.js';
import { FolderService } from './folder.service.js';
import { CourseService } from './course.service.js';
import { materialTitle, validateMaterial } from '../dto/material.dto.js';
const fixture = courseModelFixture();
const folders = new FolderService(fixture.CourseModel as any, fixture.FolderModel as any, fixture.MaterialModel as any);
const courses = new CourseService(fixture.CourseModel as any, folders);
const blobs = new Map<string, Buffer>();
const storage = { ensureReady: vi.fn(async () => undefined), upload: vi.fn(async (key: string, buffer: Buffer) => { blobs.set(key, buffer); }),
    remove: vi.fn(async (key: string) => { blobs.delete(key); }), download: vi.fn(async (key: string) => Readable.from(blobs.get(key)!)) };
const extractedText = new ExtractedTextService(fixture.ExtractionModel as any, fixture.ChunkModel as any, fixture.MaterialModel as any, fixture.JobModel as any);
const service = new MaterialService(fixture.MaterialModel as any, fixture.UsageModel as any, folders, storage as any, fixture.JobModel as any, extractedText, fixture.AnalysisModel as any);
export const uploadFile = (text: Buffer | string = 'lecture notes', name = 'notes.txt', mimetype = 'text/plain') => ({ buffer: typeof text === 'string' ? Buffer.from(text) : text, originalname: name, mimetype } as Express.Multer.File);
const owner = new Types.ObjectId(), other = new Types.ObjectId();
let course: string;
beforeEach(async () => {
    vi.clearAllMocks(); delete process.env.MATERIAL_ACCOUNT_LIMIT_BYTES;
    fixture.stored.clear(); fixture.folders.clear(); fixture.materials.clear(); fixture.usage.clear(); fixture.jobs.clear(); fixture.analyses.clear(); fixture.extractions.clear(); fixture.chunks.clear(); blobs.clear();
    course = (await courses.create(owner, { name: 'Biology' })).id;
});
afterEach(() => { delete process.env.MATERIAL_ACCOUNT_LIMIT_BYTES; });
it('uploads privately, inherits nearest classified ancestor, projects safe metadata, renames and deletes', async () => {
    const lecture = (await folders.list(owner, course)).folders[1];
    const week = await folders.create(owner, course, { name: 'Week 1', parent: lecture.id });
    const document = await service.upload(owner, course, week.id, uploadFile());
    expect(document).toMatchObject({ title: 'notes', state: 'ready', materialType: 'lecture', version: 1, processingStatus: 'queued' });
    const job = [...fixture.jobs.values()][0];
    expect(job.owner.toString()).toBe(owner.toString());
    expect(job.material.toString()).toBe(document.id);
    expect(job.materialVersion).toBe(1); expect(job.state).toBe('queued');
    expect(document).not.toHaveProperty('storageKey'); expect(document).not.toHaveProperty('owner');
    expect((await service.list(owner, course, week.id)).materials).toHaveLength(1);
    expect((await service.list(owner, course)).materials).toHaveLength(0);
    const key = [...blobs.keys()][0];
    expect(key).not.toContain('notes');
    expect(await service.rename(owner, course, document.id, { title: 'Week 1 notes', owner: other, folder: lecture.id })).toMatchObject({ title: 'Week 1 notes', folder: week.id });
    expect([...blobs.keys()][0]).toBe(key);
    expect((await service.content(owner, course, document.id)).material.originalFilename).toBe('notes.txt');
    await expect(folders.delete(owner, course, week.id)).rejects.toBeInstanceOf(ConflictException);
    await expect(courses.delete(owner, course)).rejects.toBeInstanceOf(ConflictException);
    await fixture.AnalysisModel.create([
        { owner, course: job.course, material: job.material, state: 'ready', suggestions: [] },
        { owner, course: job.course, material: new Types.ObjectId(), state: 'queued' },
    ]);
    await service.delete(owner, course, document.id);
    expect([...fixture.analyses.values()].map(row => row.material.toString())).not.toContain(document.id);
    expect(fixture.analyses.size).toBe(1);
    expect(blobs.size).toBe(0); expect(fixture.materials.size).toBe(0); expect(fixture.jobs.size).toBe(0); expect(fixture.usage.get(owner.toString()).bytes).toBe(0);
    await folders.delete(owner, course, week.id);
    await courses.delete(owner, course);
});
it('allows valid PDF, UTF-8 text and safely stored markup without content execution', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    expect(await validateMaterial(uploadFile(Buffer.from(await pdf.save()), 'exam.pdf', 'application/pdf'))).toMatchObject({ mediaType: 'application/pdf' });
    const document = await service.upload(owner, course, undefined, uploadFile('<script>alert(1)</script>'));
    expect(document.materialType).toBe('');
    expect((await service.content(owner, course, document.id)).material.mediaType).toBe('text/plain');
});
it.each([
    uploadFile('', 'empty.txt'), uploadFile('bad', '../notes.txt'), uploadFile('bad', 'notes.html', 'text/html'),
    uploadFile('bad', 'exam.pdf', 'application/pdf'), uploadFile(Buffer.from([0xc3, 0x28])), uploadFile(Buffer.from([0, 1])), uploadFile('text', 'a.txt', 'application/pdf'),
])('rejects unsupported, invalid and misleading files', async (file) => { await expect(validateMaterial(file)).rejects.toBeInstanceOf(BadRequestException); });
it('rejects an oversized file and invalid titles', async () => {
    await expect(validateMaterial(uploadFile(Buffer.alloc(20_000_001, 65)))).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(() => materialTitle(' ')).toThrow(BadRequestException); expect(() => materialTitle('x'.repeat(161))).toThrow(BadRequestException);
});
it('isolates accounts, courses, folders and invalid reference IDs before touching storage', async () => {
    const document = await service.upload(owner, course, undefined, uploadFile());
    for (const method of ['read', 'content', 'delete'] as const) await expect(service[method](other, course, document.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.rename(other, course, document.id, { title: 'Stolen' })).rejects.toBeInstanceOf(NotFoundException);
    const second = (await courses.create(owner, { name: 'Second' })).id;
    const folder = (await folders.list(owner, second)).folders[0];
    await expect(service.upload(owner, course, folder.id, uploadFile())).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.read(owner, second, document.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.read(owner, course, 'bad')).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.download).not.toHaveBeenCalled();
});
it('serializes quota reservations across courses and retains quota until cleanup succeeds', async () => {
    process.env.MATERIAL_ACCOUNT_LIMIT_BYTES = '15';
    const second = (await courses.create(owner, { name: 'Second' })).id;
    const results = await Promise.allSettled([service.upload(owner, course, undefined, uploadFile('1234567890')), service.upload(owner, second, undefined, uploadFile('1234567890'))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(fixture.usage.get(owner.toString()).bytes).toBe(10);
    expect(storage.upload).toHaveBeenCalledTimes(1);
});
it('persists an ambiguous failed upload and recovers after restart without leaking quota', async () => {
    storage.upload.mockImplementationOnce(async (key, buffer) => { blobs.set(key, buffer); throw new ServiceUnavailableException('Network failure'); });
    await expect(service.upload(owner, course, undefined, uploadFile())).rejects.toBeInstanceOf(ServiceUnavailableException);
    const reserved = [...fixture.materials.values()][0];
    expect(reserved.state).toBe('cleanup_pending'); expect(fixture.usage.get(owner.toString()).bytes).toBeGreaterThan(0);
    await expect(courses.delete(owner, course)).rejects.toBeInstanceOf(ConflictException);
    fixture.materials.get(reserved._id.toString()).retryAt = new Date(0);
    const restarted = new MaterialService(fixture.MaterialModel as any, fixture.UsageModel as any, folders, storage as any, fixture.JobModel as any, extractedText, fixture.AnalysisModel as any);
    await restarted.recover();
    expect(blobs.size).toBe(0); expect(fixture.materials.size).toBe(0); expect(fixture.jobs.size).toBe(0); expect(fixture.usage.get(owner.toString()).bytes).toBe(0);
});
it('retries a failed deletion, disables content immediately, and releases quota exactly once', async () => {
    const document = await service.upload(owner, course, undefined, uploadFile());
    storage.remove.mockRejectedValueOnce(new Error('Storage offline'));
    await expect(service.delete(owner, course, document.id)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.content(owner, course, document.id)).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.usage.get(owner.toString()).bytes).toBeGreaterThan(0);
    fixture.materials.get(document.id).retryAt = new Date(0);
    await Promise.all([service.recover(), service.recover()]);
    expect(fixture.materials.size).toBe(0); expect(fixture.usage.get(owner.toString()).bytes).toBe(0);
    await expect(service.delete(owner, course, document.id)).rejects.toBeInstanceOf(NotFoundException);
});
it('does not expose pending uploads and recovers expired reservations', async () => {
    let finish!: () => void;
    storage.upload.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const task = service.upload(owner, course, undefined, uploadFile());
    await vi.waitFor(() => expect(fixture.materials.size).toBe(1));
    const pending = [...fixture.materials.values()][0];
    await expect(service.content(owner, course, pending._id.toString())).rejects.toBeInstanceOf(ConflictException);
    await expect(courses.delete(owner, course)).rejects.toBeInstanceOf(ConflictException);
    fixture.materials.get(pending._id.toString()).retryAt = new Date(0); await service.recover(); finish();
    await expect(task).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.materials.size).toBe(0);
});

it('rolls back ready status if job creation fails, then cleans up the blob and quota', async () => {
    const enqueue = vi.spyOn(fixture.JobModel, 'findOneAndUpdate').mockImplementationOnce(() => { throw new Error('Job database unavailable'); });
    try { await expect(service.upload(owner, course, undefined, uploadFile())).rejects.toThrow('Job database unavailable'); }
    finally { enqueue.mockRestore(); }
    const pending = [...fixture.materials.values()][0];
    expect(pending.state).toBe('cleanup_pending');
    expect(pending.processingStatus).toBe('not_started');
    expect(fixture.jobs.size).toBe(0);
    expect(blobs.size).toBe(1);
    pending.retryAt = new Date(0);
    await service.recover();
    expect(fixture.jobs.size).toBe(0); expect(fixture.materials.size).toBe(0); expect(blobs.size).toBe(0);
    expect(fixture.usage.get(owner.toString()).bytes).toBe(0);
});
it('bounds catch-up to ten ready materials per pass and is safe across repeated passes', async () => {
    for (let n = 0; n < 12; n++) {
        const material = await service.upload(owner, course, undefined, uploadFile());
        fixture.materials.get(material.id).processingStatus = 'not_started';
    }
    fixture.jobs.clear();
    await service.catchUpExtractionJobs();
    expect(fixture.jobs.size).toBe(10);
    await Promise.all([service.catchUpExtractionJobs(), service.catchUpExtractionJobs()]);
    expect(fixture.jobs.size).toBe(12);
    expect([...fixture.materials.values()].every((material) => material.processingStatus === 'queued')).toBe(true);
    await service.catchUpExtractionJobs();
    expect(fixture.jobs.size).toBe(12);
});
it('does not enqueue pending uploads or documents scheduled for cleanup', async () => {
    const material = await service.upload(owner, course, undefined, uploadFile());
    fixture.jobs.clear();
    const record = fixture.materials.get(material.id);
    record.processingStatus = 'not_started';
    for (const state of ['uploading', 'deleting', 'cleanup_pending']) {
        record.state = state; await service.catchUpExtractionJobs(); expect(fixture.jobs.size).toBe(0);
    }
});

it('retries an eligible failed extraction on the same job without resetting attempts or quota', async () => {
    const material = await service.upload(owner, course, undefined, uploadFile());
    const record = fixture.materials.get(material.id), job = [...fixture.jobs.values()][0];
    record.processingStatus = 'failed'; record.processingErrorCode = 'parser_failed';
    Object.assign(job, { state: 'failed', errorCode: 'parser_failed', attempts: 1, maxAttempts: 3 });
    const jobId = job._id.toString(), bytes = fixture.usage.get(owner.toString()).bytes;
    expect(await service.read(owner, course, material.id)).toMatchObject({ canRetryExtraction: true, processingAttempts: 1, processingMaxAttempts: 3, processingErrorCode: 'parser_failed' });
    const retries = await Promise.allSettled([service.retryExtraction(owner, course, material.id), service.retryExtraction(owner, course, material.id)]);
    expect(retries.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(job._id.toString()).toBe(jobId); expect(job.attempts).toBe(1); expect(job.state).toBe('queued');
    expect(fixture.jobs.size).toBe(1); expect(fixture.usage.get(owner.toString()).bytes).toBe(bytes);
    expect(storage.upload).toHaveBeenCalledTimes(1);
});
it('refuses foreign, active, exhausted and non-retryable extraction requests', async () => {
    const material = await service.upload(owner, course, undefined, uploadFile());
    await expect(service.retryExtraction(other, course, material.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.retryExtraction(owner, course, material.id)).rejects.toBeInstanceOf(ConflictException);
    const record = fixture.materials.get(material.id), job = [...fixture.jobs.values()][0];
    record.processingStatus = 'failed';
    for (const errorCode of ['no_readable_text', 'output_limit', 'attempts_exhausted']) {
        Object.assign(job, { state: 'failed', errorCode, attempts: 1, maxAttempts: 3 });
        await expect(service.retryExtraction(owner, course, material.id)).rejects.toBeInstanceOf(ConflictException);
    }
    Object.assign(job, { state: 'failed', errorCode: 'timeout', attempts: 3, maxAttempts: 3 });
    expect((await service.read(owner, course, material.id)).canRetryExtraction).toBe(false);
    await expect(service.retryExtraction(owner, course, material.id)).rejects.toBeInstanceOf(ConflictException);
});
