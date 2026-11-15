import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { Material } from '../model/material.schema.js';
import { ExtractedText, ExtractedTextChunk } from '../model/extracted-text.schema.js';
import { SyllabusAnalysis } from '../model/syllabus-analysis.schema.js';
import { FolderService } from './folder.service.js';

type Scope = { owner: Types.ObjectId; course: Types.ObjectId };
function id(value: string) {
    if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw new BadRequestException('Invalid document or course ID');
    return new Types.ObjectId(value);
}

@Injectable()
export class SyllabusAnalysisService {
    constructor(@InjectModel(Material.name) private readonly materials: Model<Material>,
        @InjectModel(ExtractedText.name) private readonly extractions: Model<ExtractedText>,
        @InjectModel(SyllabusAnalysis.name) private readonly jobs: Model<SyllabusAnalysis>,
        private readonly folders: FolderService,
        @InjectModel(ExtractedTextChunk.name) private readonly chunks: Model<ExtractedTextChunk>) {}

    private async identity(scope: Scope, materialId: Types.ObjectId, session: ClientSession) {
        const material = await this.materials.findOne({ ...scope, _id: materialId }).session(session);
        if (!material) throw new NotFoundException('Document not found');
        if (material.state !== 'ready' || material.processingStatus !== 'ready') throw new ConflictException('Extracted text is not ready');
        const snapshot = await this.extractions.findOne({ ...scope, material: materialId, materialVersion: material.version }).session(session);
        if (!snapshot) throw new ConflictException('Extracted text is not ready');
        return { ...scope, material: materialId, materialVersion: material.version, extraction: snapshot._id, analyzerVersion: 1 };
    }

    private response(job: SyllabusAnalysis & { _id: Types.ObjectId }) {
        return { id: job._id.toString(), extractionId: job.extraction.toString(), materialVersion: job.materialVersion,
            state: job.state, suggestionCount: job.suggestions?.length ?? 0, attempts: job.attempts, errorCode: job.errorCode, canRetry: job.state === 'failed' && job.attempts < 3 };
    }

    async start(owner: Types.ObjectId, courseId: string, materialId: string) {
        const material = id(materialId);
        return this.folders.withCourse(owner, courseId, async (scope, session) => {
            const identity = await this.identity(scope, material, session);
            const { analyzerVersion, ...snapshotScope } = identity;
            const snapshot = await this.extractions.findById(identity.extraction).select('mediaType').session(session);
            if (snapshot?.mediaType === 'application/pdf' &&
                !await this.chunks.exists({ ...snapshotScope, 'spans.0': { $exists: true } }).session(session)) {
                throw new ConflictException({
                    code: 'pdf_layout_missing',
                    message: 'This PDF was extracted without page layout. Upload a fresh copy, wait for Text ready, then analyze the new copy. Keep this copy if it has saved decisions.',
                });
            }
            const existing = await this.jobs.findOne(identity).session(session);
            if (existing) return this.response(existing);
            const [job] = await this.jobs.create([{ ...identity, referenceDate: new Date().toISOString().slice(0, 10) }], { session });
            return this.response(job);
        });
    }

    async status(owner: Types.ObjectId, courseId: string, materialId: string) {
        const course = id(courseId), material = id(materialId);
        return this.jobs.db.transaction(async session => {
            const identity = await this.identity({ owner, course }, material, session);
            const job = await this.jobs.findOne(identity).session(session);
            if (!job) throw new NotFoundException('Analysis not started');
            return this.response(job);
        }, { readConcern: { level: 'snapshot' } });
    }

