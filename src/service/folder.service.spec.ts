import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Mongoose, Types } from 'mongoose';
import { Folder, FolderSchema } from '../model/folder.schema.js';
import { validateFolder } from '../dto/folder.dto.js';
import { FolderService } from './folder.service.js';
import { CourseService } from './course.service.js';
import { courseModelFixture } from '../../test/fixtures/course-model.js';
const fixture = courseModelFixture();
const service = new FolderService(fixture.CourseModel as any, fixture.FolderModel as any);
const courses = new CourseService(fixture.CourseModel as any, service);
const owner = new Types.ObjectId(), other = new Types.ObjectId();
let course: string, foreignCourse: string;
beforeEach(async () => {
  fixture.stored.clear(); fixture.folders.clear();
  course = (await courses.create(owner, { name: 'Biology' })).id;
  foreignCourse = (await courses.create(other, { name: 'Private' })).id;
  // These tests exercise legacy courses that predate automatic folder setup.
  fixture.folders.clear();
});
it('creates nested folders with normalized names, safe responses, sorted children and validated breadcrumbs', async () => {
  const root = await service.create(owner, course, { name: ' Lectures  ', materialType: 'lecture', owner: other });
  const child = await service.create(owner, course, { name: ' Week   1 ', parent: root.id });
  expect(child).toMatchObject({ name: 'Week 1', parent: root.id });
  expect(child).not.toHaveProperty('owner');
  expect(fixture.folders.get(root.id).owner.equals(owner)).toBe(true);
  expect(await service.list(owner, course, root.id)).toMatchObject({ folders: [child], breadcrumbs: [root] });
  expect(await service.read(owner, course, child.id)).toMatchObject({ breadcrumbs: [root, child] });
  expect((await service.list(owner, course)).folders.map((f) => f.id)).toEqual([root.id]);
});
it('renames without losing material type and can clear classification', async () => {
  const root = await service.create(owner, course, { name: 'Lectures', materialType: 'lecture' });
  expect(await service.update(owner, course, root.id, { name: 'Class Notes', owner: other })).toMatchObject({ name: 'Class Notes', materialType: 'lecture' });
  expect(await service.update(owner, course, root.id, { materialType: '' })).toMatchObject({ materialType: '' });
  await expect(service.update(owner, course, root.id, { name: 'Move', parent: null })).rejects.toBeInstanceOf(BadRequestException);
});
it('blocks case-insensitive duplicate siblings but allows equal names under different parents', async () => {
  const root = await service.create(owner, course, { name: 'Notes' });
  await expect(service.create(owner, course, { name: ' notes ' })).rejects.toBeInstanceOf(ConflictException);
  const child = await service.create(owner, course, { name: 'Notes', parent: root.id });
  expect(child.parent).toBe(root.id);
  const otherRoot = await service.create(owner, course, { name: 'Other' });
  await expect(service.update(owner, course, otherRoot.id, { name: 'NOTES' })).rejects.toBeInstanceOf(ConflictException);
  expect((await service.read(owner, course, otherRoot.id)).name).toBe('Other');
});
it('rejects foreign courses, foreign and cross-course parents and missing references', async () => {
  const own = await service.create(owner, course, { name: 'Own' });
  const foreign = await service.create(other, foreignCourse, { name: 'Foreign' });
  const second = (await courses.create(owner, { name: 'Second' })).id;
  await expect(service.list(other, course)).rejects.toBeInstanceOf(NotFoundException);
  await expect(service.create(owner, course, { name: 'Bad', parent: foreign.id })).rejects.toBeInstanceOf(NotFoundException);
  await expect(service.create(owner, second, { name: 'Bad', parent: own.id })).rejects.toBeInstanceOf(NotFoundException);
  await expect(service.read(owner, course, foreign.id)).rejects.toBeInstanceOf(NotFoundException);
  await expect(service.update(other, course, own.id, { name: 'Stolen' })).rejects.toBeInstanceOf(NotFoundException);
  await expect(service.delete(other, course, own.id)).rejects.toBeInstanceOf(NotFoundException);
  await expect(service.list(owner, course, new Types.ObjectId().toString())).rejects.toBeInstanceOf(NotFoundException);
});
it('allows ten levels and rejects the eleventh without creating a folder', async () => {
  let parent: string | null = null;
  for (let depth = 1; depth <= 10; depth++) parent = (await service.create(owner, course, { name: `Level ${depth}`, parent })).id;
  expect((await service.list(owner, course, parent!)).breadcrumbs).toHaveLength(10);
  await expect(service.create(owner, course, { name: 'Too deep', parent })).rejects.toBeInstanceOf(BadRequestException);
  expect(fixture.folders.size).toBe(10);
});
it('detects corrupt ancestry cycles', async () => {
  const root = await service.create(owner, course, { name: 'Root' });
  fixture.folders.get(root.id).parent = new Types.ObjectId(root.id);
  await expect(service.read(owner, course, root.id)).rejects.toBeInstanceOf(ConflictException);
});
it('only deletes empty folders and empty courses', async () => {
  const root = await service.create(owner, course, { name: 'Root' });
  const child = await service.create(owner, course, { name: 'Child', parent: root.id });
  await expect(service.delete(owner, course, root.id)).rejects.toBeInstanceOf(ConflictException);
  await expect(courses.delete(owner, course)).rejects.toBeInstanceOf(ConflictException);
  await service.delete(owner, course, child.id);
  await service.delete(owner, course, root.id);
  await courses.delete(owner, course);
  expect(fixture.folders.size).toBe(0);
  expect(fixture.stored.has(course)).toBe(false);
});
it('does not backfill or modify legacy course folders when listing', async () => {
  expect((await service.list(owner, course)).folders).toEqual([]);
  const existing = await service.create(owner, course, { name: 'Custom Notes', materialType: 'other' });
  expect((await service.list(owner, course)).folders).toEqual([existing]);
});
it.each(['create-first', 'delete-first'])('serializes parent delete and child create (%s)', async (order) => {
  const root = await service.create(owner, course, { name: 'Root' });
  const create = () => service.create(owner, course, { name: 'Child', parent: root.id });
  const remove = () => service.delete(owner, course, root.id);
  const outcomes = await Promise.allSettled(order === 'create-first' ? [create(), remove()] : [remove(), create()]);
  expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  for (const folder of fixture.folders.values()) if (folder.parent) expect(fixture.folders.has(folder.parent.toString())).toBe(true);
});
it.each(['create-first', 'delete-first'])('serializes course delete and root create (%s)', async (order) => {
  const create = () => service.create(owner, course, { name: 'Root' });
  const remove = () => courses.delete(owner, course);
  await Promise.allSettled(order === 'create-first' ? [create(), remove()] : [remove(), create()]);
  for (const folder of fixture.folders.values()) expect(fixture.stored.has(folder.course.toString())).toBe(true);
});
it('fails safely when transactions are unavailable', async () => {
  const transaction = vi.spyOn(fixture.CourseModel.db, 'transaction').mockRejectedValueOnce(Object.assign(new Error('Transaction numbers are only allowed'), { code: 20 }));
  await expect(service.create(owner, course, { name: 'Root' })).rejects.toBeInstanceOf(ServiceUnavailableException);
  expect(fixture.folders.size).toBe(0);
  transaction.mockRestore();
});
it.each([null, [], {}, { name: '' }, { name: 1 }, { name: 'x'.repeat(121) }, { name: 'A', materialType: 'video' }])('rejects invalid folder data %j', (value) => {
  expect(() => validateFolder(value)).toThrow(BadRequestException);
});
it.each(['bad', '', 'z'.repeat(24)])('validates reference IDs %j', async (value) => {
  await expect(service.create(owner, course, { name: 'Bad', parent: value })).rejects.toBeInstanceOf(BadRequestException);
  await expect(service.read(owner, course, value)).rejects.toBeInstanceOf(BadRequestException);
});
it('defines sibling uniqueness and starter identity indexes', async () => {
  const model = new Mongoose().model(Folder.name, FolderSchema);
  await expect(new model({ owner, course, name: 'Root', nameKey: 'root' }).validate()).resolves.toBeUndefined();
  await expect(new model({ owner, course, name: 'Root', nameKey: 'root', materialType: 'video' }).validate()).rejects.toHaveProperty('errors.materialType');
  expect(FolderSchema.indexes()).toContainEqual([{ owner: 1, course: 1, parent: 1, nameKey: 1 }, { unique: true }]);
});

