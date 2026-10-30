// Read at startup; never fall back to a signing key stored in source control.
export function getJwtSecret(): string {
    const secret = process.env.JWT_SECRET_KEY;
    if (!secret?.trim()) throw new Error('JWT_SECRET_KEY must be set before starting the backend.');
    return secret;
}