    async results(owner: Types.ObjectId, courseId: string, materialId: string, extractionId?: string) {
        const course = id(courseId), material = id(materialId);
        const expected = extractionId === undefined ? undefined : id(extractionId);
        return this.jobs.db.transaction(async session => {
            const identity = await this.identity({ owner, course }, material, session);
            if (expected && !identity.extraction.equals(expected)) throw new ConflictException('Extraction changed; refresh analysis status');
            const job = await this.jobs.findOne(identity).session(session).lean();
            if (!job) throw new NotFoundException('Analysis not started');
            if (job.state !== 'ready' || !Array.isArray(job.suggestions)) throw new ConflictException('Analysis results are not ready');

            const refs = job.suggestions.flatMap(row => [...row.sources, ...row.contextSources]);
            const chunkIds = [...new Set(refs.map(ref => ref.chunk.toString()))];
            const { analyzerVersion, ...snapshotScope } = identity;
            const chunks = chunkIds.length ? await this.chunks.find({ ...snapshotScope, _id: { $in: chunkIds } })
                .select('text page lineStart').session(session).lean() : [];
            const byId = new Map(chunks.map(chunk => [chunk._id.toString(), chunk]));
            const source = (ref: typeof refs[number]) => {
                const chunk = byId.get(ref.chunk.toString());
                if (!chunk || !Number.isInteger(ref.start) || !Number.isInteger(ref.end) || ref.start < 0 ||
                    ref.end <= ref.start || ref.end > chunk.text.length || chunk.text.slice(ref.start, ref.end) !== ref.quote) {
                    throw new ConflictException('Analysis source text is unavailable');
                }
                const breaks = (text: string) => (text.match(/\r\n|\r|\n/g) ?? []).length;
                const lineStart = chunk.lineStart == null ? null : chunk.lineStart + breaks(chunk.text.slice(0, ref.start));
                const lineEnd = lineStart == null ? null : lineStart + breaks(ref.quote.replace(/(?:\r\n|\r|\n)$/, ''));
                return { chunkId: ref.chunk.toString(), start: ref.start, end: ref.end, quote: ref.quote, page: chunk.page, lineStart, lineEnd };
            };
            return { ...this.response(job), analyzerVersion, suggestions: job.suggestions.map((row, index) => ({
                index, kind: row.kind, title: row.title, originalDateText: row.originalDateText,
                date: row.date, time: row.time, timezone: row.timezone, dateRange: row.dateRange,
                dateBasis: row.dateBasis, flags: row.flags, status: job.decisions?.find(item => item.index === index)?.status ?? 'pending',
                confirmedRange: job.decisions?.find(item => item.index === index)?.dateRange ?? null,
                confirmedDate: job.decisions?.find(item => item.index === index)?.date ?? null,
                sources: row.sources.map(source), contextSources: row.contextSources.map(source),
            })) };
        }, { readConcern: { level: 'snapshot' } });
    }

