import 'reflect-metadata';
import 'dotenv/config';
import { Readable } from 'node:stream';
import { Mongoose, Types } from 'mongoose';
import { Module } from '@nestjs/common';
import type { INestApplication, MiddlewareConsumer } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import sharp from 'sharp';
import { AvatarSchema } from '../src/model/avatar.schema.js';
import { UserSchema } from '../src/model/user.schema.js';
import { AvatarService } from '../src/service/avatar.service.js';
import { AvatarController } from '../src/controller/avatar.controller.js';
import { UserService } from '../src/service/user.service.js';
import { isAuthenticated } from '../src/app.middleware.js';

const database = new Mongoose(), prefix = `iqlocker_avatar_test_${new Types.ObjectId()}`;
const Users = database.model('AvatarTestUser', UserSchema.clone(), `${prefix}_users`);
const Avatars = database.model('AvatarTestAsset', AvatarSchema.clone(), `${prefix}_assets`);
const blobs = new Map<string, Buffer>();
let failDelete = false;
const storage = {
    ensureReady: vi.fn(async (kind: string) => { expect(kind).toBe('avatars'); }),
    upload: vi.fn(async (key: string, bytes: Buffer, type: string, signal: AbortSignal | undefined, kind: string) => {
        expect(kind).toBe('avatars'); expect(type).toBe('image/webp'); blobs.set(key, bytes);
    }),
    download: vi.fn(async (key: string, signal: AbortSignal | undefined, kind: string) => {
        expect(kind).toBe('avatars'); if (!blobs.has(key)) throw new Error('Not found'); return Readable.from(blobs.get(key)!);
    }),
    remove: vi.fn(async (key: string, kind: string) => { expect(kind).toBe('avatars'); if (failDelete) throw new Error('temporary failure'); blobs.delete(key); }),
};
const service = new AvatarService(Users as any, Avatars as any, storage as any);
const jwt = new JwtService({ secret: 'avatar-http-test-only' });
@Module({ controllers: [AvatarController], providers: [
    { provide: AvatarService, useValue: service }, { provide: JwtService, useValue: jwt },
    { provide: UserService, useValue: { getOne: (email: string) => Users.findOne({ email }) } },
] })
class AvatarTestModule {
    configure(consumer: MiddlewareConsumer) { consumer.apply(isAuthenticated).forRoutes(AvatarController); }
}
describe.skipIf(process.env.IQLOCKER_MONGO_TEST !== '1')('Private avatars (isolated MongoDB and fake Azure)', () => {
    let app: INestApplication, owner: Types.ObjectId, other: Types.ObjectId, image: Buffer;
    const token = (email = 'a@example.test') => `Bearer ${jwt.sign({ email })}`;
    const file = () => ({ buffer: image, mimetype: 'image/png', originalname: 'photo.png' } as Express.Multer.File);
    beforeAll(async () => {
        await database.connect(process.env.MONGO_URI ?? 'mongodb://localhost:27017/Stream', { serverSelectionTimeoutMS: 8000 });
        await Promise.all([Users.init(), Avatars.init()]);
        image = await sharp({ create: { width: 64, height: 40, channels: 3, background: '#56789a' } }).png().toBuffer();
        app = (await Test.createTestingModule({ imports: [AvatarTestModule] }).compile()).createNestApplication();
        await app.listen(0, '127.0.0.1');
        // Recovery itself is tested explicitly; avoid a background timer in fixtures.
        service.onModuleDestroy();
    }, 20000);
    beforeEach(async () => {
        vi.restoreAllMocks(); blobs.clear(); failDelete = false;
        await Promise.all([Users.deleteMany({}), Avatars.deleteMany({})]);
        owner = (await Users.create({ fullname: 'Test A', email: 'a@example.test', password: 'test-only' }))._id;
        other = (await Users.create({ fullname: 'Test B', email: 'b@example.test', password: 'test-only' }))._id;
    });
    afterAll(async () => {
        await app?.close();
        try { if (database.connection.readyState === 1) for (const model of [Users, Avatars]) {
            if (!model.collection.name.startsWith(prefix)) throw new Error('Unsafe cleanup'); await model.collection.drop();
        } } finally { await database.disconnect(); }
    });
    it('stores a normalized avatar for its owner, retrieves privately and replaces/removes safely', async () => {
        expect(await service.upload(owner, file())).toEqual({ hasAvatar: true });
        const first = (await Users.findById(owner))!.avatarKey!;
        expect(first).toMatch(/^avatars\/[a-f\d-]+\.webp$/);
        const { stream } = await service.content(owner);
        const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        expect(await sharp(Buffer.concat(chunks)).metadata()).toMatchObject({ format: 'webp', width: 512, height: 512 });
        await expect(service.content(other)).rejects.toMatchObject({ status: 404 });
        await service.upload(owner, file());
        const second = (await Users.findById(owner))!.avatarKey!;
        expect(second).not.toBe(first); expect(blobs.has(first)).toBe(false); expect(blobs.has(second)).toBe(true);
        expect(await Avatars.countDocuments()).toBe(1);
        await service.remove(owner); await service.remove(owner);
        expect(blobs.size).toBe(0); expect(await Avatars.countDocuments()).toBe(0);
        await expect(service.content(owner)).rejects.toMatchObject({ status: 404 });
    });
    it('retains the old avatar and cleans the new blob when database publication fails', async () => {
        await service.upload(owner, file()); const previous = (await Users.findById(owner))!.avatarKey!;
        vi.spyOn(Users, 'updateOne').mockRejectedValueOnce(new Error('database failure'));
        await expect(service.upload(owner, file())).rejects.toThrow('database failure');
        expect((await Users.findById(owner))!.avatarKey).toBe(previous);
        expect([...blobs.keys()]).toEqual([previous]); expect(await Avatars.countDocuments()).toBe(1);
    });
    it('retries failed cleanup later without undoing a successful replacement', async () => {
        await service.upload(owner, file()); const previous = (await Users.findById(owner))!.avatarKey!;
        failDelete = true; await service.upload(owner, file());
        const current = (await Users.findById(owner))!.avatarKey!;
        expect(current).not.toBe(previous); expect(blobs.size).toBe(2);
        expect(await Avatars.countDocuments({ state: 'cleanup_pending' })).toBe(1);
        failDelete = false; await Avatars.updateMany({ state: 'cleanup_pending' }, { $set: { retryAt: new Date(0) } });
        await service.recover(); expect([...blobs.keys()]).toEqual([current]);
    });
    it('recovers abandoned upload journals and never deletes a currently referenced blob', async () => {
        await service.upload(owner, file()); const current = (await Users.findById(owner))!.avatarKey!;
        await Avatars.updateOne({ key: current }, { $set: { state: 'cleanup_pending', retryAt: new Date(0) } });
        const abandoned = `avatars/${new Types.ObjectId()}.webp`; blobs.set(abandoned, Buffer.from('partial'));
        await Avatars.create({ owner, key: abandoned, sizeBytes: 7, state: 'uploading', retryAt: new Date(0) });
        await service.recover(); expect(blobs.has(abandoned)).toBe(false); expect(blobs.has(current)).toBe(true);
        expect((await Avatars.findOne({ key: current }))!.state).toBe('active');
    });
    it('permits only one concurrent publication across separate service instances', async () => {
        let arrivals = 0, release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const racingStorage = { ...storage, upload: async (...args: Parameters<typeof storage.upload>) => {
            await storage.upload(...args); if (++arrivals === 2) release(); await gate;
        } };
        const a = new AvatarService(Users as any, Avatars as any, racingStorage as any);
        const b = new AvatarService(Users as any, Avatars as any, racingStorage as any);
        const results = await Promise.allSettled([a.upload(owner, file()), b.upload(owner, file())]);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
        expect(blobs.size).toBe(1); expect(await Avatars.countDocuments({ state: 'active' })).toBe(1);
        expect(blobs.has((await Users.findById(owner))!.avatarKey!)).toBe(true);
    });
    it('keeps a committed avatar after an uncertain transaction response', async () => {
        const transaction = Users.db.transaction.bind(Users.db);
        vi.spyOn(Users.db, 'transaction').mockImplementationOnce(async (...args: any[]) => {
            await (transaction as any)(...args); throw new Error('response lost after commit');
        });
        await expect(service.upload(owner, file())).rejects.toThrow('response lost after commit');
        const current = (await Users.findById(owner))!.avatarKey!;
        expect(blobs.has(current)).toBe(true); expect((await Avatars.findOne({ key: current }))!.state).toBe('active');
    });
    it('protects HTTP endpoints, enforces upload validation and returns no private keys', async () => {
        const server = app.getHttpServer(), path = '/api/v1/user/me/avatar';
        await request(server).get(path).expect(401);
        await request(server).post(path).attach('file', image, 'image.png').expect(401);
        await request(server).delete(path).expect(401);
        await request(server).post(path).set('Authorization', token()).attach('file', Buffer.from('fake'), 'image.png').expect(400);
        await request(server).post(path).set('Authorization', token()).field('rotation', '45').attach('file', image, 'image.png').expect(400);
        const upload = await request(server).post(path).set('Authorization', token()).field('rotation', '90').attach('file', image, 'image.png').expect(200);
        expect(upload.body).toEqual({ hasAvatar: true });
        const content = await request(server).get(path).set('Authorization', token()).expect(200);
        expect(content.headers['content-type']).toBe('image/webp'); expect(content.headers['cache-control']).toBe('private, no-store');
        expect(content.headers['x-content-type-options']).toBe('nosniff');
        await request(server).get(path).set('Authorization', token('b@example.test')).expect(404);
        await request(server).post(path).set('Authorization', token()).field('owner', other.toString()).attach('file', image, 'image.png').expect(400);
        await request(server).post(path).set('Authorization', token()).attach('file', image, 'one.png').attach('file', image, 'two.png').expect(400);
        await request(server).post(path).set('Authorization', token()).attach('file', Buffer.alloc(5_000_001), 'huge.png').expect(413);
        await request(server).delete(path).set('Authorization', token('b@example.test')).expect(204);
        await request(server).get(path).set('Authorization', token()).expect(200);
        await request(server).delete(path).set('Authorization', token()).expect(204);
        await request(server).get(path).set('Authorization', token()).expect(404);
    });
});
