import { SyllabusAnalysis } from '../src/model/syllabus-analysis.schema.js';
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import type { INestApplication, MiddlewareConsumer } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Types } from 'mongoose';
import request from 'supertest';
import { FolderController } from '../src/controller/folder.controller.js';
import { FolderService } from '../src/service/folder.service.js';
import { MaterialController } from '../src/controller/material.controller.js';
import { MaterialService } from '../src/service/material.service.js';
import { BlobStorageService } from '../src/storage/blob-storage.service.js';
import { Readable } from 'node:stream';
import { ExtractedTextService } from '../src/extraction/extracted-text.service.js';
import { ExtractionJob } from '../src/model/extraction-job.schema.js';
import { Material, StorageUsage } from '../src/model/material.schema.js';
import { Folder } from '../src/model/folder.schema.js';
import { CourseController } from '../src/controller/course.controller.js';
import { CourseService } from '../src/service/course.service.js';
import { Course } from '../src/model/course.schema.js';
import { UserService } from '../src/service/user.service.js';
import { isAuthenticated } from '../src/app.middleware.js';
import { courseModelFixture } from './fixtures/course-model.js';

const fixture = courseModelFixture();
const extractedText = new ExtractedTextService(fixture.ExtractionModel as any, fixture.ChunkModel as any, fixture.MaterialModel as any, fixture.JobModel as any);
const blobs = new Map<string, Buffer>();
const storage = { ensureReady: async () => {}, upload: async (key: string, buffer: Buffer) => { blobs.set(key, buffer); },
  remove: async (key: string) => { blobs.delete(key); }, download: async (key: string) => Readable.from(blobs.get(key)!) };
const jwt = new JwtService({ secret: 'course-http-test-only' });
const users = [
  { _id: new Types.ObjectId(), fullname: 'Test Student A', email: 'student-a@example.test' },
  { _id: new Types.ObjectId(), fullname: 'Test Student B', email: 'student-b@example.test' },
];
const token = (index: number) => `Bearer ${jwt.sign({ email: users[index].email })}`;
@Module({
  controllers: [CourseController, FolderController, MaterialController],
  providers: [{ provide: getModelToken(SyllabusAnalysis.name), useValue: fixture.AnalysisModel }, CourseService, FolderService, MaterialService, { provide: ExtractedTextService, useValue: extractedText }, { provide: getModelToken(ExtractionJob.name), useValue: fixture.JobModel }, { provide: BlobStorageService, useValue: storage }, { provide: getModelToken(StorageUsage.name), useValue: fixture.UsageModel }, { provide: getModelToken(Material.name), useValue: fixture.MaterialModel }, { provide: getModelToken(Folder.name), useValue: fixture.FolderModel }, { provide: getModelToken(Course.name), useValue: fixture.CourseModel },
    { provide: JwtService, useValue: jwt }, { provide: UserService, useValue: { getOne: async (email: string) => users.find((user) => user.email === email) ?? null } }],
})
class CourseTestModule {
  configure(consumer: MiddlewareConsumer) { consumer.apply(isAuthenticated).forRoutes(CourseController, FolderController, MaterialController); }
}
let app: INestApplication;
beforeAll(async () => {
  const module = await Test.createTestingModule({ imports: [CourseTestModule] }).compile();
  app = module.createNestApplication();
  await app.listen(0, '127.0.0.1');
});
afterAll(async () => { await app?.close(); });
beforeEach(() => { fixture.stored.clear(); fixture.folders.clear(); fixture.materials.clear(); fixture.usage.clear(); fixture.jobs.clear(); fixture.analyses.clear(); fixture.extractions.clear(); fixture.chunks.clear(); blobs.clear(); });

it.each(['get', 'post', 'patch', 'delete'] as const)('rejects missing and invalid credentials on %s', async (method) => {
  const url = method === 'patch' || method === 'delete' ? `/api/v1/courses/${new Types.ObjectId()}` : '/api/v1/courses';
  await request(app.getHttpServer())[method](url).send({ name: 'Biology' }).expect(401);
  await request(app.getHttpServer())[method](url).set('Authorization', 'Bearer invalid').send({ name: 'Biology' }).expect(401);
});

