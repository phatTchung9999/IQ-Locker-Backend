import { afterEach, describe, expect, it, vi } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { getJwtSecret } from './constants.js';

afterEach(() => vi.unstubAllEnvs());
describe('JWT runtime secret', () => {
    it.each([undefined, '', '   '])('rejects a missing or blank secret without a fallback', (value) => {
        vi.stubEnv('JWT_SECRET_KEY', value);
        expect(() => getJwtSecret()).toThrow('JWT_SECRET_KEY must be set');
    });
    it('signs and verifies with the configured key and rejects tokens from another key', () => {
        vi.stubEnv('JWT_SECRET_KEY', 'test-only-runtime-key-that-is-not-for-deployment');
        const jwt = new JwtService({ secret: getJwtSecret(), signOptions: { expiresIn: '2h' } });
        const token = jwt.sign({ email: 'student@example.test' });
        expect(jwt.verify(token).email).toBe('student@example.test');
        const previous = new JwtService({ secret: 'test-only-previous-key' });
        expect(() => jwt.verify(previous.sign({ email: 'student@example.test' }))).toThrow();
    });
});
