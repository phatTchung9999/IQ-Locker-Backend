import 'reflect-metadata';
const mocks = vi.hoisted(() => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), create: vi.fn() }));
vi.mock('@nestjs/common', async importOriginal => ({ ...await importOriginal<typeof import('@nestjs/common')>(),
  Logger: class { log = mocks.log; warn = mocks.warn; error = mocks.error; },
}));
vi.mock('@nestjs/core', () => ({ NestFactory: { create: mocks.create } }));
vi.mock('./app.module.js', () => ({ AppModule: class {}, ObserveInstrument: {} }));
import { getConnectionToken } from '@nestjs/mongoose';
let previousExitCode: typeof process.exitCode;
beforeEach(() => { vi.resetAllMocks(); vi.resetModules(); previousExitCode = process.exitCode; process.exitCode = undefined; });
afterEach(() => { process.exitCode = previousExitCode; });
function fixture() {
  const database = { readyState: 1, db: { command: vi.fn().mockResolvedValue({ ok: 1 }) } };
  const storage = { ensureReady: vi.fn().mockResolvedValue(undefined) };
  const app = { get: vi.fn(token => token === getConnectionToken() ? database : storage), enableCors: vi.fn(),
    listen: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined),
    getHttpServer: () => ({ address: () => ({ port: 3005 }) }) };
  mocks.create.mockResolvedValue(app);
  return { app, database, storage };
}
it('pings MongoDB, checks both containers and logs listening only after the server succeeds', async () => {
  const { app, database, storage } = fixture();
  app.listen.mockImplementation(async () => { expect(mocks.log).not.toHaveBeenCalledWith(expect.stringContaining('Backend: listening')); });
  await import('./main.js');
  expect(database.db.command).toHaveBeenCalledWith({ ping: 1 });
  expect(storage.ensureReady.mock.calls).toEqual([['materials'], ['avatars']]);
  expect(mocks.log.mock.calls.map(call => call[0])).toEqual(['MongoDB: connected', 'Materials container: private access verified',
    'Avatars container: private access verified', 'Backend: listening on port 3005']);
  expect(mocks.warn).not.toHaveBeenCalled(); expect(process.exitCode).toBeUndefined();
});
it('warns for unavailable containers, hides provider details and continues to listen', async () => {
  const { app, storage } = fixture();
  storage.ensureReady.mockRejectedValueOnce(new Error('secret provider details'));
  await import('./main.js');
  expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('Materials container: access check failed'));
  expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('secret provider details');
  expect(mocks.log).toHaveBeenCalledWith('Avatars container: private access verified');
  expect(app.listen).toHaveBeenCalledOnce(); expect(app.close).not.toHaveBeenCalled();
});
it('does not start listening when MongoDB ping fails', async () => {
  const { app, database, storage } = fixture();
  database.db.command.mockRejectedValueOnce(new Error('private database connection details'));
  await import('./main.js');
  expect(app.listen).not.toHaveBeenCalled(); expect(storage.ensureReady).not.toHaveBeenCalled();
  expect(app.close).toHaveBeenCalledOnce(); expect(process.exitCode).toBe(1);
  expect(mocks.error).toHaveBeenCalledWith('MongoDB: connection check failed. Backend will not start.');
});
it('never reports listening after a bind failure', async () => {
  const { app } = fixture(); app.listen.mockRejectedValueOnce(new Error('address in use'));
  await import('./main.js');
  expect(mocks.log).not.toHaveBeenCalledWith(expect.stringContaining('Backend: listening'));
  expect(mocks.error).toHaveBeenCalledWith('Backend: could not start listening.');
  expect(app.close).toHaveBeenCalledOnce(); expect(process.exitCode).toBe(1);
});
