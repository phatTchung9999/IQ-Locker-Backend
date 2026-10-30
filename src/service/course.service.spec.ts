import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Model, Types, Mongoose } from 'mongoose';
import { Course, CourseSchema } from '../model/course.schema.js';
import type { CourseDocument } from '../model/course.schema.js';
import { CourseService } from './course.service.js';
import { courseModelFixture } from '../../test/fixtures/course-model.js';
import { FolderService } from './folder.service.js';
import { validateCourse } from '../dto/course.dto.js';

const owner = new Types.ObjectId();
const otherOwner = new Types.ObjectId();
const { CourseModel: FakeCourseModel, FolderModel, MaterialModel, stored, folders } = courseModelFixture();
const folderService = new FolderService(FakeCourseModel as any, FolderModel as any, MaterialModel as any);
const service = new CourseService(FakeCourseModel as unknown as Model<CourseDocument>, folderService);
beforeEach(() => { stored.clear(); folders.clear(); });

it('creates normalized course metadata for the authenticated owner and projects safe fields', async () => {
  const result = await service.create(owner, { name: '  Biology   101 ', code: ' BIO101 ', semester: ' Fall 2026 ', owner: otherOwner, id: 'spoofed' });
  expect(result).toEqual({ id: expect.any(String), name: 'Biology 101', code: 'BIO101', semester: 'Fall 2026', createdAt: expect.any(Date), updatedAt: expect.any(Date) });
  expect(stored.get(result.id).owner.equals(owner)).toBe(true);
  expect(result).not.toHaveProperty('owner');
  expect([...folders.values()].map((folder) => folder.name)).toEqual(['Syllabus', 'Lectures', 'Quizzes', 'Exams']);
  expect([...folders.values()].every((folder) => folder.owner.equals(owner) && folder.course.toString() === result.id && folder.parent === null)).toBe(true);
});

it('lists only owned courses, without a global name uniqueness requirement', async () => {
  const first = await service.create(owner, { name: 'Biology' });
  await service.create(otherOwner, { name: 'Someone else’s course' });
  const second = await service.create(owner, { name: 'Biology', semester: 'Spring 2027' });
  expect((await service.list(owner)).map((course) => course.id)).toEqual([second.id, first.id]);
});

it('reads, renames, clears optional metadata, and deletes an owned empty course', async () => {
  const created = await service.create(owner, { name: 'Biology', code: 'BIO101', semester: 'Fall 2026' });
  expect(await service.read(owner, created.id)).toEqual(created);
  const updated = await service.update(owner, created.id, { name: 'Biology II', code: '', owner: otherOwner });
  expect(updated).toMatchObject({ id: created.id, name: 'Biology II', code: '', semester: 'Fall 2026' });
  expect(stored.get(created.id).owner.equals(owner)).toBe(true);
  await service.delete(owner, created.id);
  expect([...folders.values()].some((folder) => folder.course.toString() === created.id)).toBe(false);
  await expect(service.read(owner, created.id)).rejects.toBeInstanceOf(NotFoundException);
});

it('prevents another account from reading, updating, or deleting a course', async () => {
  const created = await service.create(owner, { name: 'Private course' });
  await expect(service.read(otherOwner, created.id)).rejects.toBeInstanceOf(NotFoundException);
  await expect(service.update(otherOwner, created.id, { name: 'Changed' })).rejects.toBeInstanceOf(NotFoundException);
  await expect(service.delete(otherOwner, created.id)).rejects.toBeInstanceOf(NotFoundException);
  expect(await service.read(owner, created.id)).toMatchObject({ name: 'Private course' });
});

it.each(['bad-id', '123', 'z'.repeat(24)])('rejects invalid ID %s', async (id) => {
  await expect(service.read(owner, id)).rejects.toBeInstanceOf(BadRequestException);
  await expect(service.update(owner, id, { name: 'Name' })).rejects.toBeInstanceOf(BadRequestException);
  await expect(service.delete(owner, id)).rejects.toBeInstanceOf(BadRequestException);
});

it('returns not found for a valid but missing ID', async () => {
  const id = new Types.ObjectId().toString();
  await expect(service.read(owner, id)).rejects.toBeInstanceOf(NotFoundException);
  await expect(service.update(owner, id, { name: 'Name' })).rejects.toBeInstanceOf(NotFoundException);
  await expect(service.delete(owner, id)).rejects.toBeInstanceOf(NotFoundException);
});

it.each([null, [], {}, { name: ' ' }, { name: 10 }, { name: 'x'.repeat(121) }, { name: 'A', code: 'x'.repeat(41) }, { name: 'A', semester: 'x'.repeat(81) }, { name: 'A', code: null }, { name: 'A', semester: {} }])('rejects invalid creation %j', (input) => {
  expect(() => validateCourse(input)).toThrow(BadRequestException);
});
it.each([{}, { owner }, { name: ' ' }])('rejects empty or invalid updates %j', (input) => {
  expect(() => validateCourse(input, true)).toThrow(BadRequestException);
});

it('enforces schema constraints and indexes ownership with creation time', async () => {
  const CourseModel = new Mongoose().model(Course.name, CourseSchema);
  await expect(new CourseModel({ owner, name: 'Biology' }).validate()).resolves.toBeUndefined();
  await expect(new CourseModel({ name: 'Biology' }).validate()).rejects.toHaveProperty('errors.owner');
  await expect(new CourseModel({ owner, name: 'x'.repeat(121) }).validate()).rejects.toHaveProperty('errors.name');
  expect(CourseSchema.indexes()).toContainEqual([{ owner: 1, createdAt: -1, _id: -1 }, {}]);
});

it('rolls back the entire new course when a starter-folder write fails', async () => {
  const create = FolderModel.create.bind(FolderModel);
  const mock = vi.spyOn(FolderModel, 'create').mockImplementationOnce(create).mockRejectedValueOnce(new Error('Write failed'));
  try {
    await expect(service.create(owner, { name: 'Failed course' })).rejects.toThrow('Write failed');
    expect(stored.size).toBe(0);
    expect(folders.size).toBe(0);
  } finally { mock.mockRestore(); }
});
