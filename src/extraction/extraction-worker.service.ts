import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { ExtractionJob } from '../model/extraction-job.schema.js';
import type { ExtractionJobDocument } from '../model/extraction-job.schema.js';
import { Material } from '../model/material.schema.js';
import { FolderService } from '../service/folder.service.js';
import { BlobStorageService } from '../storage/blob-storage.service.js';
import { ExtractionParserService } from './extraction-parser.service.js';
import { EXTRACTION_RESULT_WRITER, ExtractionFailure, extractionLimits } from './extraction.types.js';
import type { ExtractionResultWriter, ExtractionCode, ExtractionResult } from './extraction.types.js';

@Injectable()
export class ExtractionWorkerService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ExtractionWorkerService.name);
    private timer?: ReturnType<typeof setInterval>;
    private running = false;
    private stopped = false;
    private task?: Promise<boolean>;
    private controller?: AbortController;
    constructor(@InjectModel(ExtractionJob.name) private readonly jobs: Model<ExtractionJob>,
        @InjectModel(Material.name) private readonly materials: Model<Material>,
        private readonly folders: FolderService, private readonly storage: BlobStorageService,
        private readonly parser: ExtractionParserService,
        @Optional() @Inject(EXTRACTION_RESULT_WRITER) private readonly writer?: ExtractionResultWriter) {}
    onModuleInit() {
        const limits = extractionLimits();
        if (!limits.enabled) return;
        if (!this.writer) throw new Error('Extraction processing requires a source-text result writer.');
        this.timer = setInterval(() => { if (!this.running) this.task = this.runOnce(); }, 5000);
        this.timer.unref();
        this.task = this.runOnce();
    }
    async onModuleDestroy() {
        this.stopped = true;
        if (this.timer) clearInterval(this.timer);
        this.controller?.abort();
        await this.task;
    }
    private ownedMaterial(job: ExtractionJobDocument) {
        return { _id: job.material, owner: job.owner, course: job.course, version: job.materialVersion, state: 'ready' };
    }
    private lease(job: ExtractionJobDocument) {
        return { _id: job._id, owner: job.owner, material: job.material, materialVersion: job.materialVersion,
            state: 'processing', leaseToken: job.leaseToken, leaseUntil: { $gt: new Date() } };
    }
    private async recoverExpired() {
        const expired = await this.jobs.find({ state: 'processing', leaseUntil: { $lte: new Date() } }).select('+leaseToken').limit(10);
        for (const job of expired) {
            try {
                await this.folders.withCourse(job.owner, job.course.toString(), async (_, session) => {
                    const filter = { _id: job._id, state: 'processing', leaseToken: job.leaseToken, leaseUntil: { $lte: new Date() } };
                    const current = await this.jobs.findOne(filter).session(session);
                    if (!current) return;
                    const material = await this.materials.findOne(this.ownedMaterial(job)).session(session);
                    if (!material) { await this.jobs.deleteOne(filter, { session }); return; }
                    const state = current.attempts >= current.maxAttempts ? 'failed' : 'queued';
                    const errorCode = state === 'failed' ? 'attempts_exhausted' : 'timeout';
                    await this.jobs.updateOne(filter, { $set: { state, errorCode, leaseToken: null, leaseUntil: null,
                        runAfter: new Date(Date.now() + 60000), completedAt: state === 'failed' ? new Date() : null } }, { session });
                    await this.materials.updateOne(this.ownedMaterial(job), { $set: { processingStatus: state, processingErrorCode: errorCode } }, { session });
                });
            } catch {
                // A removed course cannot retain a task. Do not erase a renewed lease.
                if (!await this.materials.exists(this.ownedMaterial(job))) await this.jobs.deleteOne({ _id: job._id, state: 'processing', leaseToken: job.leaseToken, leaseUntil: { $lte: new Date() } });
            }
        }
    }
    private async finishFailure(job: ExtractionJobDocument, code: ExtractionCode) {
        await this.folders.withCourse(job.owner, job.course.toString(), async (_, session) => {
            const current = await this.jobs.findOne(this.lease(job)).session(session);
            if (!current) return;
            const retryable = ['storage_unavailable', 'timeout'].includes(code) && current.attempts < current.maxAttempts;
            const state = retryable ? 'queued' : 'failed';
            const changed = await this.jobs.updateOne(this.lease(job), { $set: { state, errorCode: code, leaseToken: null, leaseUntil: null,
                runAfter: new Date(Date.now() + 60000 * current.attempts), completedAt: retryable ? null : new Date() } }, { session });
            if (!changed.matchedCount) return;
            await this.materials.updateOne(this.ownedMaterial(job), { $set: { processingStatus: state, processingErrorCode: code } }, { session });
        });
    }
    private async publish(job: ExtractionJobDocument, result: ExtractionResult) {
        await this.folders.withCourse(job.owner, job.course.toString(), async (_, session) => {
            const current = await this.jobs.findOne(this.lease(job)).select('+leaseToken').session(session);
            const material = await this.materials.findOne(this.ownedMaterial(job)).session(session);
            if (!current || !material || this.stopped) return;
            // The writer must only write transactionally and be safe on transaction retries.
            await this.writer!.save(result, material, current, session);
            if (this.stopped) throw new ExtractionFailure('timeout');
            const changed = await this.jobs.updateOne(this.lease(job), { $set: { state: 'ready', completedAt: new Date(),
                errorCode: null, leaseToken: null, leaseUntil: null } }, { session });
            if (!changed.matchedCount) throw new ExtractionFailure('timeout');
            await this.materials.updateOne(this.ownedMaterial(job), { $set: { processingStatus: 'ready', processedAt: new Date(), processingErrorCode: null } }, { session });
        });
    }
    private async readOriginal(key: string, expectedBytes: number, signal: AbortSignal) {
        const limit = extractionLimits().maxInputBytes;
        if (expectedBytes > limit) throw new ExtractionFailure('output_limit');
        const stream = await this.storage.download(key, signal);
        const stop = () => stream.destroy(new ExtractionFailure('timeout'));
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
        try {
            const chunks: Buffer[] = []; let size = 0;
            for await (const part of stream) {
                const chunk = Buffer.from(part); size += chunk.length;
                if (size > limit || size > expectedBytes) throw new ExtractionFailure('output_limit');
                chunks.push(chunk);
            }
            if (size !== expectedBytes) throw new ExtractionFailure('parser_failed');
            return Buffer.concat(chunks, size);
        } finally { signal.removeEventListener('abort', stop); stream.destroy(); }
    }
    async runOnce(): Promise<boolean> {
        const limits = extractionLimits();
        if (this.running || this.stopped || !limits.enabled || !this.writer) return false;
        this.running = true;
        let job: ExtractionJobDocument | null = null;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
            await this.recoverExpired();
            job = await this.jobs.findOneAndUpdate({ state: 'queued', runAfter: { $lte: new Date() }, $expr: { $lt: ['$attempts', '$maxAttempts'] } },
                { $set: { state: 'processing', leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + limits.leaseMs), startedAt: new Date(), completedAt: null, errorCode: null }, $inc: { attempts: 1 } },
                { sort: { runAfter: 1, _id: 1 }, returnDocument: 'after' }).select('+leaseToken');
            if (!job) return false;
            const claimed = job;
            const controller = new AbortController(); this.controller = controller;
            deadline = setTimeout(() => controller.abort(), limits.timeoutMs);
            let renewing = false;
            heartbeat = setInterval(() => {
                if (renewing) return;
                renewing = true;
                void this.jobs.updateOne(this.lease(claimed), { $set: { leaseUntil: new Date(Date.now() + limits.leaseMs) } })
                    .then(result => { if (!result.matchedCount) controller.abort(); }, () => controller.abort())
                    .finally(() => { renewing = false; });
            }, 30000);
            heartbeat.unref();
            const material = await this.folders.withCourse(job.owner, job.course.toString(), async (_, session) => {
                if (!await this.jobs.exists(this.lease(claimed)).session(session)) return null;
                return this.materials.findOneAndUpdate(this.ownedMaterial(claimed),
                    { $set: { processingStatus: 'processing', processingErrorCode: null } }, { session, returnDocument: 'after' });
            });
            if (!material) {
                await this.jobs.deleteOne(this.lease(job)); return true;
            }
            let bytes: Buffer;
            try { bytes = await this.readOriginal(material.storageKey, material.sizeBytes, controller.signal); }
            catch (error) { throw error instanceof ExtractionFailure ? error : new ExtractionFailure(controller.signal.aborted ? 'timeout' : 'storage_unavailable'); }
            const result = await this.parser.extract(bytes, material.mediaType, controller.signal);
            if (controller.signal.aborted) throw new ExtractionFailure('timeout');
            await this.publish(job, result);
            return true;
        } catch (error) {
            if (job && !this.stopped) {
                // No parser/provider exception text or student text is persisted/logged.
                const code = error instanceof ExtractionFailure ? error.code : 'storage_unavailable';
                try { await this.finishFailure(job, code); }
                catch { this.logger.warn('Extraction state will recover after its lease expires.'); }
            } else if (!this.stopped) this.logger.warn('Extraction queue is unavailable; retrying later.');
            return false;
        } finally {
            if (heartbeat) clearInterval(heartbeat);
            if (deadline) clearTimeout(deadline);
            this.controller = undefined; this.running = false;
        }
    }
}
