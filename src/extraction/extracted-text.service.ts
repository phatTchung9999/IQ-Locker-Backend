import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { ExtractedText, ExtractedTextChunk } from '../model/extracted-text.schema.js';
import { Material } from '../model/material.schema.js';
import type { MaterialDocument } from '../model/material.schema.js';
import { ExtractionJob } from '../model/extraction-job.schema.js';
import type { ExtractionJobDocument } from '../model/extraction-job.schema.js';
import { ExtractionFailure } from './extraction.types.js';
import type { ExtractionResult, ExtractionResultWriter } from './extraction.types.js';
import { sourceChunks } from './source-chunks.js';

function id(value: string) {
    if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw new BadRequestException('Invalid document or extraction ID');
    return new Types.ObjectId(value);
}
@Injectable()
export class ExtractedTextService implements ExtractionResultWriter {
    constructor(@InjectModel(ExtractedText.name) private readonly results: Model<ExtractedText>,
        @InjectModel(ExtractedTextChunk.name) private readonly chunks: Model<ExtractedTextChunk>,
        @InjectModel(Material.name) private readonly materials: Model<Material>,
        @InjectModel(ExtractionJob.name) private readonly jobs: Model<ExtractionJob>) {}
    async save(result: ExtractionResult, material: MaterialDocument, job: ExtractionJobDocument, session: ClientSession) {
        // The caller owns the course transaction. Also guard this write boundary
        // so no alternative caller can publish a stale material or lease.
        if (!session.inTransaction()) throw new Error('Extracted text requires a transaction');
        const scope = { owner: material.owner, course: material.course, material: material._id, materialVersion: material.version };
        if (job.owner.toString() !== material.owner.toString() || job.course.toString() !== material.course.toString() ||
            job.material.toString() !== material._id.toString() || job.materialVersion !== material.version || job.extractorVersion !== result.extractorVersion) throw new ExtractionFailure('parser_failed');
        if (!await this.materials.exists({ _id: material._id, owner: material.owner, course: material.course, version: material.version, state: 'ready' }).session(session)) throw new ExtractionFailure('parser_failed');
        if (!job.leaseToken || !await this.jobs.exists({ _id: job._id, ...scope, state: 'processing', leaseToken: job.leaseToken, leaseUntil: { $gt: new Date() } }).session(session)) throw new ExtractionFailure('timeout');
        const pieces = sourceChunks(result, material.mediaType);
        // Replace inside the transaction: retries never expose partial/duplicate text.
        await this.chunks.deleteMany(scope, { session });
        await this.results.deleteMany(scope, { session });
        const extraction = new Types.ObjectId();
        await this.results.create([{ _id: extraction, ...scope, extractorVersion: result.extractorVersion,
            chunkCount: pieces.length, textChars: result.textChars, pageCount: result.pages.length, mediaType: material.mediaType }], { session });
        await this.chunks.insertMany(pieces.map(piece => ({ ...scope, extraction, extractorVersion: result.extractorVersion, ...piece })), { session, ordered: true });
    }
    async remove(owner: Types.ObjectId, course: Types.ObjectId, material: Types.ObjectId, session: ClientSession) {
        if (!session.inTransaction()) throw new Error('Extracted text cleanup requires a transaction');
        await this.chunks.deleteMany({ owner, course, material }, { session });
        await this.results.deleteMany({ owner, course, material }, { session });
    }
    async read(owner: Types.ObjectId, courseId: string, materialId: string, offsetValue?: string, extractionValue?: string) {
        const course = id(courseId), material = id(materialId);
        if (offsetValue !== undefined && (typeof offsetValue !== 'string' || !/^(0|[1-9]\d{0,3})$/.test(offsetValue))) throw new BadRequestException('Invalid text offset');
        const offset = Number(offsetValue ?? 0);
        if (offset > 2000) throw new BadRequestException('Invalid text offset');
        const requestedExtraction = extractionValue === undefined ? undefined : id(extractionValue);
        if (offset > 0 && !requestedExtraction) throw new BadRequestException('Include extractionId when reading subsequent chunks');
        return this.materials.db.transaction(async session => {
            const original = await this.materials.findOne({ _id: material, owner, course }).session(session);
            if (!original) throw new NotFoundException('Document not found');
            if (original.state !== 'ready' || original.processingStatus !== 'ready') throw new ConflictException('Extracted text is not ready');
            const scope = { owner, course, material, materialVersion: original.version };
            const snapshot = await this.results.findOne(scope).session(session);
            if (!snapshot) throw new ConflictException('Extracted text is not ready');
            if (requestedExtraction && !snapshot._id.equals(requestedExtraction)) throw new ConflictException('Extracted text changed. Start from the first chunk again.');
            if (offset > snapshot.chunkCount) throw new BadRequestException('Text offset exceeds available chunks');
            const pieces = await this.chunks.find({ ...scope, extraction: snapshot._id }).sort({ index: 1 }).skip(offset).limit(20).session(session);
            if (pieces.length !== Math.min(20, snapshot.chunkCount - offset)) throw new ConflictException('Extracted text is incomplete');
            return { extractionId: snapshot._id.toString(), materialId: material.toString(), materialVersion: original.version,
                extractorVersion: snapshot.extractorVersion, mediaType: snapshot.mediaType,
                textChars: snapshot.textChars, pageCount: snapshot.pageCount, chunkCount: snapshot.chunkCount, extractedAt: snapshot.createdAt,
                offset, nextOffset: offset + pieces.length < snapshot.chunkCount ? offset + pieces.length : null,
                chunks: pieces.map(piece => ({ index: piece.index, text: piece.text, page: piece.page,
                    charStart: piece.charStart, charEnd: piece.charEnd, lineStart: piece.lineStart, lineEnd: piece.lineEnd })) };
        }, { readConcern: { level: 'snapshot' } });
    }
}
