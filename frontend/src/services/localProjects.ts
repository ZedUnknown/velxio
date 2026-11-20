import { createStore, entries, get, promisifyRequest, update } from 'idb-keyval';
import type { VlxPayload } from '../utils/vlxFile';

export interface LocalProjectDetails {
  id: string;
  name: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface LocalProject extends LocalProjectDetails {
  payload: VlxPayload;
}

type StoredProject = Omit<LocalProject, 'createdAt'> & {
  createdAt?: number;
};
type ProjectSave = Omit<LocalProject, 'createdAt'>;

const projects = createStore('velxio-projects', 'projects');

export class LocalProjectConflict extends Error {
  constructor() {
    super(
      'This project changed in another tab. Reopen it to load that version, or save a local copy to keep your edits.',
    );
  }
}

function withCreatedAt(project: StoredProject): LocalProject {
  return { ...project, createdAt: project.createdAt ?? project.updatedAt };
}

let lastBrowserProject: StoredProject | undefined;

export async function getLocalProject(id: string): Promise<LocalProject | undefined> {
  const project = await get<StoredProject>(id, projects);
  if (project) lastBrowserProject = project;
  return project && withCreatedAt(project);
}

export async function listLocalProjects(): Promise<LocalProjectDetails[]> {
  const records = await entries<string, StoredProject>(projects);
  return records
    .map(([, project]) => {
      const { id, name, revision, createdAt, updatedAt } = withCreatedAt(project);
      return { id, name, revision, createdAt, updatedAt };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function writeLocalProject(project: ProjectSave): Promise<void> {
  let committed: StoredProject | undefined;
  // Read and compare inside the same transaction as the write, so two tabs
  // starting from the same revision cannot both report a successful save.
  await update<StoredProject>(
    project.id,
    (previous) => {
      if ((previous?.revision ?? 0) !== project.revision - 1) throw new LocalProjectConflict();
      committed = {
        ...project,
        createdAt: previous ? withCreatedAt(previous).createdAt : project.updatedAt,
      };
      return committed;
    },
    projects,
  );
  lastBrowserProject = committed;
}

export async function renameLocalProject(
  id: string,
  revision: number,
  name: string,
): Promise<LocalProject> {
  let renamed: StoredProject | undefined;
  await update<StoredProject>(
    id,
    (previous) => {
      if (!previous || previous.revision !== revision) throw new LocalProjectConflict();
      renamed = {
        ...withCreatedAt(previous),
        name,
        revision: revision + 1,
        updatedAt: Date.now(),
        payload: { ...previous.payload, name },
      };
      return renamed;
    },
    projects,
  );
  lastBrowserProject = renamed;
  return withCreatedAt(renamed!);
}

export function deleteLocalProject(id: string, revision: number): Promise<void> {
  return projects('readwrite', (store) => new Promise<void>((resolve, reject) => {
    // Check the revision in the same transaction as the delete.
    const request = store.get(id);
    request.onsuccess = () => {
      const project: StoredProject | undefined = request.result;
      if (!project) return;
      if (project.revision !== revision) {
        reject(new LocalProjectConflict());
        return;
      }
      store.delete(id);
    };
    void promisifyRequest(store.transaction).then(() => {
      if (lastBrowserProject?.id === id) lastBrowserProject = undefined;
      resolve();
    }, reject);
  }));
}
