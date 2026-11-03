import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Notification } from '../model/notification.schema.js';
import { Material, StorageUsage } from '../model/material.schema.js';
import { User } from '../model/user.schema.js';
import { materialLimits } from '../dto/material.dto.js';

type Notice = { key: string; kind: string; message: string; path: string };
function id(value: string) {
    if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw new BadRequestException('Invalid notification ID');
    return new Types.ObjectId(value);
}
@Injectable()
export class NotificationService {
    constructor(@InjectModel(Notification.name) private readonly notifications: Model<Notification>,
        @InjectModel(User.name) private readonly users: Model<User>,
        @InjectModel(Material.name) private readonly materials: Model<Material>,
        @InjectModel(StorageUsage.name) private readonly usage: Model<StorageUsage>) {}

    // Reconcile current conditions when the signed-in client polls. No success spam,
    // no parser exception text, and no duplicate reminders on each refresh.
    private async reconcile(owner: Types.ObjectId) {
        const [user, usage, failed] = await Promise.all([
            this.users.findById(owner).select('school major phone').lean(),
            this.usage.findById(owner).lean(),
            this.materials.find({ owner, state: 'ready', processingStatus: 'failed' })
                .select('_id course folder version title processingErrorCode').lean(),
        ]);
        const notices: Notice[] = [];
        if (user && [user.school, user.major, user.phone].some(value => !value?.trim())) {
            notices.push({ key: 'profile', kind: 'profile', message: 'Finish your profile to personalize your workspace.', path: '/profile' });
        }
        if ((usage?.bytes ?? 0) >= materialLimits().limitBytes * 0.8) {
            notices.push({ key: 'storage', kind: 'storage', message: 'Storage is nearly full. Review your documents.', path: '/courses' });
        }
        for (const material of failed) {
            const message = material.processingErrorCode === 'no_readable_text'
                ? `No readable text found in “${material.title}”. OCR is not available yet.`
                : `Text extraction needs attention: “${material.title}”.`;
            notices.push({ key: `extraction:${material._id}:${material.version}`, kind: 'extraction', message,
                path: `/courses/${material.course}${material.folder ? `/folders/${material.folder}` : ''}#material-${material._id}` });
        }
        if (notices.length) {
            try {
                await this.notifications.bulkWrite(notices.map(notice => ({ updateOne: {
                    filter: { owner, key: notice.key },
                    update: { $set: { kind: notice.kind, message: notice.message, path: notice.path, active: true },
                        $setOnInsert: { readAt: null } },
                    upsert: true,
                } })), { ordered: false });
            } catch (error: any) {
                // Simultaneous first polls may race on the unique owner/key index.
                if (error.code !== 11000 || error.writeConcernErrors?.length ||
                    error.writeErrors?.some((entry: any) => entry.code !== 11000)) throw error;
            }
        }
        // Resolved reminders disappear; their read state is retained if the same
        // condition returns. A new material version has its own notification key.
        await this.notifications.updateMany({ owner, active: true, key: { $nin: notices.map(notice => notice.key) } }, { $set: { active: false } });
    }
    async list(owner: Types.ObjectId, before?: string) {
        const cursor = before === undefined ? null : id(before);
        await this.reconcile(owner);
        const filter = { owner, active: true };
        const [rows, unreadCount] = await Promise.all([
            this.notifications.find({ ...filter, ...(cursor ? { _id: { $lt: cursor } } : {}) }).sort({ _id: -1 }).limit(51).lean(),
            this.notifications.countDocuments({ ...filter, readAt: null }),
        ]);
        return { notifications: rows.slice(0, 50).map(row => ({ id: row._id.toString(), kind: row.kind,
            message: row.message, path: row.path, readAt: row.readAt, createdAt: row.createdAt })),
            unreadCount, nextCursor: rows.length > 50 ? rows[49]!._id.toString() : null };
    }
    async markRead(owner: Types.ObjectId, notificationId: string) {
        const notification = await this.notifications.findOneAndUpdate({ _id: id(notificationId), owner, active: true },
            { $set: { readAt: new Date() } }, { returnDocument: 'after' });
        if (!notification) throw new NotFoundException('Notification not found');
        return { id: notification._id.toString(), readAt: notification.readAt };
    }
    async markAllRead(owner: Types.ObjectId) {
        await this.notifications.updateMany({ owner, active: true, readAt: null }, { $set: { readAt: new Date() } });
        return { success: true };
    }
}
