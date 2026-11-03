import 'reflect-metadata';
import 'dotenv/config';
import { Mongoose, Types } from 'mongoose';
import { Module } from '@nestjs/common';
import type { INestApplication, MiddlewareConsumer } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { NotificationSchema } from '../src/model/notification.schema.js';
import { MaterialSchema, StorageUsageSchema } from '../src/model/material.schema.js';
import { UserSchema } from '../src/model/user.schema.js';
import { NotificationService } from '../src/service/notification.service.js';
import { NotificationController } from '../src/controller/notification.controller.js';
import { UserService } from '../src/service/user.service.js';
import { isAuthenticated } from '../src/app.middleware.js';

const database = new Mongoose();
const prefix = `iqlocker_notifications_test_${new Types.ObjectId()}`;
const Notices = database.model('NoticeTest', NotificationSchema.clone(), `${prefix}_notices`);
const Users = database.model('NoticeUserTest', UserSchema.clone(), `${prefix}_users`);
const Materials = database.model('NoticeMaterialTest', MaterialSchema.clone(), `${prefix}_materials`);
const Usage = database.model('NoticeUsageTest', StorageUsageSchema.clone(), `${prefix}_usage`);
const service = new NotificationService(Notices as any, Users as any, Materials as any, Usage as any);
const jwt = new JwtService({ secret: 'notifications-test-only' });
@Module({ controllers: [NotificationController], providers: [
    { provide: NotificationService, useValue: service }, { provide: JwtService, useValue: jwt },
    { provide: UserService, useValue: { getOne: (email: string) => Users.findOne({ email }) } },
] })
class NotificationTestModule {
    configure(consumer: MiddlewareConsumer) { consumer.apply(isAuthenticated).forRoutes(NotificationController); }
}
describe.skipIf(process.env.IQLOCKER_MONGO_TEST !== '1')('Private notifications (isolated MongoDB + HTTP)', () => {
    let app: INestApplication;
    let owner: Types.ObjectId, other: Types.ObjectId;
    const auth = (email = 'a@example.test') => `Bearer ${jwt.sign({ email })}`;
    beforeAll(async () => {
        await database.connect(process.env.MONGO_URI ?? 'mongodb://localhost:27017/Stream', { serverSelectionTimeoutMS: 8000 });
        await Promise.all([Notices.init(), Users.init(), Materials.init(), Usage.init()]);
        app = (await Test.createTestingModule({ imports: [NotificationTestModule] }).compile()).createNestApplication();
        await app.listen(0, '127.0.0.1');
    }, 20000);
    beforeEach(async () => {
        await Promise.all([Notices.deleteMany({}), Users.deleteMany({}), Materials.deleteMany({}), Usage.deleteMany({})]);
        owner = (await Users.create({ fullname: 'Test A', email: 'a@example.test', password: 'test-only' }))._id;
        other = (await Users.create({ fullname: 'Test B', email: 'b@example.test', password: 'test-only', school: 'School', major: 'Math', phone: '123' }))._id;
    });
    afterAll(async () => {
        await app?.close();
        try {
            if (database.connection.readyState === 1) for (const model of [Notices, Users, Materials, Usage]) {
                if (!model.collection.name.startsWith(prefix)) throw new Error('Unsafe cleanup');
                await model.collection.drop();
            }
        } finally { await database.disconnect(); }
    });
    async function failedMaterial() {
        return Materials.create({ owner, course: new Types.ObjectId(), folder: new Types.ObjectId(), title: 'Notes',
            originalFilename: 'notes.txt', mediaType: 'text/plain', sizeBytes: 5, storageKey: `test/${new Types.ObjectId()}`,
            state: 'ready', processingStatus: 'failed', processingErrorCode: 'no_readable_text' });
    }
    it('persists one reminder through concurrent polls and keeps read state', async () => {
        await Promise.all([service.list(owner), service.list(owner)]);
        const first = await service.list(owner);
        expect(first.unreadCount).toBe(1);
        expect(await Notices.countDocuments({ owner })).toBe(1);
        await service.markRead(owner, first.notifications[0]!.id);
        expect((await service.list(owner)).unreadCount).toBe(0);
    });
    it('resolves profile/storage notices and does not spam read reminders if conditions return', async () => {
        await Usage.create({ _id: owner, bytes: 400_000_000 });
        expect((await service.list(owner)).unreadCount).toBe(2);
        await service.markAllRead(owner);
        await Users.updateOne({ _id: owner }, { $set: { school: 'S', major: 'M', phone: '1' } });
        await Usage.updateOne({ _id: owner }, { $set: { bytes: 399_999_999 } });
        expect((await service.list(owner)).notifications).toHaveLength(0);
        await Usage.updateOne({ _id: owner }, { $set: { bytes: 400_000_000 } });
        const returned = await service.list(owner);
        expect(returned.notifications).toHaveLength(1);
        expect(returned.unreadCount).toBe(0);
    });
    it('links failed documents to their folder, exposes no storage keys and removes resolved/deleted reminders', async () => {
        const material = await failedMaterial();
        const data = await service.list(owner);
        const notice = data.notifications.find(item => item.kind === 'extraction')!;
        expect(notice.path).toBe(`/courses/${material.course}/folders/${material.folder}#material-${material._id}`);
        expect(notice.message).toContain('OCR');
        expect(JSON.stringify(data)).not.toContain(material.storageKey);
        expect(JSON.stringify(data)).not.toContain('leaseToken');
        await Materials.updateOne({ _id: material._id }, { $set: { processingStatus: 'queued' } });
        expect((await service.list(owner)).notifications.some(item => item.kind === 'extraction')).toBe(false);
        await Materials.updateOne({ _id: material._id }, { $set: { processingStatus: 'failed' } });
        await service.list(owner);
        await Materials.deleteOne({ _id: material._id });
        expect((await service.list(owner)).notifications.some(item => item.kind === 'extraction')).toBe(false);
    });
    it('keeps foreign reads private and rejects malformed identifiers', async () => {
        const notice = (await service.list(owner)).notifications[0]!;
        expect((await service.list(other)).notifications).toEqual([]);
        await expect(service.markRead(other, notice.id)).rejects.toMatchObject({ status: 404 });
        await expect(service.markRead(owner, 'invalid')).rejects.toMatchObject({ status: 400 });
        await expect(service.list(owner, 'invalid')).rejects.toMatchObject({ status: 400 });
        await service.markAllRead(other);
        expect((await service.list(owner)).unreadCount).toBe(1);
    });
    it('paginates more than fifty active reminders without losing unread counts', async () => {
        const fields = Array.from({ length: 55 }, () => ({ owner, course: new Types.ObjectId(), title: 'Test', originalFilename: 'test.txt',
            mediaType: 'text/plain', sizeBytes: 1, storageKey: `test/${new Types.ObjectId()}`, state: 'ready', processingStatus: 'failed' }));
        await Materials.insertMany(fields);
        const first = await service.list(owner);
        expect(first.notifications).toHaveLength(50); expect(first.unreadCount).toBe(56);
        const second = await service.list(owner, first.nextCursor!);
        expect(second.notifications).toHaveLength(6); expect(second.nextCursor).toBeNull();
        expect(new Set([...first.notifications, ...second.notifications].map(item => item.id)).size).toBe(56);
    });
    it('protects HTTP routes and derives owner from the token, including read-all', async () => {
        const server = app.getHttpServer();
        await request(server).get('/api/v1/notifications').expect(401);
        await request(server).patch('/api/v1/notifications/read-all').expect(401);
        const response = await request(server).get('/api/v1/notifications').set('Authorization', auth()).expect(200);
        expect(response.headers['cache-control']).toBe('private, no-store');
        const id = response.body.notifications[0].id;
        await request(server).patch(`/api/v1/notifications/${id}/read`).set('Authorization', auth('b@example.test')).expect(404);
        await request(server).patch('/api/v1/notifications/read-all').set('Authorization', auth('b@example.test')).send({ owner }).expect(200);
        expect((await service.list(owner)).unreadCount).toBe(1);
        await request(server).patch(`/api/v1/notifications/${id}/read`).set('Authorization', auth()).expect(200);
        expect((await service.list(owner)).unreadCount).toBe(0);
    });
});
