import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLocalProject,
  listLocalProjects,
  LocalProjectConflict,
  renameLocalProject,
  writeLocalProject,
} from '../services/localProjects';
import type { VlxPayload } from '../utils/vlxFile';

const { records, blocked } = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  blocked: new Set<string>(),
}));

vi.mock('idb-keyval', () => ({
  createStore: (name: string) => name,
  entries: async () => [...records.entries()],
  get: async (id: string, store: string) => {
    if (blocked.has(store)) throw new DOMException('Storage is blocked', 'SecurityError');
    return records.get(id);
  },
  update: async (id: string, change: (value: unknown) => unknown, store: string) => {
    if (blocked.has(store)) throw new DOMException('Storage is blocked', 'SecurityError');
    records.set(id, change(records.get(id)));
  },
}));

function project(id: string, name: string, revision: number, updatedAt: number) {
  return { id, name, revision, updatedAt, payload: { name, boards: [] } as unknown as VlxPayload };
}

beforeEach(() => {
  records.clear();
  blocked.clear();
});

describe('browser project metadata', () => {
  it('lists older cached projects by their last save and keeps their IDs', async () => {
    records.set('older-id', project('older-id', 'Original workspace', 3, 100));
    await writeLocalProject(project('other-id', 'Another workspace', 1, 200));

    expect(await listLocalProjects()).toEqual([
      { id: 'other-id', name: 'Another workspace', revision: 1, createdAt: 200, updatedAt: 200 },
      { id: 'older-id', name: 'Original workspace', revision: 3, createdAt: 100, updatedAt: 100 },
    ]);
    expect(await getLocalProject('missing-id')).toBeUndefined();

    await writeLocalProject(project('older-id', 'Original workspace', 4, 300));
    expect(await getLocalProject('older-id')).toMatchObject({ createdAt: 100, updatedAt: 300 });
  });

  it('renames an existing record without replacing its saved contents or UID', async () => {
    await writeLocalProject(project('id', 'Before', 1, 100));
    const renamed = await renameLocalProject('id', 1, 'After');

    expect(renamed).toMatchObject({
      id: 'id',
      name: 'After',
      revision: 2,
      createdAt: 100,
      payload: { name: 'After', boards: [] },
    });
    await expect(writeLocalProject(project('id', 'Before', 2, 200))).rejects.toBeInstanceOf(
      LocalProjectConflict,
    );
    expect((await getLocalProject('id'))?.name).toBe('After');
    await expect(renameLocalProject('missing', 1, 'Unknown')).rejects.toBeInstanceOf(
      LocalProjectConflict,
    );
  });
});