it('performs an authenticated course lifecycle with two-account isolation', async () => {
  const create = await request(app.getHttpServer()).post('/api/v1/courses').set('Authorization', token(0))
    .send({ name: ' Biology ', code: 'BIO101', semester: 'Fall 2026', owner: users[1]._id }).expect(201);
  expect(create.body).toMatchObject({ id: expect.any(String), name: 'Biology', code: 'BIO101' });
  expect(create.body).not.toHaveProperty('owner');
  const path = `/api/v1/courses/${create.body.id}`;
  const ownList = await request(app.getHttpServer()).get('/api/v1/courses').set('Authorization', token(0)).expect(200);
  expect(ownList.body).toHaveLength(1);
  const foreignList = await request(app.getHttpServer()).get('/api/v1/courses').set('Authorization', token(1)).expect(200);
  expect(foreignList.body).toEqual([]);
  await request(app.getHttpServer()).get(path).set('Authorization', token(1)).expect(404);
  await request(app.getHttpServer()).patch(path).set('Authorization', token(1)).send({ name: 'Changed' }).expect(404);
  await request(app.getHttpServer()).delete(path).set('Authorization', token(1)).expect(404);
  const updated = await request(app.getHttpServer()).patch(path).set('Authorization', token(0)).send({ name: 'Biology II', code: '' }).expect(200);
  expect(updated.body).toMatchObject({ id: create.body.id, name: 'Biology II', code: '', semester: 'Fall 2026' });
  await request(app.getHttpServer()).get(path).set('Authorization', token(0)).expect(200);
  const presetPath = `${path}/folders`;
  const presets = await request(app.getHttpServer()).get(presetPath).set('Authorization', token(0)).expect(200);
  expect(presets.body.folders.map((f: any) => f.name).sort()).toEqual(['Exams', 'Lectures', 'Quizzes', 'Syllabus']);
  expect(presets.body.folders.map((f: any) => f.name)).toEqual(['Syllabus', 'Lectures', 'Quizzes', 'Exams']);
  expect(presets.body.folders.every((f: any) => f.isStarter)).toBe(true);
  await request(app.getHttpServer()).delete(`${presetPath}/${presets.body.folders[0].id}`).set('Authorization', token(0)).expect(403);
  await request(app.getHttpServer()).patch(`${presetPath}/${presets.body.folders[0].id}`).set('Authorization', token(0)).send({ name: 'Renamed' }).expect(403);
  const deleted = await request(app.getHttpServer()).delete(path).set('Authorization', token(0)).expect(204);
  expect(deleted.text).toBe('');
  await request(app.getHttpServer()).get(path).set('Authorization', token(0)).expect(404);
});

it('validates body and ID through the HTTP API', async () => {
  await request(app.getHttpServer()).post('/api/v1/courses').set('Authorization', token(0)).send({ name: '  ' }).expect(400);
  await request(app.getHttpServer()).get('/api/v1/courses/invalid').set('Authorization', token(0)).expect(400);
  await request(app.getHttpServer()).patch(`/api/v1/courses/${new Types.ObjectId()}`).set('Authorization', token(0)).send({ owner: users[1]._id }).expect(400);
});

it('protects nested folder endpoints and handles a folder lifecycle', async () => {
  const created = await request(app.getHttpServer()).post('/api/v1/courses').set('Authorization', token(0)).send({ name: 'Biology' }).expect(201);
  const path = `/api/v1/courses/${created.body.id}/folders`;
  for (const method of ['get', 'post', 'patch', 'delete'] as const) {
    const target = method === 'patch' || method === 'delete' ? `${path}/${new Types.ObjectId()}` : path;
    await request(app.getHttpServer())[method](target).send({ name: 'Private' }).expect(401);
  }
  await request(app.getHttpServer()).post(`${path}/starters`).set('Authorization', token(0)).expect(404);
  const root = await request(app.getHttpServer()).post(path).set('Authorization', token(0)).send({ name: 'Notes', materialType: 'lecture', owner: users[1]._id }).expect(201);
  const child = await request(app.getHttpServer()).post(path).set('Authorization', token(0)).send({ name: 'Week 1', parent: root.body.id }).expect(201);
  const children = await request(app.getHttpServer()).get(path).query({ parent: root.body.id }).set('Authorization', token(0)).expect(200);
  expect(children.body.folders.map((f: any) => f.id)).toEqual([child.body.id]);
  expect(children.body.breadcrumbs.map((f: any) => f.name)).toEqual(['Notes']);
  await request(app.getHttpServer()).get(`${path}/${child.body.id}`).set('Authorization', token(1)).expect(404);
  await request(app.getHttpServer()).post(path).set('Authorization', token(0)).send({ name: ' notes ' }).expect(409);
  await request(app.getHttpServer()).patch(`${path}/${root.body.id}`).set('Authorization', token(0)).send({ name: 'Class Notes' }).expect(200);
  await request(app.getHttpServer()).delete(`${path}/${root.body.id}`).set('Authorization', token(0)).expect(409);
  await request(app.getHttpServer()).delete(`/api/v1/courses/${created.body.id}`).set('Authorization', token(0)).expect(409);
  await request(app.getHttpServer()).delete(`${path}/${child.body.id}`).set('Authorization', token(0)).expect(204);
  const list = await request(app.getHttpServer()).get(path).set('Authorization', token(0)).expect(200);
  expect(list.body.folders).toHaveLength(5);
});

