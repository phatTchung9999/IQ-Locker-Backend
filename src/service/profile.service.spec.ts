import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Model } from 'mongoose';
import type { UserDocument } from '../model/user.schema.js';
import { ProfileValidationPipe } from '../dto/profile.dto.js';
import { UserService } from './user.service.js';

const pipe = new ProfileValidationPipe();
it('normalizes names and accepts only editable fields', () => {
  expect(pipe.transform({ fullname: '  Phat   Chung  ', email: 'other@example.com', password: 'ignored' })).toEqual({ fullname: 'Phat Chung' });
});
it.each([null, [], {}, { fullname: 42 }, { fullname: '   ' }, { fullname: 'a'.repeat(101) }])('rejects invalid profile input %j', (input) => {
  expect(() => pipe.transform(input)).toThrow(BadRequestException);
});

it('updates only the name of the account selected by authentication', async () => {
  const exec = vi.fn().mockResolvedValue({ fullname: 'Phat Nguyen', email: 'student@example.com', password: 'private-hash' });
  const select = vi.fn().mockReturnValue({ exec });
  const findOneAndUpdate = vi.fn().mockReturnValue({ select });
  const service = new UserService({ findOneAndUpdate } as unknown as Model<UserDocument>);
  const result = await service.updateProfile('student@example.com', { fullname: ' Phat Nguyen ', email: 'victim@example.com', password: 'ignored' });
  expect(findOneAndUpdate).toHaveBeenCalledWith({ email: 'student@example.com' }, { $set: { fullname: 'Phat Nguyen' } }, { new: true, runValidators: true });
  expect(select).toHaveBeenCalledWith('fullname email phone school major -_id');
  expect(result).toEqual({ fullname: 'Phat Nguyen', email: 'student@example.com', phone: '', school: '', major: '' });
});

it('rejects invalid names before accessing the database', async () => {
  const findOneAndUpdate = vi.fn();
  const service = new UserService({ findOneAndUpdate } as unknown as Model<UserDocument>);
  await expect(service.updateProfile('student@example.com', { fullname: ' ' })).rejects.toBeInstanceOf(BadRequestException);
  expect(findOneAndUpdate).not.toHaveBeenCalled();
});

it('reports an account removed before saving', async () => {
  const findOneAndUpdate = vi.fn().mockReturnValue({ select: () => ({ exec: async () => null }) });
  const service = new UserService({ findOneAndUpdate } as unknown as Model<UserDocument>);
  await expect(service.updateProfile('student@example.com', { fullname: 'Phat Chung' })).rejects.toBeInstanceOf(NotFoundException);
});


it('normalizes optional details, supports clearing, and strips protected fields', () => {
  expect(pipe.transform({ fullname: 'Phat Chung', phone: ' +1 (555) 010-1234 ', school: ' Example   University ', major: '  ', email: 'ignored', avatarKey: 'ignored', password: 'ignored' })).toEqual({
    fullname: 'Phat Chung', phone: '+1 (555) 010-1234', school: 'Example University', major: '',
  });
});

it.each([
  { phone: 123 }, { phone: null }, { phone: 'not a number' }, { phone: '1'.repeat(41) },
  { school: [] }, { school: 'a'.repeat(151) }, { major: {} }, { major: 'a'.repeat(151) },
])('rejects invalid optional details %j', (details) => {
  expect(() => pipe.transform({ fullname: 'Phat Chung', ...details })).toThrow(BadRequestException);
});

it('saves and returns optional details without exposing the internal avatar key', async () => {
  const details = { fullname: 'Phat Chung', phone: '+1 555 010 1234', school: 'Example University', major: 'Computer Science' };
  const exec = vi.fn().mockResolvedValue({ ...details, email: 'student@example.com', avatarKey: 'private/object-key', password: 'private-hash' });
  const findOneAndUpdate = vi.fn().mockReturnValue({ select: () => ({ exec }) });
  const service = new UserService({ findOneAndUpdate } as unknown as Model<UserDocument>);
  expect(await service.updateProfile('student@example.com', details)).toEqual({ ...details, email: 'student@example.com' });
  expect(findOneAndUpdate).toHaveBeenCalledWith({ email: 'student@example.com' }, { $set: details }, { new: true, runValidators: true });
});
