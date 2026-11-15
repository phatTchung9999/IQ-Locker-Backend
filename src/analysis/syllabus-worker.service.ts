import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { SyllabusAnalysis } from '../model/syllabus-analysis.schema.js';
import { ExtractedText, ExtractedTextChunk } from '../model/extracted-text.schema.js';
import { Material } from '../model/material.schema.js';
import { FolderService } from '../service/folder.service.js';
import { analyzeSyllabus } from './syllabus-analyzer.js';

@Injectable()
export class SyllabusWorkerService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(SyllabusWorkerService.name);
    private timer?: ReturnType<typeof setInterval>;
    private task?: Promise<boolean>;
    private stopped = false;
    constructor(@InjectModel(SyllabusAnalysis.name) private readonly jobs: Model<SyllabusAnalysis>,
        @InjectModel(ExtractedText.name) private readonly snapshots: Model<ExtractedText>,
        @InjectModel(ExtractedTextChunk.name) private readonly chunks: Model<ExtractedTextChunk>,
        @InjectModel(Material.name) private readonly materials: Model<Material>,
        private readonly folders: FolderService) {}

    onModuleInit() {
        if (process.env.SYLLABUS_ANALYSIS_ENABLED !== 'true') return;
        const tick = () => {
            if (!this.task && !this.stopped) this.task = this.runOnce()
                .catch(() => { this.logger.warn('Syllabus queue check failed'); return false; })
                .finally(() => { this.task = undefined; });
        };
        this.timer = setInterval(tick, 5000);
        this.timer.unref(); tick();
    }
    async onModuleDestroy() { this.stopped = true; clearInterval(this.timer); await this.task; }

    async runOnce() {
        const now = new Date(), token = randomUUID();
        await this.jobs.updateMany({ state: 'processing', leaseUntil: { $lte: now }, attempts: { $gte: 3 } },
            { $set: { state: 'failed', errorCode: 'attempts_exhausted', leaseUntil: null, leaseToken: null } });
        const job = await this.jobs.findOneAndUpdate({ analyzerVersion: 1, attempts: { $lt: 3 }, $or: [
            { state: 'queued', runAfter: { $lte: now } }, { state: 'processing', leaseUntil: { $lte: now } },
        ] }, { $set: { state: 'processing', leaseToken: token, leaseUntil: new Date(+now + 120000), errorCode: null },
            $inc: { attempts: 1 } }, { sort: { runAfter: 1, _id: 1 }, returnDocument: 'after' });
        if (!job) return false;
        const claim = () => ({ _id: job._id, state: 'processing', leaseToken: token, leaseUntil: { $gt: new Date() } });
        const scope = { owner: job.owner, course: job.course, material: job.material, materialVersion: job.materialVersion };
        const snapshot = { ...scope, _id: job.extraction };
        const fail = (errorCode: string) => this.jobs.updateOne(claim(), { $set: { state: 'failed', errorCode, leaseUntil: null, leaseToken: null } });
        try {
            const manifest = await this.snapshots.findOne(snapshot).lean();
            if (!manifest) { await fail('stale_extraction'); return false; }
            const chunks = await this.chunks.find({ ...scope, extraction: job.extraction }).sort({ index: 1 }).limit(2001).lean();
            if (chunks.length !== manifest.chunkCount || chunks.some((chunk, index) => chunk.index !== index) ||
                chunks.reduce((total, chunk) => total + chunk.text.length, 0) !== manifest.textChars) {
                await fail('invalid_output'); return false;
            }
            const suggestions = analyzeSyllabus(chunks, job);
            const textById = new Map(chunks.map(chunk => [chunk._id.toString(), chunk.text]));
            if (suggestions.some(row => [...row.sources, ...row.contextSources].some(source =>
                textById.get(source.chunk.toString())?.slice(source.start, source.end) !== source.quote))) {
                await fail('invalid_output'); return false;
            }
            return await this.folders.withCourse(job.owner, job.course.toString(), async (_, session) => {
                const material = await this.materials.exists({ _id: job.material, owner: job.owner, course: job.course,
                    version: job.materialVersion, state: 'ready', processingStatus: 'ready' }).session(session);
                const current = material && await this.snapshots.exists(snapshot).session(session);
                const result = await this.jobs.updateOne(claim(), { $set: current
                    ? { state: 'ready', suggestions, leaseUntil: null, leaseToken: null, errorCode: null }
                    : { state: 'failed', leaseUntil: null, leaseToken: null, errorCode: 'stale_extraction' } }, { session, runValidators: true });
                return !!current && result.modifiedCount === 1;
            });
        } catch {
            await fail('analysis_failed'); return false;
        }
    }
}