it('protects all document routes and performs a private multipart round trip', async () => {
  const created = await request(app.getHttpServer()).post('/api/v1/courses').set('Authorization', token(0)).send({ name: 'Materials' }).expect(201);
  const root = `/api/v1/courses/${created.body.id}`;
  const path = `${root}/materials`;
  for (const method of ['get', 'post', 'patch', 'delete'] as const) {
    const target = method === 'patch' || method === 'delete' ? `${path}/${new Types.ObjectId()}` : path;
    await request(app.getHttpServer())[method](target).send({ title: 'Test' }).expect(401);
  }
  const original = '<script>alert(1)</script> notes';
  const uploaded = await request(app.getHttpServer()).post(path).set('Authorization', token(0)).attach('file', Buffer.from(original), 'notes.txt').expect(201);
  expect(uploaded.body).toMatchObject({ title: 'notes', state: 'ready', mediaType: 'text/plain' });
  expect(uploaded.body).not.toHaveProperty('storageKey'); expect(uploaded.body).not.toHaveProperty('owner');
  const detail = `${path}/${uploaded.body.id}`;
  const listed = await request(app.getHttpServer()).get(path).set('Authorization', token(0)).expect(200);
  expect(listed.body.materials).toHaveLength(1); expect(listed.body.usage.usedBytes).toBe(Buffer.byteLength(original));
  for (const method of ['get', 'patch', 'delete'] as const) await request(app.getHttpServer())[method](detail).set('Authorization', token(1)).send({ title: 'Stolen' }).expect(404);
  await request(app.getHttpServer()).get(`${detail}/content`).expect(401);
  await request(app.getHttpServer()).get(`${detail}/content`).set('Authorization', token(1)).expect(404);
  const content = await request(app.getHttpServer()).get(`${detail}/content`).set('Authorization', token(0)).expect(200);
  expect(content.text).toBe(original); expect(content.headers['x-content-type-options']).toBe('nosniff');
  expect(content.headers['cache-control']).toContain('no-store');
  const download = await request(app.getHttpServer()).get(`${detail}/content?download=1`).set('Authorization', token(0)).expect(200);
  expect(download.headers['content-disposition']).toContain('attachment');
  await request(app.getHttpServer()).patch(detail).set('Authorization', token(0)).send({ title: 'New title', storageKey: 'stolen' }).expect(200);
  await request(app.getHttpServer()).delete(root).set('Authorization', token(0)).expect(409);
  await request(app.getHttpServer()).delete(detail).set('Authorization', token(0)).expect(204);
  await request(app.getHttpServer()).delete(root).set('Authorization', token(0)).expect(204);
  expect(blobs.size).toBe(0);
});
it('rejects invalid multipart files and oversized uploads without storing files', async () => {
  const created = await request(app.getHttpServer()).post('/api/v1/courses').set('Authorization', token(0)).send({ name: 'Validation' }).expect(201);
  const path = `/api/v1/courses/${created.body.id}/materials`;
  await request(app.getHttpServer()).post(path).set('Authorization', token(0)).attach('file', Buffer.from('not PDF'), { filename: 'fake.pdf', contentType: 'application/pdf' }).expect(400);
  await request(app.getHttpServer()).post(path).set('Authorization', token(0)).attach('file', Buffer.alloc(20_000_001, 65), 'large.txt').expect(413);
  await request(app.getHttpServer()).post(path).set('Authorization', token(0)).attach('file', Buffer.from('a'), 'a.txt').attach('file', Buffer.from('b'), 'b.txt').expect(400);
  expect(blobs.size).toBe(0); expect(fixture.materials.size).toBe(0);
});

