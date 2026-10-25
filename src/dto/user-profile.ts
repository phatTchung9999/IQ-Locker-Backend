import type { User } from '../model/user.schema.js';

// Keep all account responses explicit: never serialize the password or internal storage keys.
export function userProfile(user: User) {
    return {
        fullname: user.fullname,
        email: user.email,
        phone: user.phone ?? '',
        school: user.school ?? '',
        major: user.major ?? '',
    };
}
