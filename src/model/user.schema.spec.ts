import 'reflect-metadata';
import { Mongoose } from 'mongoose';
import { UserSchema } from './user.schema.js';

const UserModel = new Mongoose().model('ProfileFieldsTest', UserSchema);
const account = { fullname: 'Phat Chung', email: 'student@example.com', password: 'existing-password-hash' };

it('keeps existing accounts valid without additional profile fields', async () => {
  const existing = new UserModel(account);
  await expect(existing.validate()).resolves.toBeUndefined();
  expect(existing.phone).toBeUndefined();
  expect(existing.school).toBeUndefined();
  expect(existing.major).toBeUndefined();
  expect(existing.avatarKey).toBeUndefined();
});

it('stores optional text fields and the future avatar storage key', async () => {
  const profile = new UserModel({ ...account, phone: ' +1 555 010 1234 ', school: ' Example University ', major: ' Computer Science ', avatarKey: ' avatars/student/image.webp ' });
  await expect(profile.validate()).resolves.toBeUndefined();
  expect(profile.phone).toBe('+1 555 010 1234');
  expect(profile.school).toBe('Example University');
  expect(profile.major).toBe('Computer Science');
  expect(profile.avatarKey).toBe('avatars/student/image.webp');
});

it.each([['phone', 41], ['school', 151], ['major', 151], ['avatarKey', 1025]])('limits stored %s length', async (field, length) => {
  await expect(new UserModel({ ...account, [field]: 'a'.repeat(Number(length)) }).validate()).rejects.toHaveProperty(`errors.${field}`);
});