it('keeps extracted text private, bounded and unavailable before processing completes', async () => {
  const course = await request(app.getHttpServer()).post('/api/v1/courses').set('Authorization', token(0)).send({ name: 'Source API' }).expect(201);
  const upload = await request(app.getHttpServer()).post(`/api/v1/courses/${course.body.id}/materials`).set('Authorization', token(0)).attach('file', Buffer.from('notes'), { filename: 'notes.txt', contentType: 'text/plain' }).expect(201);
  const id = upload.body.id;
  const path = `/api/v1/courses/${course.body.id}/materials/${id}/extraction`;
  await request(app.getHttpServer()).get(path).expect(401);
  await request(app.getHttpServer()).get(path).set('Authorization', token(1)).expect(404);
  await request(app.getHttpServer()).get(path).set('Authorization', token(0)).expect(409);
  const material = fixture.materials.get(id);
  material.processingStatus = 'ready';
  const scope = { owner: users[0]._id, course: material.course, material: material._id, materialVersion: 1, extractorVersion: 1 };
  const [snapshot] = await fixture.ExtractionModel.create([{ ...scope, chunkCount: 1, textChars: 21, pageCount: 1, mediaType: 'text/plain' }]);
  await fixture.ChunkModel.create([{ ...scope, extraction: snapshot._id, index: 0, text: '<script>data</script>', page: null, charStart: 0, charEnd: 21, lineStart: 1, lineEnd: 1 }]);
  const response = await request(app.getHttpServer()).get(path).set('Authorization', token(0)).expect(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.headers['content-type']).toMatch(/application\/json/);
  expect(response.body.chunks[0].text).toBe('<script>data</script>');
  expect(response.body).not.toHaveProperty('owner'); expect(response.body).not.toHaveProperty('leaseToken');
  expect(response.body).not.toHaveProperty('storageKey');
  await request(app.getHttpServer()).get(`${path}?offset=-1`).set('Authorization', token(0)).expect(400);
  await request(app.getHttpServer()).delete(`/api/v1/courses/${course.body.id}/materials/${id}`).set('Authorization', token(0)).expect(204);
  expect(fixture.extractions.size).toBe(0); expect(fixture.chunks.size).toBe(0);
  await request(app.getHttpServer()).get(path).set('Authorization', token(0)).expect(404);
});

it('authenticates and scopes extraction retries, keeps the same attempt budget and redacts private fields', async () => {
  const course = await request(app.getHttpServer()).post('/api/v1/courses').set('Authorization', token(0)).send({ name: 'Retry API' }).expect(201);
  const upload = await request(app.getHttpServer()).post(`/api/v1/courses/${course.body.id}/materials`).set('Authorization', token(0)).attach('file', Buffer.from('notes'), { filename: 'notes.txt', contentType: 'text/plain' }).expect(201);
  const id = upload.body.id, path = `/api/v1/courses/${course.body.id}/materials/${id}/extraction/retry`;
  const material = fixture.materials.get(id), job = [...fixture.jobs.values()][0];
  material.processingStatus = 'failed'; material.processingErrorCode = 'parser_failed';
  Object.assign(job, { state: 'failed', errorCode: 'parser_failed', attempts: 1, maxAttempts: 3, leaseToken: 'private-token' });
  await request(app.getHttpServer()).post(path).expect(401);
  await request(app.getHttpServer()).post(path).set('Authorization', token(1)).expect(404);
  const list = await request(app.getHttpServer()).get(`/api/v1/courses/${course.body.id}/materials`).set('Authorization', token(0)).expect(200);
  expect(list.body.materials[0]).toMatchObject({ canRetryExtraction: true, processingAttempts: 1 });
  expect(typeof list.body.processingEnabled).toBe('boolean');
  const response = await request(app.getHttpServer()).post(path).set('Authorization', token(0)).send({ owner: users[1]._id }).expect(200);
  expect(response.body).toMatchObject({ processingStatus: 'queued', canRetryExtraction: false, processingAttempts: 1 });
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.body).not.toHaveProperty('owner'); expect(response.body).not.toHaveProperty('leaseToken'); expect(response.body).not.toHaveProperty('storageKey');
  await request(app.getHttpServer()).post(path).set('Authorization', token(0)).expect(409);
  expect(fixture.jobs.size).toBe(1);
});
