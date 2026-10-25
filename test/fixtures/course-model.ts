import { Types } from 'mongoose';

// In-memory repository with serialized, rollback-capable transactions. This
// exercises service behavior; it does not emulate MongoDB write-conflict retries.
export function courseModelFixture() {
  const stored = new Map<string, any>();
  const folders = new Map<string, any>();
  const equal = (a: any, b: any) => a == null && b == null || a?.toString() === b?.toString();
  const matches = (item: any, filter: any) => Object.entries(filter).every(([key, value]) => equal(item[key], value));
  const query = (run: () => any): any => ({
    exec: async () => run(), session() { return this; },
    sort(sort: any) { return query(() => { const items = run(); return Object.keys(sort)[0] === 'nameKey' ? items.sort((a: any, b: any) => a.nameKey.localeCompare(b.nameKey)) : items.reverse(); }); },
    then(resolve: any, reject: any) { return Promise.resolve().then(run).then(resolve, reject); },
  });
  let tail = Promise.resolve();
  const db = { transaction: async (work: any) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const coursesBefore = [...stored].map(([key, value]) => [key, { ...value }] as const);
    const foldersBefore = [...folders].map(([key, value]) => [key, { ...value }] as const);
    try { return await work({}); }
    catch (error) { stored.clear(); folders.clear(); coursesBefore.forEach(([k, v]) => stored.set(k, v)); foldersBefore.forEach(([k, v]) => folders.set(k, v)); throw error; }
    finally { release(); }
  } };
  function model(records: Map<string, any>, folder = false) {
    const unique = (item: any) => {
      if (!folder) return;
      const conflict = [...records.values()].some((other) => !equal(other._id, item._id) && equal(other.owner, item.owner) && equal(other.course, item.course) &&
        (equal(other.parent, item.parent) && other.nameKey === item.nameKey || item.starterKey && other.starterKey === item.starterKey));
      if (conflict) throw Object.assign(new Error('Duplicate key'), { code: 11000 });
    };
    return class FakeModel {
      static db = db;
      record: any;
      constructor(fields: any) { this.record = { ...fields, _id: new Types.ObjectId(), ...(folder ? { parent: fields.parent ?? null, materialType: fields.materialType ?? '' } : { code: fields.code ?? '', semester: fields.semester ?? '' }), createdAt: new Date(), updatedAt: new Date() }; }
      async save() { unique(this.record); records.set(this.record._id.toString(), this.record); return this.record; }
      static async create(items: any[]) { return Promise.all(items.map((item) => new this(item).save())); }
      static find(filter: any) { return query(() => [...records.values()].filter((item) => matches(item, filter))); }
      static findOne(filter: any) { return query(() => [...records.values()].find((item) => matches(item, filter)) ?? null); }
      static exists(filter: any) { return this.findOne(filter); }
      static findOneAndUpdate(filter: any, update: any) { return query(() => {
        const item = [...records.values()].find((record) => matches(record, filter));
        if (!item) return null;
        const next = { ...item, ...update.$set, updatedAt: new Date() };
        for (const [key, value] of Object.entries(update.$inc ?? {})) next[key] = (next[key] ?? 0) + (value as number);
        unique(next); Object.assign(item, next); return item;
      }); }
      static updateOne(filter: any, update: any) { return this.findOneAndUpdate(filter, update); }
      static deleteOne(filter: any) { return this.findOneAndDelete(filter); }
      static findOneAndDelete(filter: any) { return query(() => {
        const item = [...records.values()].find((record) => matches(record, filter));
        if (item) records.delete(item._id.toString()); return item ?? null;
      }); }
    };
  }
  return { CourseModel: model(stored), FolderModel: model(folders, true), stored, folders };
}
