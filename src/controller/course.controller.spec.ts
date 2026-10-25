import 'reflect-metadata';
import { Types } from 'mongoose';
import { CourseController } from './course.controller.js';
import type { CourseService } from '../service/course.service.js';
import type { UserRequest } from '../app.middleware.js';

it('takes course ownership from the authenticated document for every operation', async () => {
  const owner = new Types.ObjectId();
  const id = new Types.ObjectId().toString();
  const courses = { create: vi.fn(), list: vi.fn(), read: vi.fn(), update: vi.fn(), delete: vi.fn() };
  const controller = new CourseController(courses as unknown as CourseService);
  const request = { user: { _id: owner } } as UserRequest;
  controller.create(request, { name: 'Biology' });
  controller.list(request);
  controller.read(request, id);
  controller.update(request, id, { code: '' });
  await controller.delete(request, id);
  expect(courses.create).toHaveBeenCalledWith(owner, { name: 'Biology' });
  expect(courses.list).toHaveBeenCalledWith(owner);
  expect(courses.read).toHaveBeenCalledWith(owner, id);
  expect(courses.update).toHaveBeenCalledWith(owner, id, { code: '' });
  expect(courses.delete).toHaveBeenCalledWith(owner, id);
});
