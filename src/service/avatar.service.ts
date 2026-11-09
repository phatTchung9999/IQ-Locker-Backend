import { ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { User } from '../model/user.schema.js';
import { Avatar } from '../model/avatar.schema.js';
import { BlobStorageService } from '../storage/blob-storage.service.js';
import { prepareAvatar } from '../dto/avatar.dto.js';

@Injectable()
export class AvatarService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(AvatarService.name);
    private timer?: ReturnType<typeof setInterval>;
    private sweeping = false;
    private readonly uploading = new Set<string>();
    constructor(@InjectModel(User.name) private readonly users: Model<User>,
        @InjectModel(Avatar.name) private readonly avatars: Model<Avatar>,
        private readonly storage: BlobStorageService) {}
    onModuleInit() {
        this.timer = setInterval(() => { void this.recover(); }, 60000);
        this.timer.unref(); void this.recover();
    }
    onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
    async upload(owner: Types.ObjectId, file?: Express.Multer.File, signal?: AbortSignal, rotation: unknown = 0) {
        if (this.uploading.has(owner.toString())) throw new ConflictException('An avatar upload is already in progress.');
        if (this.uploading.size >= 2) throw new ServiceUnavailableException('Image processing is busy. Please try again.');
        this.uploading.add(owner.toString());
        try {
            const bytes = await prepareAvatar(file, rotation);
            signal?.throwIfAborted();
            const user = await this.users.findById(owner).select('avatarKey').lean();
            if (!user) throw new NotFoundException('Account not found');
            const previous = user.avatarKey ?? null;
            await this.storage.ensureReady('avatars');
            const key = `avatars/${randomUUID()}.webp`;
            // Create the journal before blob I/O so crashes can be recovered.
            const asset = await this.avatars.create({ owner, key, sizeBytes: bytes.length, state: 'uploading', retryAt: new Date(Date.now() + 300000) });
            try {
                await this.storage.upload(key, bytes, 'image/webp', signal, 'avatars');
                signal?.throwIfAborted();
                await this.users.db.transaction(async session => {
                    const claimed = await this.avatars.updateOne({ _id: asset._id, owner, state: 'uploading', retryAt: { $gt: new Date() } },
                        { $set: { state: 'active' } }, { session });
                    if (!claimed.matchedCount) throw new ConflictException('Avatar upload expired. Please try again.');
                    const changed = await this.users.updateOne({ _id: owner, avatarKey: previous }, { $set: { avatarKey: key } }, { session, runValidators: true });
                    if (!changed.matchedCount) throw new ConflictException('Your avatar changed. Refresh and try again.');
                    if (previous) await this.avatars.updateOne({ owner, key: previous, state: 'active' },
                        { $set: { state: 'cleanup_pending', retryAt: new Date() } }, { session });
                });
            } catch (error) {
                // Never clean up an active asset after an uncertain commit result.
                await this.avatars.updateOne({ _id: asset._id, owner, state: 'uploading' },
                    { $set: { state: 'cleanup_pending', retryAt: new Date() } }).catch(() => {});
                await this.recover();
                throw error;
            }
            await this.recover();
            return { hasAvatar: true };
        } finally { this.uploading.delete(owner.toString()); }
    }
    async content(owner: Types.ObjectId, signal?: AbortSignal) {
        const user = await this.users.findById(owner).select('avatarKey').lean();
        if (!user?.avatarKey) throw new NotFoundException('Avatar not found');
        const asset = await this.avatars.findOne({ owner, key: user.avatarKey, state: 'active' }).lean();
        if (!asset) throw new NotFoundException('Avatar not found');
        const stream = await this.storage.download(asset.key, signal, 'avatars');
        return { stream, sizeBytes: asset.sizeBytes };
    }
    async remove(owner: Types.ObjectId) {
        await this.users.db.transaction(async session => {
            const user = await this.users.findById(owner).select('avatarKey').session(session);
            if (!user) throw new NotFoundException('Account not found');
            if (!user.avatarKey) return;
            const previous = user.avatarKey;
            const changed = await this.users.updateOne({ _id: owner, avatarKey: previous }, { $unset: { avatarKey: 1 } }, { session });
            if (!changed.matchedCount) throw new ConflictException('Your avatar changed. Please try again.');
            await this.avatars.updateOne({ owner, key: previous, state: 'active' },
                { $set: { state: 'cleanup_pending', retryAt: new Date() } }, { session });
        });
        await this.recover();
    }
    async recover() {
        if (this.sweeping) return;
        this.sweeping = true;
        try {
            // A timed-out upload cannot publish once its journal state changes.
            const expired = await this.avatars.find({ state: 'uploading', retryAt: { $lte: new Date() } }).limit(10).select('_id');
            for (const asset of expired) await this.avatars.updateOne({ _id: asset._id, state: 'uploading', retryAt: { $lte: new Date() } },
                { $set: { state: 'cleanup_pending', retryAt: new Date() } });
            for (let i = 0; i < 10; i++) {
                const token = randomUUID();
                const asset = await this.avatars.findOneAndUpdate({ state: 'cleanup_pending', retryAt: { $lte: new Date() },
                    $or: [{ cleanupLeaseUntil: null }, { cleanupLeaseUntil: { $lte: new Date() } }] },
                    { $set: { cleanupToken: token, cleanupLeaseUntil: new Date(Date.now() + 180000) } }, { returnDocument: 'after' });
                if (!asset) break;
                const claim = { _id: asset._id, state: 'cleanup_pending', cleanupToken: token };
                try {
                    if (await this.users.exists({ _id: asset.owner, avatarKey: asset.key })) {
                        await this.avatars.updateOne(claim, { $set: { state: 'active', cleanupToken: null, cleanupLeaseUntil: null } });
                        continue;
                    }
                    await this.storage.remove(asset.key, 'avatars');
                    await this.avatars.deleteOne(claim);
                } catch {
                    await this.avatars.updateOne(claim, { $set: { cleanupToken: null, cleanupLeaseUntil: null, retryAt: new Date(Date.now() + 60000) } });
                }
            }
        } catch { this.logger.warn('Avatar cleanup will retry later.'); }
        finally { this.sweeping = false; }
    }
}