    async review(owner: Types.ObjectId, course: string, materialId: string, input: unknown) {
        const body = input as { jobId?: string; index?: number; status?: string; date?: string; period?: boolean } | null;
        if (!body || !Number.isInteger(body.index) || body.index! < 0 ||
            (body.status !== 'confirmed' && body.status !== 'dismissed')) throw new BadRequestException('Invalid decision');
        const jobId = id(body.jobId!);
        if (body.period !== undefined && body.period !== true) throw new BadRequestException('Invalid period choice');
        if (body.period && (body.status !== 'confirmed' || body.date != null)) throw new BadRequestException('Choose a period or an exact date');
        const date = body.status === 'confirmed' ? body.date : null;
        if (body.status === 'confirmed' && !body.period) {
            if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000')) throw new BadRequestException('Choose a valid date');
            const parsed = new Date(date + 'T00:00:00Z');
            if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== date) throw new BadRequestException('Choose a valid date');
        }
        return this.folders.withCourse(owner, course, async (scope, session) => {
            const identity = await this.identity(scope, id(materialId), session);
            const job = await this.jobs.findOne({ ...identity, _id: jobId, state: 'ready' }).session(session);
            if (!job?.suggestions?.[body.index!]) throw new ConflictException('Analysis changed; reload suggestions');
            const suggestion = job.suggestions[body.index!];
            const dateRange = body.period ? suggestion.dateRange : null;
            if (body.period && (suggestion.kind !== 'exam' || !dateRange || dateRange.start > dateRange.end ||
                [dateRange.start, dateRange.end].some(day => {
                    const parsed = new Date(day + 'T00:00:00Z');
                    return !Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== day || day.startsWith('0000');
                }))) throw new BadRequestException('No valid exam period to confirm');
            const decision = { index: body.index!, status: body.status as 'confirmed' | 'dismissed', date: date ?? null, dateRange };
            job.decisions = [...(job.decisions ?? []).filter(item => item.index !== body.index), decision];
            await job.save({ session });
            return decision;
        });
    }

    async calendar(owner: Types.ObjectId, materialId?: string) {
        return this.jobs.aggregate([
            { $match: { owner, state: 'ready', ...(materialId === undefined ? {} : { material: id(materialId) }) } },
            { $lookup: { from: this.extractions.collection.name, localField: 'extraction', foreignField: '_id', as: 'snapshot' } },
            { $unwind: '$snapshot' },
            { $lookup: { from: this.materials.collection.name, localField: 'material', foreignField: '_id', as: 'document' } },
            { $unwind: '$document' },
            { $match: { 'document.state': 'ready', 'document.processingStatus': 'ready', $expr: { $and: [
                { $eq: ['$document.owner', '$owner'] }, { $eq: ['$document.course', '$course'] },
                { $eq: ['$document.version', '$materialVersion'] }, { $eq: ['$snapshot.owner', '$owner'] },
                { $eq: ['$snapshot.course', '$course'] }, { $eq: ['$snapshot.material', '$material'] },
                { $eq: ['$snapshot.materialVersion', '$materialVersion'] },
            ] } } },
            { $project: { _id: 0, jobId: '$_id', courseId: '$course', materialId: '$material',
                extractionId: '$extraction', title: '$document.title',
                entries: { $map: { input: { $range: [0, { $size: { $ifNull: ['$suggestions', []] } }] }, as: 'i',
                    in: { $let: { vars: {
                        row: { $arrayElemAt: ['$suggestions', '$$i'] },
                        decision: { $arrayElemAt: [{ $filter: { input: { $ifNull: ['$decisions', []] }, as: 'd', cond: { $eq: ['$$d.index', '$$i'] } } }, 0] },
                    }, in: { index: '$$i', title: '$$row.title', kind: '$$row.kind',
                        status: { $ifNull: ['$$decision.status', 'pending'] },
                        date: { $cond: [{ $eq: ['$$decision.status', 'confirmed'] }, '$$decision.date', '$$row.date'] },
                        dateRange: { $cond: [{ $eq: ['$$decision.status', 'confirmed'] }, '$$decision.dateRange', '$$row.dateRange'] },
                    } } } } },
            } },
        ]);
    }

    async upcoming(owner: Types.ObjectId) {
        return this.jobs.aggregate([
            { $match: { owner, state: 'ready' } },
            { $unwind: '$decisions' },
            { $match: { 'decisions.status': 'confirmed' } },
            { $lookup: { from: this.extractions.collection.name, localField: 'extraction', foreignField: '_id', as: 'snapshot' } },
            { $unwind: '$snapshot' },
            { $lookup: { from: this.materials.collection.name, localField: 'material', foreignField: '_id', as: 'document' } },
            { $unwind: '$document' },
            { $match: { 'document.state': 'ready', 'document.processingStatus': 'ready', $expr: { $and: [
                { $eq: ['$document.owner', '$owner'] }, { $eq: ['$document.course', '$course'] },
                { $eq: ['$document.version', '$materialVersion'] }, { $eq: ['$snapshot.owner', '$owner'] },
                { $eq: ['$snapshot.course', '$course'] }, { $eq: ['$snapshot.material', '$material'] },
                { $eq: ['$snapshot.materialVersion', '$materialVersion'] },
            ] } } },
            { $set: { sortDate: { $ifNull: ['$decisions.date', '$decisions.dateRange.start'] } } },
            { $sort: { sortDate: 1, _id: 1, 'decisions.index': 1 } },
            { $project: { _id: 0, jobId: '$_id', index: '$decisions.index', date: '$decisions.date', dateRange: '$decisions.dateRange',
                title: { $arrayElemAt: ['$suggestions.title', '$decisions.index'] },
                kind: { $arrayElemAt: ['$suggestions.kind', '$decisions.index'] } } },
        ]);
    }

    async retry(owner: Types.ObjectId, courseId: string, materialId: string) {
        const material = id(materialId);
        return this.folders.withCourse(owner, courseId, async (scope, session) => {
            const identity = await this.identity(scope, material, session);
            const existing = await this.jobs.findOne(identity).session(session);
            if (!existing) throw new NotFoundException('Analysis not started');
            const job = await this.jobs.findOneAndUpdate({ ...identity, state: 'failed', attempts: { $lt: 3 } },
                { $set: { state: 'queued', runAfter: new Date(), leaseUntil: null, leaseToken: null, errorCode: null }, $unset: { suggestions: 1 } },
                { session, returnDocument: 'after' });
            if (!job) throw new ConflictException('Analysis cannot be retried');
            return this.response(job);
        });
    }
}
