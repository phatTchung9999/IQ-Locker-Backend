import 'reflect-metadata';
import 'dotenv/config';
import { Mongoose, Types } from 'mongoose';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CourseSchema } from '../src/model/course.schema.js';
import { MaterialSchema } from '../src/model/material.schema.js';
import { FolderSchema } from '../src/model/folder.schema.js';
import { CourseService } from '../src/service/course.service.js';
import { FolderService } from '../src/service/folder.service.js';

// Opt-in integration check. Uses only new, uniquely named collections and fake
// owner IDs; never reads or modifies the app's existing users/courses/folders.
describe.skipIf(process.env.IQLOCKER_MONGO_TEST !== '1')('MongoDB folder transactions', () => {
  const database = new Mongoose();
  const prefix = `iqlocker_phase13_test_${new Types.ObjectId()}`;
  const CourseModel = database.model('Phase13Course', CourseSchema.clone(), `${prefix}_courses`);
  const FolderModel = database.model('Phase13Folder', FolderSchema.clone(), `${prefix}_folders`);
  const MaterialModel = database.model('Phase13Material', MaterialSchema.clone(), `${prefix}_materials`);
  const folders = new FolderService(CourseModel as any, FolderModel as any, MaterialModel as any);
  const courses = new CourseService(CourseModel as any, folders);
  const owner = new Types.ObjectId(), foreign = new Types.ObjectId();
  beforeAll(async () => {
    await database.connect(process.env.MONGO_URI ?? 'mongodb://localhost:27017/Stream', { serverSelectionTimeoutMS: 8000 });
    await Promise.all([CourseModel.init(), FolderModel.init(), MaterialModel.init()]);
  }, 20000);
  afterAll(async () => {
    try {
      if (database.connection.readyState === 1) {
        for (const model of [CourseModel, FolderModel, MaterialModel]) {
          if (!model.collection.name.startsWith(prefix)) throw new Error('Invalid test collection');
          await model.collection.drop().catch((error) => { if (error.code !== 26) throw error; });
        }
      }
    } finally { await database.disconnect(); }
  }, 20000);

  it('persists hierarchy, enforces indexes, and prevents orphans during actual concurrent writes', async () => {
    const course = (await courses.create(owner, { name: 'Disposable integration course' })).id;
    const presets = (await folders.list(owner, course)).folders;
    expect(presets.map((folder) => folder.name)).toEqual(['Syllabus', 'Lectures', 'Quizzes', 'Exams']);
    const root = presets.find((folder) => folder.name === 'Lectures')!;
    const child = await folders.create(owner, course, { name: 'Week 1', parent: root.id });
    expect((await folders.read(owner, course, child.id)).breadcrumbs.map((f) => f.name)).toEqual(['Lectures', 'Week 1']);
    await expect(folders.read(foreign, course, child.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(folders.create(owner, course, { name: 'LECTURES' })).rejects.toBeInstanceOf(ConflictException);
    await expect(folders.delete(owner, course, root.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(folders.update(owner, course, root.id, { name: 'Class Notes' })).rejects.toBeInstanceOf(ForbiddenException);
    expect((await folders.read(owner, course, root.id)).name).toBe('Lectures');
    expect((await folders.read(owner, course, root.id)).materialType).toBe('lecture');
    expect((await folders.list(owner, course)).folders).toHaveLength(4);

    for (let round = 0; round < 4; round++) {
      const parent = await folders.create(owner, course, { name: `Race ${round}` });
      const results = await Promise.allSettled([
        folders.create(owner, course, { name: 'Child', parent: parent.id }),
        folders.delete(owner, course, parent.id),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const children = await FolderModel.find({ course, parent: parent.id });
      if (children.length) expect(await FolderModel.exists({ _id: parent.id })).toBeTruthy();
    }
    const disposable = (await courses.create(owner, { name: 'Empty starter cleanup' })).id;
    await courses.delete(owner, disposable);
    expect(await FolderModel.countDocuments({ course: disposable })).toBe(0);
    expect(await CourseModel.exists({ _id: disposable })).toBeNull();
    const emptyCourse = (await courses.create(owner, { name: 'Disposable course race' })).id;
    const results = await Promise.allSettled([folders.create(owner, emptyCourse, { name: 'Root' }), courses.delete(owner, emptyCourse)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const remaining = await FolderModel.find({ course: emptyCourse });
    if (remaining.length) expect(await CourseModel.exists({ _id: emptyCourse })).toBeTruthy();
  }, 30000);
  it('rolls back the course and partial starter set if folder initialization fails', async () => {
    const beforeCourses = await CourseModel.countDocuments({});
    const beforeFolders = await FolderModel.countDocuments({});
    const original = FolderModel.create.bind(FolderModel);
    const create = vi.spyOn(FolderModel, 'create').mockImplementationOnce(original as any).mockRejectedValueOnce(new Error('Test initialization failure'));
    try {
      await expect(courses.create(owner, { name: 'Should roll back' })).rejects.toThrow('Test initialization failure');
    } finally { create.mockRestore(); }
    expect(await CourseModel.countDocuments({})).toBe(beforeCourses);
    expect(await FolderModel.countDocuments({})).toBe(beforeFolders);
  }, 15000);
});

