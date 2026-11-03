import 'reflect-metadata';
import 'dotenv/config';
import { Mongoose, Types } from 'mongoose';
import { ExtractionJobSchema } from '../src/model/extraction-job.schema.js';

describe.skipIf(process.env.IQLOCKER_MONGO_TEST !== '1')('Extraction job persistence (disposable collection)', () => {
    const database = new Mongoose();
    const collection = `iqlocker_phase15_test_${new Types.ObjectId()}_jobs`;
    const Job = database.model('ExtractionPersistenceTest', ExtractionJobSchema.clone(), collection);
    beforeAll(async () => {
        await database.connect(process.env.MONGO_URI ?? 'mongodb://localhost:27017/Stream', { serverSelectionTimeoutMS: 8000 });
        await Job.init();
    }, 20000);
    afterAll(async () => {
        try {
            if (database.connection.readyState === 1) {
                if (Job.collection.name !== collection) throw new Error('Invalid test collection');
                await Job.collection.drop();
            }
        } finally { await database.disconnect(); }
    });
    it('persists ownership and rejects duplicate jobs for the same material version', async () => {
        const fields = { owner: new Types.ObjectId(), course: new Types.ObjectId(), material: new Types.ObjectId(), materialVersion: 1 };
        const job = await Job.create(fields);
        await expect(Job.create(fields)).rejects.toMatchObject({ code: 11000 });
        const next = await Job.create({ ...fields, materialVersion: 2 });
        const stored = await Job.findById(job._id).lean();
        expect(stored?.owner.toString()).toBe(fields.owner.toString());
        expect(stored?.state).toBe('queued');
        expect(next.materialVersion).toBe(2);
        expect(await Job.countDocuments({ material: fields.material })).toBe(2);
    });
});
