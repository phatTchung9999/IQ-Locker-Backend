import 'reflect-metadata';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { UserService } from './user.service.js';
import { UserDocument, UserSchema } from '../model/user.schema.js';
import { SignupValidationPipe } from '../dto/signup.dto.js';
import { JwtService } from '@nestjs/jwt';

const valid = { fullname: ' Example User ', email: ' Person@Example.com ', password: 'safe-password' };

describe('Signup validation', () => {
  const pipe = new SignupValidationPipe();
  it('normalizes name/email and removes unexpected fields', () => {
    expect(pipe.transform({ ...valid, role: 'admin' })).toEqual({
      fullname: 'Example User', email: 'person@example.com', password: valid.password,
    });
  });
  it.each([null, [], {}, { ...valid, fullname: ' ' }, { ...valid, email: 'invalid' },
    { ...valid, password: undefined }, { ...valid, password: 123 },
    { ...valid, password: 'short' }, { ...valid, password: 'a'.repeat(73) },
    { ...valid, password: '😀'.repeat(19) }])('rejects invalid input %j', (input) => {
    expect(() => pipe.transform(input)).toThrow(BadRequestException);
  });
  it('accepts the bcrypt byte limit without changing the password', () => {
    expect(pipe.transform({ ...valid, password: 'a'.repeat(72) }).password).toHaveLength(72);
  });
});

describe('UserService signup', () => {
  const save = vi.fn();
  let body: Record<string, string>;
  class FakeUserModel {
    constructor(input: Record<string, string>) { body = input; }
    save = save;
  }
  const service = new UserService(FakeUserModel as unknown as Model<UserDocument>);
  beforeEach(() => { save.mockReset(); });
  it('stores a verifiable hash and returns only safe fields', async () => {
    const createdDate = new Date();
    save.mockImplementation(async () => ({ ...body, _id: 'user-id', createdDate, __v: 0 }));
    const result = await service.signup(valid);
    expect(result).toEqual({ id: 'user-id', fullname: 'Example User', email: 'person@example.com', createdDate });
    expect(body.password).not.toBe(valid.password);
    expect(await bcrypt.compare(valid.password, body.password)).toBe(true);
  });
  it('rejects invalid requests before saving', async () => {
    await expect(service.signup({ ...valid, password: undefined })).rejects.toBeInstanceOf(BadRequestException);
    expect(save).not.toHaveBeenCalled();
  });
  it('maps duplicate key errors to HTTP 409', async () => {
    save.mockRejectedValue({ code: 11000 });
    await expect(service.signup(valid)).rejects.toBeInstanceOf(ConflictException);
  });
  it('preserves unexpected database errors', async () => {
    const error = new Error('Database unavailable');
    save.mockRejectedValue(error);
    await expect(service.signup(valid)).rejects.toBe(error);
  });
});

describe('User schema', () => {
  it('computes the creation date when a document is created', () => {
    expect(UserSchema.path('createdDate').options.default).toBe(Date.now);
  });
  it('trims and lowercases email', () => {
    expect(UserSchema.path('email').applySetters(' Person@Example.com ', null)).toBe('person@example.com');
  });
});

describe('Signin email normalization', () => {
  it('finds an existing account using trimmed lowercase email', async () => {
    const password = await bcrypt.hash(valid.password, 10);
    const findOne = vi.fn().mockReturnValue({ exec: async () => ({ fullname: 'Example User', email: 'person@example.com', password }) });
    const service = new UserService({ findOne } as unknown as Model<UserDocument>);
    const sign = vi.fn().mockReturnValue('token');
    await expect(service.signin(valid as UserDocument, { sign } as unknown as JwtService)).resolves.toEqual({ token: 'token', user: { fullname: 'Example User', email: 'person@example.com', phone: '', school: '', major: '' } });
    expect(findOne).toHaveBeenCalledWith({ email: 'person@example.com' });
  });
});
