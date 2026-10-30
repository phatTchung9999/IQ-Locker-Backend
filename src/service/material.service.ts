import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { Material, StorageUsage } from '../model/material.schema.js';
import type { MaterialDocument } from '../model/material.schema.js';
import { FolderService } from './folder.service.js';
import { BlobStorageService } from '../storage/blob-storage.service.js';
import { materialLimits, materialTitle, validateMaterial } from '../dto/material.dto.js';

function objectId(value: string, label: string) {
    if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw new BadRequestException(`Invalid ${label} ID`);
    return new Types.ObjectId(value);
}
function safe(material: MaterialDocument) {
    return { id: material._id.toString(), title: material.title, originalFilename: material.originalFilename,
        mediaType: material.mediaType, sizeBytes: material.sizeBytes, folder: material.folder?.toString() ?? null,
        materialType: material.materialType, version: material.version, processingStatus: material.processingStatus,
        state: material.state, createdAt: material.createdAt, updatedAt: material.updatedAt };
}
@Injectable()
export class MaterialService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(MaterialService.name);
    private timer?: ReturnType<typeof setInterval>;
    private sweeping = false;
    constructor(@InjectModel(Material.name) private readonly materials: Model<Material>,
        @InjectModel(StorageUsage.name) private readonly usage: Model<StorageUsage>,
        private readonly folders: FolderService, private readonly storage: BlobStorageService) {}
    onModuleInit() {
        materialLimits(); // Fail clearly on invalid quota configuration.
        this.timer = setInterval(() => { void this.recover(); }, 60000);
        this.timer.unref();
        void this.recover();
    }
    onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
    private scope(owner: Types.ObjectId, course: string) { return { owner, course: objectId(course, 'course') }; }
    private async owned(owner: Types.ObjectId, course: string, id: string) {
        const material = await this.materials.findOne({ ...this.scope(owner, course), _id: objectId(id, 'material') });
        if (!material) throw new NotFoundException('Document not found');
        return material;
    }
    private async seedUsage(owner: Types.ObjectId) {
        try { await this.usage.updateOne({ _id: owner }, { $setOnInsert: { bytes: 0, revision: 0 } }, { upsert: true }); }
        catch (error: any) { if (error.code !== 11000) throw error; }
    }
    async list(owner: Types.ObjectId, courseId: string, folderId?: string) {
        await this.folders.location(owner, courseId, folderId ?? null);
        const materials = await this.materials.find({ ...this.scope(owner, courseId), folder: folderId ? objectId(folderId, 'folder') : null }).sort({ createdAt: -1, _id: -1 });
        const usage = await this.usage.findById(owner);
        return { materials: materials.map(safe), usage: { usedBytes: usage?.bytes ?? 0, ...materialLimits() } };
    }
    async read(owner: Types.ObjectId, courseId: string, id: string) { return safe(await this.owned(owner, courseId, id)); }
    async upload(owner: Types.ObjectId, courseId: string, folderId: string | undefined, file: Express.Multer.File | undefined, title?: unknown, signal?: AbortSignal) {
        await this.folders.location(owner, courseId, folderId ?? null);
        const fields = await validateMaterial(file, title);
        await this.storage.ensureReady();
        if (signal?.aborted) throw new BadRequestException('Upload canceled');
        await this.seedUsage(owner);
        const id = new Types.ObjectId();
        const key = `materials/${randomUUID()}.${fields.mediaType === 'application/pdf' ? 'pdf' : 'txt'}`;
        await this.folders.withCourse(owner, courseId, async (scope, session) => {
            const materialType = await this.folders.destination(owner, scope.course, folderId ?? null, session);
            const usage = await this.usage.findOneAndUpdate({ _id: owner }, { $inc: { revision: 1 } }, { session, returnDocument: 'after' });
            if (!usage) throw new ServiceUnavailableException('Storage quota is unavailable');
            if (usage.bytes + fields.sizeBytes > materialLimits().limitBytes) throw new PayloadTooLargeException('Your document storage limit has been reached');
            await this.usage.updateOne({ _id: owner }, { $inc: { bytes: fields.sizeBytes } }, { session });
            // Durable reservation before I/O: a crash can never leave an unknown blob.
            await this.materials.create([{ _id: id, ...scope, ...fields, folder: folderId ? objectId(folderId, 'folder') : null,
                materialType, storageKey: key, state: 'uploading', retryAt: new Date(Date.now() + 15 * 60000) }], { session });
        });
        try {
            await this.storage.upload(key, file!.buffer, fields.mediaType, signal);
            if (signal?.aborted) throw new BadRequestException('Upload canceled');
            const material = await this.materials.findOneAndUpdate({ _id: id, owner, state: 'uploading' }, { $set: { state: 'ready', retryAt: null } }, { returnDocument: 'after' });
            if (!material) throw new ConflictException('This upload expired. Please refresh your documents.');
            return safe(material);
        } catch (error) {
            // Wait for an aborted/ambiguous Azure request to settle before cleanup.
            // If MongoDB is unavailable, the original reservation still expires.
            await this.materials.updateOne({ _id: id, owner, state: 'uploading' }, { $set: { state: 'cleanup_pending', retryAt: new Date(Date.now() + 3 * 60000) } }).catch(() => undefined);
            throw error;
        }
    }
    async rename(owner: Types.ObjectId, courseId: string, id: string, input: unknown) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('A title is required');
        const title = materialTitle((input as Record<string, unknown>).title);
        const material = await this.owned(owner, courseId, id);
        if (material.state !== 'ready') throw new ConflictException('Wait for upload or cleanup to finish');
        const updated = await this.materials.findOneAndUpdate({ _id: material._id, owner, state: 'ready' }, { $set: { title } }, { returnDocument: 'after' });
        if (!updated) throw new ConflictException('Document changed. Refresh and try again.');
        return safe(updated);
    }
    async content(owner: Types.ObjectId, courseId: string, id: string) {
        const material = await this.owned(owner, courseId, id);
        if (material.state !== 'ready') throw new ConflictException('This document is not ready');
        return { material, stream: await this.storage.download(material.storageKey) };
    }
    async delete(owner: Types.ObjectId, courseId: string, id: string) {
        const material = await this.owned(owner, courseId, id);
        if (material.state === 'uploading') throw new ConflictException('Upload is still pending. Refresh shortly.');
        if (material.state === 'cleanup_pending' && material.retryAt && material.retryAt.getTime() > Date.now()) {
            throw new ConflictException('Upload cleanup is scheduled. Please refresh in a few minutes.');
        }
        await this.materials.updateOne({ _id: material._id, owner, state: 'ready' }, { $set: { state: 'deleting', retryAt: new Date() } });
        if (!await this.cleanup(material._id)) throw new ConflictException('Cleanup is already running. Please refresh shortly.');
    }
    private async cleanup(id: Types.ObjectId) {
        const now = new Date();
        const token = randomUUID();
        const material = await this.materials.findOneAndUpdate({ _id: id, state: { $in: ['uploading', 'deleting', 'cleanup_pending'] },
            $or: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { $lte: now } }],
            retryAt: { $lte: now } }, { $set: { cleanupLeaseUntil: new Date(Date.now() + 180000), cleanupToken: token, state: 'deleting' } }, { returnDocument: 'after' });
        if (!material) return false;
        try {
            await this.storage.remove(material.storageKey); // Idempotent, including an upload that never reached Azure.
            const removed = await this.folders.withCourse(material.owner, material.course.toString(), async (_, session) => {
                const current = await this.materials.findOne({ _id: id, cleanupToken: token, state: 'deleting' }).session(session);
                if (!current) return false;
                const usage = await this.usage.findOneAndUpdate({ _id: material.owner }, { $inc: { revision: 1, bytes: -material.sizeBytes } }, { session, returnDocument: 'after' });
                if (!usage || usage.bytes < 0) throw new Error('Storage accounting needs recovery');
                await this.materials.deleteOne({ _id: id, cleanupToken: token }, { session });
                return true;
            });
            return removed;
        } catch {
            await this.materials.updateOne({ _id: id, cleanupToken: token }, { $set: { retryAt: new Date(Date.now() + 60000), cleanupLeaseUntil: null, cleanupToken: null } }).catch(() => undefined);
            throw new ServiceUnavailableException('Document cleanup is pending. Please refresh and retry shortly. Your file remains inaccessible until cleanup finishes.');
        }
    }
    async recover() {
        if (this.sweeping) return;
        this.sweeping = true;
        try {
            const pending = await this.materials.find({ state: { $in: ['uploading', 'cleanup_pending', 'deleting'] }, retryAt: { $lte: new Date() } }).limit(10);
            for (const material of pending) { try { await this.cleanup(material._id); } catch { this.logger.warn('Private document cleanup will retry.'); } }
        } catch { this.logger.warn('Document recovery is unavailable; retrying next minute.'); }
        finally { this.sweeping = false; }
    }
}
