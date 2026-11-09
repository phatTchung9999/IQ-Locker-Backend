import 'reflect-metadata';
import { Readable } from 'node:stream';
import { ServiceUnavailableException } from '@nestjs/common';
import { BlobStorageService } from './blob-storage.service.js';
const sdk = vi.hoisted(() => ({ properties: vi.fn(), upload: vi.fn(), download: vi.fn(), remove: vi.fn(), credential: vi.fn(), container: vi.fn() }));
vi.mock('@azure/identity', () => ({ DefaultAzureCredential: class { constructor() { sdk.credential(); } } }));
vi.mock('@azure/storage-blob', () => ({ BlobServiceClient: class {
    static fromConnectionString() { return new this(); }
    getContainerClient(name: string) { sdk.container(name); return { getProperties: sdk.properties, getBlockBlobClient: () => ({ uploadData: sdk.upload }), getBlobClient: () => ({ download: sdk.download, deleteIfExists: sdk.remove }) }; }
} }));
let previous: NodeJS.ProcessEnv;
beforeEach(() => {
    previous = { ...process.env }; vi.resetAllMocks();
    process.env.AZURE_STORAGE_ACCOUNT_URL = 'https://testaccount.blob.core.windows.net';
    process.env.AZURE_STORAGE_CONTAINER = 'materials';
    delete process.env.AZURE_STORAGE_MATERIALS_CONTAINER; delete process.env.AZURE_STORAGE_AVATARS_CONTAINER;
    delete process.env.AZURE_STORAGE_CONNECTION_STRING;
    sdk.properties.mockResolvedValue({}); sdk.upload.mockResolvedValue({}); sdk.remove.mockResolvedValue({ succeeded: false });
});
afterEach(() => { process.env = previous; });
it('uses managed identity and uploads generated keys with safe headers, no overwrite, and an abort signal', async () => {
    const storage = new BlobStorageService(); const data = Buffer.from('notes');
    await storage.upload('materials/generated.txt', data, 'text/plain');
    expect(sdk.credential).toHaveBeenCalledTimes(1);
    expect(sdk.upload).toHaveBeenCalledWith(data, expect.objectContaining({ conditions: { ifNoneMatch: '*' }, blobHTTPHeaders: { blobContentType: 'text/plain' }, abortSignal: expect.any(AbortSignal) }));
    await storage.ensureReady(); expect(sdk.properties).toHaveBeenCalledTimes(1);
});
it.each(['blob', 'container'])('rejects public containers (%s)', async (level) => {
    sdk.properties.mockResolvedValue({ blobPublicAccess: level });
    await expect(new BlobStorageService().ensureReady()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(sdk.upload).not.toHaveBeenCalled();
});
it('rejects missing or insecure production configuration', async () => {
    delete process.env.AZURE_STORAGE_CONTAINER;
    await expect(new BlobStorageService().ensureReady()).rejects.toBeInstanceOf(ServiceUnavailableException);
    process.env.AZURE_STORAGE_CONTAINER = 'materials'; process.env.NODE_ENV = 'production';
    process.env.AZURE_STORAGE_ACCOUNT_URL = 'http://untrusted.example';
    process.env.AZURE_STORAGE_CONNECTION_STRING = 'local-only';
    await expect(new BlobStorageService().ensureReady()).rejects.toBeInstanceOf(ServiceUnavailableException);
});
it('streams content and treats an already-missing blob as successful cleanup', async () => {
    const stream = Readable.from('notes'); sdk.download.mockResolvedValue({ readableStreamBody: stream });
    const storage = new BlobStorageService(); expect(await storage.download('materials/key.txt')).toBe(stream);
    await expect(storage.remove('materials/key.txt')).resolves.toBeUndefined();
    expect(sdk.remove).toHaveBeenCalledWith(expect.objectContaining({ deleteSnapshots: 'include' }));
});
it('redacts Azure authentication errors from callers', async () => {
    sdk.properties.mockRejectedValue(new Error('secret credential details'));
    await expect(new BlobStorageService().ensureReady()).rejects.toThrow('Private document storage is unavailable');
});

it('selects separate material/avatar containers, shares authentication and caches privacy separately', async () => {
    process.env.AZURE_STORAGE_MATERIALS_CONTAINER = 'new-materials';
    process.env.AZURE_STORAGE_AVATARS_CONTAINER = 'avatars';
    const storage = new BlobStorageService();
    await storage.upload('notes.txt', Buffer.from('notes'), 'text/plain');
    await storage.upload('photo.png', Buffer.from('image'), 'image/png', undefined, 'avatars');
    expect(sdk.container.mock.calls.map(call => call[0])).toEqual(['new-materials', 'avatars']);
    expect(sdk.properties).toHaveBeenCalledTimes(2);
    expect(sdk.credential).toHaveBeenCalledTimes(1);
    const stream = Readable.from('image'); sdk.download.mockResolvedValue({ readableStreamBody: stream });
    expect(await storage.download('photo.png', undefined, 'avatars')).toBe(stream);
    await storage.remove('photo.png', 'avatars');
    await storage.ensureReady();
    expect(sdk.container).toHaveBeenCalledTimes(2);
    expect(sdk.properties).toHaveBeenCalledTimes(2);
});
it('rejects public avatars independently of a verified private materials container', async () => {
    process.env.AZURE_STORAGE_AVATARS_CONTAINER = 'avatars';
    const storage = new BlobStorageService();
    await storage.ensureReady();
    sdk.properties.mockResolvedValue({ blobPublicAccess: 'blob' });
    await expect(storage.ensureReady('avatars')).rejects.toThrow('Private avatar storage is unavailable');
    await expect(storage.ensureReady()).resolves.toBeUndefined();
});
it('never falls back to materials for missing or colliding avatar configuration', async () => {
    const storage = new BlobStorageService();
    await storage.ensureReady();
    await expect(storage.ensureReady('avatars')).rejects.toBeInstanceOf(ServiceUnavailableException);
    process.env.AZURE_STORAGE_AVATARS_CONTAINER = 'materials';
    await expect(storage.ensureReady('avatars')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(sdk.container).toHaveBeenCalledTimes(1);
});
it('fails for an invalid explicit materials name rather than silently using the legacy variable', async () => {
    process.env.AZURE_STORAGE_MATERIALS_CONTAINER = '';
    await expect(new BlobStorageService().ensureReady()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(sdk.container).not.toHaveBeenCalled();
});
