import 'reflect-metadata';
import { JwtService } from '@nestjs/jwt';
import { HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { UserController } from './user.controller.js';
import { isAuthenticated } from '../app.middleware.js';
import type { UserRequest } from '../app.middleware.js';
import type { UserService } from '../service/user.service.js';

const profile = { fullname: 'Phat Chung', email: 'student@example.com', password: 'private-hash' };
const jwt = new JwtService({ secret: 'test-only-secret' });

it('returns only safe profile fields', () => {
  const controller = new UserController({} as UserService, jwt);
  expect(controller.me({ user: profile } as UserRequest)).toEqual({ fullname: profile.fullname, email: profile.email, phone: '', school: '', major: '' });
});

it('resolves the user from the verified token rather than the URL handle', async () => {
  const getOne = vi.fn().mockResolvedValue(profile);
  const middleware = new isAuthenticated(jwt, { getOne } as unknown as UserService);
  const request = { headers: { authorization: `Bearer ${jwt.sign({ email: profile.email })}` } } as UserRequest;
  const next = vi.fn();
  await middleware.use(request, {} as Response, next);
  expect(getOne).toHaveBeenCalledWith(profile.email);
  expect(next).toHaveBeenCalledOnce();
  expect(request.user).toBe(profile);
});

it.each([undefined, 'Bearer invalid-token'])('rejects missing or invalid tokens: %s', async (authorization) => {
  const getOne = vi.fn();
  const middleware = new isAuthenticated(jwt, { getOne } as unknown as UserService);
  const next = vi.fn();
  await expect(middleware.use({ headers: { authorization } } as UserRequest, {} as Response, next)).rejects.toBeInstanceOf(HttpException);
  expect(next).not.toHaveBeenCalled();
  expect(getOne).not.toHaveBeenCalled();
});

it('uses the authenticated email when saving a profile', async () => {
  const updateProfile = vi.fn().mockResolvedValue({ fullname: 'Phat Nguyen', email: profile.email });
  const controller = new UserController({ updateProfile } as unknown as UserService, jwt);
  await controller.updateProfile({ user: profile } as UserRequest, { fullname: 'Phat Nguyen' });
  expect(updateProfile).toHaveBeenCalledWith(profile.email, { fullname: 'Phat Nguyen' });
});

it('returns saved optional details on refresh while keeping storage references private', () => {
  const controller = new UserController({} as UserService, jwt);
  const details = { ...profile, phone: '+1 555 010 1234', school: 'Example University', major: 'Computer Science', avatarKey: 'private/avatar-key' };
  expect(controller.me({ user: details } as UserRequest)).toEqual({ fullname: profile.fullname, email: profile.email, phone: details.phone, school: details.school, major: details.major });
});