it('keeps starter names fixed and orders starters before custom folders', async () => {
  const created = (await courses.create(owner, { name: 'New course' })).id;
  const original = (await service.list(owner, created)).folders;
  expect(original.map((folder) => folder.name)).toEqual(['Syllabus', 'Lectures', 'Quizzes', 'Exams']);
  expect(original.every((folder) => folder.isStarter)).toBe(true);
  await expect(service.update(owner, created, original[0].id, { name: 'ZZZ Outline' })).rejects.toBeInstanceOf(ForbiddenException);
  await expect(service.update(other, created, original[0].id, { name: 'ZZZ Outline' })).rejects.toBeInstanceOf(NotFoundException);
  expect((await service.read(owner, created, original[0].id)).name).toBe('Syllabus');
  const custom = await service.create(owner, created, { name: 'AAA custom', starterKey: 'exam', isStarter: true, materialType: 'exam' });
  expect(custom.isStarter).toBe(false);
  const listed = (await service.list(owner, created)).folders;
  expect(listed.map((folder) => folder.name)).toEqual(['Syllabus', 'Lectures', 'Quizzes', 'Exams', 'AAA custom']);
  await expect(service.delete(owner, created, original[0].id)).rejects.toBeInstanceOf(ForbiddenException);
  await expect(service.delete(other, created, original[0].id)).rejects.toBeInstanceOf(NotFoundException);
  await service.delete(owner, created, custom.id);
});

it('deletes only courses containing empty root starters, leaving custom or nested contents protected', async () => {
  const created = (await courses.create(owner, { name: 'New course' })).id;
  const starters = (await service.list(owner, created)).folders;
  const nested = await service.create(owner, created, { name: 'Week 1', parent: starters[1].id });
  await expect(courses.delete(owner, created)).rejects.toBeInstanceOf(ConflictException);
  expect((await service.list(owner, created)).folders).toHaveLength(4);
  await service.delete(owner, created, nested.id);
  const custom = await service.create(owner, created, { name: 'Custom' });
  await expect(courses.delete(owner, created)).rejects.toBeInstanceOf(ConflictException);
  await service.delete(owner, created, custom.id);
  await courses.delete(owner, created);
  expect([...fixture.folders.values()].some((folder) => folder.course.toString() === created)).toBe(false);
  expect(fixture.stored.has(created)).toBe(false);
});

it('rolls back starter cleanup when course deletion fails partway', async () => {
  const created = (await courses.create(owner, { name: 'Rollback cleanup' })).id;
  const remove = fixture.FolderModel.deleteOne.bind(fixture.FolderModel);
  const spy = vi.spyOn(fixture.FolderModel, 'deleteOne').mockImplementationOnce(remove).mockImplementationOnce(() => { throw new Error('Cleanup failed'); });
  try {
    await expect(courses.delete(owner, created)).rejects.toThrow('Cleanup failed');
    expect(fixture.stored.has(created)).toBe(true);
    expect((await service.list(owner, created)).folders).toHaveLength(4);
  } finally { spy.mockRestore(); }
});
